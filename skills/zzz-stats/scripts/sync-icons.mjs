#!/usr/bin/env node
/**
 * 图标自动同步：新角色/音擎/邦布不用手动找图。
 *
 * 为什么需要这一步：接口给的每条金记录都带 `icon` URL，新角色一上线，
 * 缓存里就没有它的图，报表只能退回 `_fallback.png` 占位——
 * 图上出现一个灰方块，用户会以为报表坏了。
 *
 * 现在做的事（一步到位，没有第二道工序）：
 *   1) 扫数据集里所有 `cur_records` / `cur_item_list`，收集 item_id 与 icon URL；
 *   2) 缺哪个就下载哪个，直接裁成 **64px** 写进 skill 的图标缓存：
 *        - 头像 → `assets/report/icons/avatars/`（圆形透明蒙版）
 *        - 物品 → `assets/report/icons/items/`（方形）
 *   3) 下载失败的列表会打印出来，构建时会用占位图兜底，不会裂图。
 *
 * 为什么只留 64px 一套：报表里图标最大显示 26 CSS px（详情行），
 * 主图柱顶头像是 22px。DPR2 需要 52px，64px 够用；DPR3 下详情图标会略虚，
 * 这是用户确认接受的代价。96px 那套本来就只是中间产物，不是原始资产。
 *
 * 用法：
 *   node skills/zzz-stats/scripts/sync-icons.mjs                    # 补缺失图标
 *   node skills/zzz-stats/scripts/sync-icons.mjs --check            # 只检查不下载（CI / 自检用）
 *   node skills/zzz-stats/scripts/sync-icons.mjs --data fixtures --concurrency 4
 *   node skills/zzz-stats/scripts/sync-icons.mjs --cwd /path/to/project
 *
 * 依赖：Pillow（`python3 -m pip install pillow`）。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { wantsHelp, printHelp, WORK_DIR_NOTE } from './cli-help.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/*
 * 两个根目录：
 *   SKILL_DIR：skill 本体，图标缓存写这里（`assets/report/icons/`，随 skill 发布）
 *   WORK_DIR：用户工作目录，`--cwd` 优先，否则 `process.cwd()`；数据集从这里读
 */
if (wantsHelp()) {
  printHelp('sync-icons', {
    summary: '按数据集里的 icon URL 补齐缺失图标，下载即裁 64px',
    options: [
      { flag: '--check', desc: '只检查不下载（CI / 自检用），有缺图退出 1' },
      { flag: '--data <dir>', desc: '数据集目录或父目录。不传时只看 data/ 下的数据集' },
      { flag: '--concurrency <n>', desc: '并发下载数，默认 4（上限 8）' },
      { flag: '--cwd <dir>', desc: '用户工作目录，默认当前目录' },
      { flag: '--help, -h', desc: '打印本帮助后退出，不下载、不写文件' },
    ],
    notes: [
      WORK_DIR_NOTE,
      '图标写进 skill 的 assets/report/icons/（随 skill 发布），这是本脚本唯一写 skill 目录的地方。',
      '需要 Pillow：python3 -m pip install pillow',
      '开发本仓库时用 --data fixtures/tianzhu（fixtures/ 不进运行期兜底）。',
    ],
  });
}

const SKILL_DIR = resolve(HERE, '..');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3) || fallback;
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const WORK_DIR = resolve(argOf('cwd', process.cwd()));
/*
 * 数据集目录：跟 build-report.mjs 同一套规则——**兜底只看 `data/`**，不看 `fixtures/`。
 * 这里传的是「数据集父目录」或「单个数据集目录」都行——父目录下会扫所有子目录。
 */
const ICONS_DIR = join(SKILL_DIR, 'assets/report/icons');
const CHECK_ONLY = args.includes('--check');
const CONCURRENCY = Math.max(1, Math.min(8, Number(argOf('concurrency', '4')) || 4));
/** 只留 64px 一套。报表最大显示 26 CSS px，DPR2 需要 52px。 */
const SIZE = 64;

const log = (...a) => console.log('[icons]', ...a);

/**
 * 解析数据集目录。给的是父目录时，把带 `index.json` 的子目录都收进来；
 * 给的就是单个数据集目录时，只有它自己。
 */
function resolveDataDirs() {
  const explicit = argOf('data', null);
  if (explicit) {
    const dir = resolve(WORK_DIR, explicit);
    if (!existsSync(dir)) {
      console.error(`找不到 ${dir}，先跑采集。`);
      process.exit(1);
    }
    // 单个数据集目录：自己就带 index.json
    if (existsSync(join(dir, 'index.json'))) return [dir];
    // 父目录：收所有带 index.json 的子目录
    const subs = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name))
      .filter((p) => existsSync(join(p, 'index.json')));
    if (subs.length) return subs;
    return [dir];
  }
  /*
   * 兜底**只看 `data/`**，不要扩大到 `fixtures/`。
   * `fixtures/` 是本仓库开发期的概念，用户项目里这名字很常见（前端尤其）；
   * 算进来就会去读别人项目里的测试数据。本仓库开发时用 `--data fixtures/tianzhu` 显式指定。
   */
  const base = resolve(WORK_DIR, 'data');
  if (existsSync(base)) {
    const subs = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(base, d.name))
      .filter((p) => existsSync(join(p, 'index.json')));
    if (subs.length) return subs;
  }
  console.error(`在 ${WORK_DIR}/data/ 下没找到数据集，先跑采集。`);
  console.error('  → 开发本仓库时用 --data fixtures/tianzhu 显式指定。');
  process.exit(1);
}

// ------------------------------------------------------------ 收集需要的图标

/** 从所有池子里收集 item_id → { name, itemType, url }。后面出现的覆盖前面的（URL 一般不变）。 */
function collectNeeded(dataDirs) {
  const needed = new Map();
  for (const dir of dataDirs) {
    const files = readdirSync(dir).filter((f) => /^(cur|hist)_pool_stat_\d+\.json$/.test(f));
    for (const file of files) {
      const body = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      for (const pool of body?.data?.list ?? []) {
        // cur_records 是已出的金；cur_item_list 是本期 UP（可能一金都还没出，但报表也要图）
        for (const rec of [...(pool.cur_records ?? []), ...(pool.cur_item_list ?? [])]) {
          const id = String(rec.item_id ?? '');
          if (!id || !rec.icon) continue;
          needed.set(id, {
            name: rec.name ?? id,
            itemType: rec.item_type ?? '',
            url: rec.icon,
            rarity: rec.rarity ?? '',
          });
        }
      }
    }
  }
  return needed;
}

/** 判断缺图：条目图与头像图分别检查，都指向 64px 那唯一一套。 */
function missingOf(needed) {
  const missing = [];
  for (const [id, info] of needed) {
    const isAvatar = info.itemType === 'ItemType_Avatar';
    const itemFile = join(ICONS_DIR, 'items', `${id}.png`);
    // 头像只给代理人做；音擎/邦布用方形 item 图，没有圆形头像
    const avatarFile = join(ICONS_DIR, 'avatars', `${id}.png`);
    const needItem = !existsSync(itemFile);
    const needAvatar = isAvatar && !existsSync(avatarFile);
    if (needItem || needAvatar) missing.push({ id, ...info, needItem, needAvatar });
  }
  return missing;
}

// ------------------------------------------------------------------ 下载 + 裁切

/**
 * 下载并直接裁成 64px。
 *
 * 走 python3 + Pillow 而不是在 Node 里解 PNG：仓库里已经有 Pillow 依赖，再引一个图像库只会多一份要维护的东西。
 *
 * 裁切规则：
 *   - 物品：取短边居中方块，再 LANCZOS 缩到 64。
 *   - 头像：同一个方形裁切后缩到 64，再套圆形透明蒙版
 *     （`size*4` 画椭圆再 LANCZOS 缩到 64，避免边缘锯齿）。
 *     头像原图是竖长的半身像（实测 152×186），方形裁切后正好是脸和肩，
 *     不裁直接拉伸会把人物拉成宽脸。
 */
const ITEM_PY = `
from PIL import Image
import sys
src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert('RGBA')
w, h = im.size
side = min(w, h)
left = (w - side) // 2
top = (h - side) // 2
im = im.crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS)
im.save(dst, 'PNG', optimize=True)
`;

const AVATAR_PY = `
from PIL import Image, ImageDraw
import sys
src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert('RGBA')
w, h = im.size
side = min(w, h)
left = (w - side) // 2
top = (h - side) // 2
im = im.crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS)
mask = Image.new('L', (size * 4, size * 4), 0)
ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
mask = mask.resize((size, size), Image.LANCZOS)
canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
canvas.paste(im, (0, 0), mask)
canvas.save(dst, 'PNG', optimize=True)
`;

async function downloadOne(entry) {
  const res = await fetch(entry.url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = join(tmpdir(), `zzz-icon-${entry.id}-${Date.now()}.png`);
  mkdirSync(join(ICONS_DIR, 'items'), { recursive: true });
  mkdirSync(join(ICONS_DIR, 'avatars'), { recursive: true });
  writeFileSync(tmp, buf);

  const jobs = [];
  if (entry.needItem) {
    jobs.push([ITEM_PY, join(ICONS_DIR, 'items', `${entry.id}.png`)]);
  }
  if (entry.needAvatar) {
    jobs.push([AVATAR_PY, join(ICONS_DIR, 'avatars', `${entry.id}.png`)]);
  }
  try {
    for (const [py, dst] of jobs) {
      execFileSync('python3', ['-c', py, tmp, dst, String(SIZE)], { stdio: 'pipe' });
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return jobs.length;
}

// ---------------------------------------------------------------------- 主流程

const dataDirs = resolveDataDirs();
const needed = collectNeeded(dataDirs);
const missing = missingOf(needed);

log(`数据集 ${dataDirs.length} 份，出现 ${needed.size} 个物品，缺图 ${missing.length} 个`);
if (missing.length) {
  for (const m of missing) log(`  · ${m.id} ${m.name}${m.needAvatar ? '（含头像）' : ''}`);
}
if (CHECK_ONLY) {
  if (missing.length) {
    log('--check：有缺图。跑 `node skills/zzz-stats/scripts/sync-icons.mjs` 补齐。');
    process.exit(1);
  }
  log('--check：图标齐全 ✓');
  process.exit(0);
}
if (!missing.length) {
  log('图标齐全，无需同步 ✓');
  process.exit(0);
}

let ok = 0;
const failed = [];
for (let i = 0; i < missing.length; i += CONCURRENCY) {
  const batch = missing.slice(i, i + CONCURRENCY);
  const results = await Promise.allSettled(batch.map((m) => downloadOne(m)));
  results.forEach((r, k) => {
    const m = batch[k];
    if (r.status === 'fulfilled') {
      ok += 1;
      log(`  ✓ ${m.id} ${m.name}`);
    } else {
      failed.push({ ...m, error: r.reason?.message ?? String(r.reason) });
      log(`  ✗ ${m.id} ${m.name}：${r.reason?.message ?? r.reason}`);
    }
  });
}

log(`下载完成：成功 ${ok} / 失败 ${failed.length}`);
if (failed.length) {
  log('失败的会在报表里用占位图兜底，不会裂图。稍后可重跑本脚本补齐。');
}
// 下载即 64px，没有第二道压缩工序 —— 也就不需要再调 make-icons。
