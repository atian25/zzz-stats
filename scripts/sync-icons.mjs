#!/usr/bin/env node
/**
 * 图标自动同步：新角色/音擎/邦布不用手动找图。
 *
 * 为什么需要这一步：接口给的每条金记录都带 `icon` URL，新角色一上线，
 * 旧的 assets/ 里就没有它的图，报表只能退回 `_fallback.png` 占位——
 * 图上出现一个灰方块，用户会以为报表坏了。
 *
 * 现在做的事：
 *   1) 扫 data/ 里所有 `cur_records` / `cur_item_list`，收集 item_id 与 icon URL；
 *   2) assets/ 里缺哪个就下载哪个，居中裁成方形并缩到 96px（与既有缓存一致）；
 *   3) 有新增时自动重跑 make-icons，生成 64px 版（报表内嵌用）；
 *   4) 下载失败的列表会打印出来，构建时会用占位图兜底，不会裂图。
 *
 * 用法：
 *   node scripts/sync-icons.mjs            # 补缺失图标 + 刷新 64px 缓存
 *   node scripts/sync-icons.mjs --check    # 只检查不下载（CI / 自检用）
 *   node scripts/sync-icons.mjs --data data --concurrency 4
 *
 * 依赖：Pillow（`python3 -m pip install pillow`），与 make-icons.mjs 相同。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3) || fallback;
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DATA_DIR = resolve(ROOT, argOf('data', 'data'));
const CHECK_ONLY = args.includes('--check');
const CONCURRENCY = Math.max(1, Math.min(8, Number(argOf('concurrency', '4')) || 4));
const SIZE = 96;

const log = (...a) => console.log('[icons]', ...a);

// ------------------------------------------------------------ 收集需要的图标

/** 从所有池子里收集 item_id → { name, itemType, url }。后面出现的覆盖前面的（URL 一般不变）。 */
function collectNeeded() {
  const needed = new Map();
  if (!existsSync(DATA_DIR)) {
    console.error(`找不到 ${DATA_DIR}，先跑采集。`);
    process.exit(1);
  }
  const files = readdirSync(DATA_DIR).filter((f) => /^(cur|hist)_pool_stat_\d+\.json$/.test(f));
  for (const file of files) {
    const body = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'));
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
  return needed;
}

/** 判断缺图：条目图与头像图分别检查。 */
function missingOf(needed) {
  const missing = [];
  for (const [id, info] of needed) {
    const isAvatar = info.itemType === 'ItemType_Avatar';
    const itemFile = join(ROOT, 'assets/items', `${id}.png`);
    // 头像只给代理人做；音擎/邦布用方形 item 图，没有圆形头像
    const avatarFile = join(ROOT, 'assets/avatars', `${id}.png`);
    const needItem = !existsSync(itemFile);
    const needAvatar = isAvatar && !existsSync(avatarFile);
    if (needItem || needAvatar) missing.push({ id, ...info, needItem, needAvatar });
  }
  return missing;
}

// ------------------------------------------------------------------ 下载 + 裁切

/**
 * 下载并裁成 96px 方形。
 *
 * 走 python3 + Pillow 而不是在 Node 里解 PNG：仓库里已经有 Pillow 依赖
 * （make-icons.mjs 就用它），再引一个图像库只会多一份要维护的东西。
 *
 * 裁切规则与既有缓存一致：取短边居中方块，再 LANCZOS 缩到 96。
 * 头像原图是竖长的半身像（实测 152×186），方形裁切后正好是脸和肩，
 * 不裁直接拉伸会把人物拉成宽脸。
 */
const CROP_PY = `
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

async function downloadOne(entry) {
  const res = await fetch(entry.url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = join(tmpdir(), `zzz-icon-${entry.id}-${Date.now()}.png`);
  mkdirSync(join(ROOT, 'assets/items'), { recursive: true });
  mkdirSync(join(ROOT, 'assets/avatars'), { recursive: true });
  writeFileSync(tmp, buf);

  const targets = [];
  if (entry.needItem) targets.push(join(ROOT, 'assets/items', `${entry.id}.png`));
  if (entry.needAvatar) targets.push(join(ROOT, 'assets/avatars', `${entry.id}.png`));
  for (const dst of targets) {
    execFileSync('python3', ['-c', CROP_PY, tmp, dst, String(SIZE)], { stdio: 'pipe' });
  }
  rmSync(tmp, { force: true });
  return targets.length;
}

// ---------------------------------------------------------------------- 主流程

const needed = collectNeeded();
const missing = missingOf(needed);

log(`数据里出现 ${needed.size} 个物品，缺图 ${missing.length} 个`);
if (missing.length) {
  for (const m of missing) log(`  · ${m.id} ${m.name}${m.needAvatar ? '（含头像）' : ''}`);
}
if (CHECK_ONLY) {
  if (missing.length) {
    log('--check：有缺图。跑 `node scripts/sync-icons.mjs` 补齐。');
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

/*
 * 有新图就必须重跑一次 64px 压缩。
 * 报表内嵌用的是 assets/report/icons/ 下的版本，不重跑的话新角色在图上仍是占位图
 * —— 看着像「自动同步没生效」，其实是第二道工序没走。
 */
if (ok > 0) {
  try {
    execFileSync('node', [join(HERE, 'make-icons.mjs')], { stdio: 'inherit', cwd: ROOT });
  } catch (e) {
    console.error('64px 压缩失败，报表会退回 96px 原图（体积变大但能看）。');
    console.error(e.message);
    process.exitCode = 1;
  }
}
