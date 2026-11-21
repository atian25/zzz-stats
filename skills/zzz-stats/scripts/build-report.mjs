#!/usr/bin/env node
/**
 * zzz-stats 报表构建器
 *
 * 输入（全部来自 skill 的采集步骤，原样保存的官方响应）：
 *   data/index.json
 *   data/cur_pool_stat_<t>.json
 *   data/hist_pool_stat_<t>.json
 *   data/meta.json（可选，补昵称/采集时间）
 * 配置：config/report.json
 * 输出：output/<账号名>/report.html（单文件，内联数据和 ECharts，图片 base64 内嵌）
 *
 * 这份脚本是「口径的唯一实现」。文档只描述结果，不再重复算法。
 * 用法：node skills/zzz-stats/scripts/build-report.mjs [--data output/<账号>/data] [--out report.html]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wantsHelp, printHelp, WORK_DIR_NOTE } from './cli-help.mjs';
import { outputRoot, listOutputDatasets, sanitizeSegment } from './datasets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/*
 * 两个根目录，**不要合并回一个**。
 *
 * SKILL_DIR：skill 本体（`skills/zzz-stats/`），随 skill 发布、只读。
 *   config/report.json、assets/**（模板、charts、图标、echarts）都从这里读。
 *
 * WORK_DIR：用户的工作目录，`data/`、`output/`、`docs/` 全落这里。
 *   `--cwd` 显式指定优先，否则就是 `process.cwd()`。
 *
 * 为什么必须分开：旧实现用 `resolve(HERE, '..')` 把两者当成同一个，
 * skill 装到 `.agents/skills/zzz-stats` 后跑构建，产物会写进 skill 自己的目录
 * —— 既会被 skill 升级覆盖，含 UID 的 `data/` 也会绕过 `.gitignore` 的根锚定规则，
 * 变成可提交状态。
 */
if (wantsHelp()) {
  printHelp('build-report', {
    summary: '把采集到的数据集构建成单文件 HTML 报表',
    options: [
      { flag: '--data <dir>', desc: '数据集目录。不传时只看 output/<账号名>/data/，恰好一份就用；多份会报错退出' },
      { flag: '--out <file>', desc: '产物路径，默认 output/<账号名>/report.html（账号名取自数据集路径或 meta 的昵称）' },
      { flag: '--cwd <dir>', desc: '用户工作目录，默认当前目录；output/ 相对它算' },
      { flag: '--help, -h', desc: '打印本帮助后退出，不读数据、不写文件' },
    ],
    notes: [
      WORK_DIR_NOTE,
      '--data 认任意相对/绝对路径：开发本仓库时用 --data fixtures/tianzhu（fixtures/ 不进运行期兜底），',
      '这时产物仍落到 output/<昵称>/report.html，不会往 fixtures 目录里写。',
    ],
  });
}

const SKILL_DIR = resolve(HERE, '..');
const args = process.argv.slice(2);
/*
 * 读命令行参数。两种写法都支持：
 *   --out output/report.html    （空格分隔）
 *   --out=output/report.html    （等号）
 * 只认空格形式时，传 --out=... 会被静默忽略、悄悄用默认值 ——
 * 这类「没报错但没生效」的坑在 collect.mjs 里已经踩过一次，这里同样要防。
 */
const argOf = (name, fallback) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3) || fallback;
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
/*
 * 用户工作目录：`--cwd` 优先，否则就是当前目录。
 * 数据、产物、截图都相对它算，**不是**相对 skill 目录。
 */
const WORK_DIR = resolve(argOf('cwd', process.cwd()));
/*
 * 数据集目录。
 *
 * 运行期结构是 `output/<账号名>/data/`，一个账号一个目录，用户拿走
 * `output/<账号名>/` 这一个目录就能部署（data/ + report.html 在一起）。
 *
 * 没传 `--data` 时的兜底：**只看 `output/<账号名>/data/index.json`**。
 * 恰好只有一份就直接用；有多份**报错退出，不猜**。猜错不会报错——报表照样生成，
 * 只是数字属于另一个账号，这种「看起来成功了但内容是错的」比直接失败难发现得多。
 *
 * **不要把这个兜底扩大到 `data/`（旧结构）或 `fixtures/`（开发期概念）。**
 * 每扩大一处就多一种「读到别人数据、却生成一份看着正常的报表」的可能：
 * 用户项目里 `data/` 和 `fixtures/` 都极常见。本仓库开发时用 `--data fixtures/tianzhu`
 * 显式指定，那条路不受兜底影响。
 */
function pickDataDir() {
  const explicit = argOf('data', null);
  if (explicit) return resolve(WORK_DIR, explicit);
  const found = listOutputDatasets(WORK_DIR);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    console.error(`output/ 下有 ${found.length} 份数据集，用 --data 指定要哪一份：`);
    for (const p of found) console.error(`  node skills/zzz-stats/scripts/build-report.mjs --data ${relative(WORK_DIR, p)}`);
    process.exit(1);
  }
  console.error(`找不到数据集：${outputRoot(WORK_DIR)}/<账号名>/data/index.json 一个都没有。`);
  console.error('  → 先跑采集（数据会落到 output/<账号名>/data/），或用 --data 指定数据集目录');
  console.error('    （开发本仓库时用 --data fixtures/tianzhu）。');
  process.exit(1);
}
const DATA_DIR = pickDataDir();
/*
 * 产物路径：默认 `<数据集目录的上一级>/report.html`。
 *
 * 对运行期结构 `output/<账号名>/data/` 来说，这就是 `output/<账号名>/report.html`
 * —— 数据和报表在同一个账号目录里，用户拷走一个目录就完整了。
 *
 * **为什么不再用 `output/report-<数据集名>.html`：** 那个结构下数据和报表分家，
 * 用户要「部署」就得自己判断哪些文件配哪份报表。现在名字跟着账号目录走，天然配对。
 *
 * 显式 `--data fixtures/tianzhu` 时，上一级是 `fixtures/`，**不能往那儿写**
 * （开发期数据目录里出现产物，会被 .gitignore 之外的眼睛当成入库内容）。
 * 所以这种情况改用该数据集 `meta.json` 的昵称，落到 `output/<昵称>/report.html`；
 * 昵称拿不到就退到数据集目录名。
 *
 * `--out` 显式指定永远覆盖上面的一切。
 */
function reportDatasetName() {
  // 已经在 output/<账号>/data/ 结构里 → 直接沿用账号目录名，不需要猜
  if (basename(dirname(DATA_DIR)) !== 'data') return null;
  const accountDir = dirname(DATA_DIR);
  if (dirname(accountDir) !== outputRoot(WORK_DIR)) return null;
  return basename(accountDir);
}
function deriveOutFile() {
  const explicitOut = argOf('out', null);
  if (explicitOut) return resolve(WORK_DIR, explicitOut);
  const inOutput = reportDatasetName();
  if (inOutput) return join(outputRoot(WORK_DIR), inOutput, 'report.html');
  /*
   * 外部数据集（`--data fixtures/xxx` 或任意路径）：产物仍落 `output/<name>/report.html`。
   * name 取该数据集 meta.json 的昵称（安全化后），拿不到就用目录名——两者都可能为空，
   * 那就退到 `dataset`，绝不允许删成 `output//report.html` 或写到 `output/` 外面。
   */
  const rawMeta = join(DATA_DIR, 'meta.json');
  let nickname = null;
  try {
    if (existsSync(rawMeta)) nickname = JSON.parse(readFileSync(rawMeta, 'utf8'))?.nickname ?? null;
  } catch { /* meta 坏了不该影响出图，退回目录名 */ }
  const name = sanitizeSegment(nickname) || sanitizeSegment(basename(DATA_DIR)) || 'dataset';
  return join(outputRoot(WORK_DIR), name, 'report.html');
}
const OUT_FILE = deriveOutFile();

const CFG = JSON.parse(readFileSync(join(SKILL_DIR, 'config/report.json'), 'utf8'));

/*
 * region → 区服名。
 *
 * 报表次行原来写死「国服」，国际服账号会显示成国服，属于直接错。
 * 映射来自 SKILL.md §2 的对照表（prod_gf_cn / jp / us / eu / sg）；
 * 认不出的 region 原样显示，不猜。
 */
const SERVER_LABELS = {
  prod_gf_cn: '国服',
  prod_gf_jp: '日服',
  prod_gf_us: '美服',
  prod_gf_eu: '欧服',
  prod_gf_sg: '亚服',
};

// ---------------------------------------------------------------- 读取原始数据

function readJson(file) {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8');
  const body = JSON.parse(raw);
  if (body && body.retcode !== undefined && body.retcode !== 0) {
    throw new Error(`${file}: retcode=${body.retcode} ${body.message || ''}`);
  }
  return body?.data ?? body;
}

const index = readJson(join(DATA_DIR, 'index.json'));
if (!index) {
  console.error(`找不到 ${join(DATA_DIR, 'index.json')}。先跑采集步骤（数据落到 output/<账号名>/data/），或用 --data 指定数据集目录。`);
  process.exit(1);
}
const meta = readJson(join(DATA_DIR, 'meta.json')) || {};

/** 一个频道的全部金，按 sort 升序。sort 是频道内跨池连续的全局序号。 */
function loadGolds(channel) {
  const golds = [];
  for (const prefix of ['hist_pool_stat', 'cur_pool_stat']) {
    const body = readJson(join(DATA_DIR, `${prefix}_${channel.id}.json`));
    for (const pool of body?.list ?? []) {
      for (const rec of pool.cur_records ?? []) {
        golds.push({
          sort: Number(rec.sort),
          count: Number(rec.count),
          recordTime: Number(rec.record_time),
          itemId: String(rec.item_id),
          name: rec.name,
          itemType: rec.item_type,
          isUp: rec.is_up === true,
          upTag: rec.up_tag,
          version: pool.version ?? null,
          rarity: rec.rarity,
        });
      }
    }
  }
  golds.sort((a, b) => a.sort - b.sort);
  return golds;
}

// ---------------------------------------------------------------- 口径计算

const statsOf = (enumName) => (index.type_stats ?? []).find((t) => t.gacha_type === enumName) ?? null;
const num = (v) => (v == null || v === '' ? null : Number(v));

/** 同一发十连：同秒 且 sort 差 ≤ N。 */
const sameTenPull = (a, b) => a.recordTime === b.recordTime && b.sort - a.sort <= CFG.numbers.multiGoldSortGap;

/**
 * 把一个频道的金序列折成「UP 轮」。
 *
 * 规则来自 references/report-rules.md §1：
 *  - 一轮从上一个 UP 结束后开始，`off` 累计期间所有非 UP 金的抽数；
 *  - UP 金自己的 count 是距上一金的抽数，记作 `up`；
 *  - 十连里排在 UP 之后的非 UP 金（副金）并回这一轮，总抽 +它的 count，仍算直出。
 *
 * 这样 total 之和恒等于该频道官方 gacha_count，可以直接校验。
 */
function buildRounds(golds) {
  const rounds = [];
  // losts 必须带身份（itemId/name）：柱顶上要给歪出的角色画头像，tip 里也要写名字。
  // 只累加 off 的数字会把「歪了谁」丢掉。
  let losts = [];
  const off = () => losts.reduce((s, x) => s + x.count, 0);
  let i = 0;
  while (i < golds.length) {
    const g = golds[i];
    if (!g.isUp) {
      losts.push({ name: g.name, itemId: g.itemId, count: g.count, sort: g.sort });
      i += 1;
      continue;
    }
    const round = {
      version: g.version,
      name: g.name,
      itemId: g.itemId,
      recordTime: g.recordTime,
      sort: g.sort,
      off: off(),
      lossNames: losts.map((x) => x.name).join('、'),
      losts: [...losts],
      up: g.count,
      total: off() + g.count,
      side: [],
    };
    // 十连副金：紧跟在 UP 之后、同秒且 sort 差 ≤ N 的非 UP 金
    let j = i + 1;
    while (j < golds.length && sameTenPull(golds[j - 1], golds[j]) && !golds[j].isUp) {
      round.side.push({ name: golds[j].name, itemId: golds[j].itemId, count: golds[j].count, sort: golds[j].sort });
      round.total += golds[j].count;
      j += 1;
    }
    rounds.push(round);
    losts = [];
    i = j;
  }
  return rounds;
}

/** 一轮是否「保底获得」：上一轮末尾带出了非 UP 副金，说明 50/50 已经歪掉。 */
function markGuaranteed(rounds) {
  rounds.forEach((r, k) => {
    r.direct = r.off === 0;
    r.guar = k > 0 && rounds[k - 1].side.length > 0;
    r.guarFrom = r.guar ? rounds[k - 1].side.map((s) => s.name).join('、') : null;
  });
  return rounds;
}

/** 逐轮胜负：直出且不是保底获得才算胜场。口径见 references/report-rules.md §1。 */
function winBits(rounds) {
  return rounds.map((r) => (r.direct && !r.guar ? 1 : 0));
}

/** 累计不歪率：直出且不是保底获得才算胜场。 */
function cumulativeWinRate(rounds) {
  return cumulativeOfBits(winBits(rounds));
}

/** 累计胜率（入参是 0/1 序列）：第 i 项＝前 i+1 轮的胜率。 */
function cumulativeOfBits(bits) {
  let wins = 0;
  return bits.map((b, i) => {
    wins += b;
    return Math.round((wins / (i + 1)) * 1000) / 10;
  });
}

/** 滑动窗口胜率：第 i 项＝以 i 结尾的最近 `window` 轮的胜率。
 *  不足 `window` 轮的头部也要返回（用已有的几轮算），但形状计算会跳过这些不完整窗口。 */
function rollingWinRate(bits, window) {
  return bits.map((_, i) => {
    const a = Math.max(0, i - window + 1);
    const seg = bits.slice(a, i + 1);
    return Math.round((seg.reduce((s, x) => s + x, 0) / seg.length) * 1000) / 10;
  });
}

/**
 * 累计不歪率的「轨迹形状」：谷底、涨幅、非↔欧横跳次数。
 *
 * **为什么不能只看终值**：累计曲线会收敛到终值附近，终值只差 8 个百分点的两个号，
 * 走法可以完全相反——实测天猪号从 14.3% 一路爬到 48.1%（爬出来的），
 * joker 号则在 70% 和 20% 之间来回起伏（跳出来的）。终值读不出这件事。
 *
 * **横跳的分界线不是 50%**。50% 是「小欧」和「大欧」的分界，两边都是欧，
 * 在 50% 上下浮动不代表横跳。真正的横跳是**在非酋和欧之间来回**：
 * `nonEdge`（非酋档上界）以下算非、`euroEdge`（50/50 理论期望）以上算欧，
 * 中间的「薛定谔」带两边都不算——它本来就是「还看不出来」的地带，在里面游荡不算横跳。
 *
 * **横跳必须看滑动窗口，不能看累计值**。累计值是全程平均，早期的大坑会被越摊越淡：
 * joker 号的累计值从未跌破 35%（谷底 42.9%），但把窗口收到最近 10 轮，
 * 它的近期胜率一路从 70% 掉到 20% 再回到 80%——那是实实在在的「一会欧一会非」，
 * 只是在全程累计里被平均没了。所以 `flips` 在 `rollingWinRate()` 的序列上统计。
 *
 * `minSamples`：前几轮的累计值是噪音，不是这个人的水平。
 * 1 轮 0%、2 轮 50% 这种极值会把谷底拉到 0%，于是每个账号都能自称「曾是非酋」。
 * 默认从第 5 轮起算（实测天猪号前 3 轮都是 0%，排除后谷底落在第 7 轮的 14.3%）。
 */
function winRateShape(bits, opts = {}) {
  const nonEdge = opts.nonEdge ?? 35;
  const euroEdge = opts.euroEdge ?? 50;
  const minSamples = opts.minSamples ?? 5;
  const window = opts.window ?? 10;
  const from = Math.max(0, minSamples - 1);

  const cumulative = cumulativeOfBits(bits);
  const pts = cumulative.slice(from);
  if (pts.length < 2) return null;

  let ti = 0;
  for (let i = 1; i < pts.length; i += 1) if (pts[i] < pts[ti]) ti = i;
  const trough = pts[ti];
  /*
   * 最高点（峰值）。
   *
   * 「非酋翻身记」的 tip 原来只写「最低 X%，现在 Y%，涨了 Z 个百分点」——
   * 但涨幅是个派生量，读者真正想知道的是**这条曲线的三个关键时刻**：
   * 最低到过多少、最高到过多少、现在是多少。
   * 少了峰值，「涨了 45 个百分点」到底是从 14% 涨到 59%，还是从 20% 涨到 65%，
   * 读者还得自己拿最低值去反推，而此刻的值又可能不在峰值上。
   *
   * 和 trough 一样取 pts（跳过前 minSamples 轮噪音）里的极值，绝不拿全序列首个值冒充。
   * 峰谷各自保留下标，供上层映射成版本号。
   */
  let pi = 0;
  for (let i = 1; i < pts.length; i += 1) if (pts[i] > pts[pi]) pi = i;
  const peak = pts[pi];
  const final = pts[pts.length - 1];

  /*
   * 横跳：在「滑动窗口胜率」上数非↔欧的切换。窗口不满的头部不参与（样本不够，读数不可信）。
   *
   * **注意下标偏移**：`rollingWinRate()` 返回的数组与 `bits` 等长（按轮对齐），
   * 但这里遍历的是 `slice(window - 1)` 之后的**切片**，所以循环变量 `i` 是「切片的第几个」，
   * 不是「第几轮」。换算回轮索引必须 `i + (window - 1)`，否则会整体前移 9 轮：
   * 实测 joker 号用错偏移会算出 v1.1～v1.2、53 轮前，正确是 v1.2～v1.4、44 轮前。
   *
   * `flipIdxs` 存的是**轮索引（0 基，与 `charRounds` 对齐）**，供上层映射成版本号。
   */
  const rolling = rollingWinRate(bits, window).slice(window - 1);
  const roundOffset = window - 1;
  const flipIdxs = [];
  /*
   * `flipEvents` 记每一次横跳的**具体读数**，供标签 tip 逐条列出。
   *
   * 为什么不能只给总次数：用户看到「来回 2 次」还是不知道到底怎么跳的——
   * 是从 55% 掉到 30% 再弹回 52%（真横跳），还是 49%↔51%（几乎没动）？
   * 次数相同，含义完全不同。所以每次 flip 都带上轮次、方向和当时的窗口胜率。
   *
   * `winRate` 取的是**跳变发生那一轮的窗口值**（即跨过分界线后的新值），
   * `from` / `to` 是 ±1 的档位符号（-1 非酋、+1 欧）。
   */
  const flipEvents = [];
  let side = null;
  /*
   * `lastOf` 记「每个档位最后一次读到的窗口值」。
   *
   * 横跳的「变化」必须给出**两侧的读数**，只写跨过去之后的值看不出跳幅：
   * 「窗口 30%」不知道是从 55% 掉下来的，还是从 36% 蹭下来的。
   * 但也不能拿上一轮的值当起点——中间可能隔着几轮薛定谔带（35~50 不计数），
   * 上一轮的值未必属于同一个档。所以取「同档最后一次真实读数」，那是真值、可复核。
   */
  const lastOf = { '-1': null, '1': null };
  for (let i = 0; i < rolling.length; i += 1) {
    const s = rolling[i] < nonEdge ? -1 : rolling[i] >= euroEdge ? 1 : 0;
    if (!s) continue;
    if (side != null && s !== side) {
      const idx = i + roundOffset;
      flipIdxs.push(idx);
      flipEvents.push({ idx, winRate: rolling[i], prevWinRate: lastOf[String(side)], from: side, to: s, low: null });
    }
    side = s;
    lastOf[String(s)] = rolling[i];
  }
  /*
   * 每一段「掉进非酋档」里窗口最低到过多少。
   *
   * 这是横跳里最有信息量的那个数：joker 号的**累计**谷底是 42.9%（从没进过非酋档），
   * 但它的 10 轮窗口实打实掉到过 20%——只说「掉进非酋档」看不出掉得多深。
   *
   * 算法：对每个「进入非酋」的 flip，向后扫到下一次 flip（或序列结束），取这段的最小值。
   * 用 `rolling` 的**切片下标**（`idx - roundOffset`）回查，别直接拿轮索引去索引切片。
   */
  for (const ev of flipEvents) {
    if (ev.to !== -1) continue;
    const startSlice = ev.idx - roundOffset;
    const nextFlip = flipEvents.find((x) => x.idx > ev.idx);
    const endSlice = nextFlip ? nextFlip.idx - roundOffset - 1 : rolling.length - 1;
    let low = Infinity;
    for (let k = startSlice; k <= endSlice && k < rolling.length; k += 1) low = Math.min(low, rolling[k]);
    ev.low = Number.isFinite(low) ? low : null;
  }
  const flips = flipIdxs.length;
  const oscillated = flips >= (opts.oscillationFlips ?? 2);

  return {
    minSamples,
    window,
    nonEdge,
    euroEdge,
    trough,
    troughIdx: from + ti,
    troughVersion: null,
    peak,
    peakIdx: from + pi,
    peakVersion: null,
    final,
    rise: Math.round((final - trough) * 10) / 10,
    flips,
    flipIdxs,
    flipEvents,
    oscillated,
    rollingMin: rolling.length ? Math.min(...rolling) : null,
    rollingMax: rolling.length ? Math.max(...rolling) : null,
  };
}

/** 连续段统计：返回 [{k, start, end, chain}]，按长度降序。
 *  breakOnGuaranteed：保底获得（上一轮已经歪掉）不计入 50/50 连胜，必须打断。 */
/** 版本序号比较（"1.10" > "1.9"）。 */
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * 把一串版本号写成人类读法：
 *   同一版本        → `v2.0`
 *   连续区间        → `v1.0～1.1`（尾部省掉重复的 v）
 *   不连续多段      → `v1.0～1.1、v2.5`
 */
function versionRange(list) {
  const uniq = [...new Set(list)].sort(cmpVer);
  if (!uniq.length) return '';
  const runs = [];
  let cur = [uniq[0]];
  for (let i = 1; i < uniq.length; i += 1) {
    // 相邻（1.0 → 1.1 / 1.9 → 1.10 / 2.7 → 3.0）算连续
    const prev = cur[cur.length - 1].split('.').map(Number);
    const now = uniq[i].split('.').map(Number);
    const nextMajor = [...prev];
    nextMajor[1] = (prev[1] ?? 0) + 1;
    const isNext = nextMajor[0] === now[0] && nextMajor[1] === now[1];
    const isMajor = now[0] === prev[0] + 1 && (now[1] ?? 0) === 0;
    if (isNext || isMajor) cur.push(uniq[i]);
    else { runs.push(cur); cur = [uniq[i]]; }
  }
  runs.push(cur);

  return runs
    .map((run) => {
      if (run.length === 1) return `v${run[0]}`;
      const head = `v${run[0]}`;
      const tail = run[run.length - 1];
      // 完整写出尾版本（v2.1～2.3），不要缩成 v2.1～3 —— 会被误读成「到 v3」
      return `${head}～${tail}`;
    })
    .join('、');
}

function seriesOf(rounds, predicate, opts = {}) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push({
      k: run.length,
      start: run[0],
      end: run[run.length - 1],
      // 每一环带上歪出的角色：`青衣（猫又）`；没歪就只写名字
      chain: run
        .map((idx) => {
          const r = rounds[idx];
          const lost = (r.losts ?? []).map((x) => x.name).filter(Boolean).join('、');
          return lost ? `${r.name}（${lost}）` : r.name;
        })
        .join(' → '),
      // 区间写法：同版本 `v2.0`，跨版本 `v1.0～1.1`；片段连续时合并，否则用逗号
      versions: versionRange(run.map((idx) => rounds[idx].version)),
    });
    run = [];
  };
  rounds.forEach((r, idx) => {
    if (opts.breakOnGuaranteed && r.guar) {
      flush();
      return;
    }
    if (predicate(r)) run.push(idx);
    else flush();
  });
  flush();
  return out.sort((a, b) => b.k - a.k || a.start - b.start);
}

const roundsOf = (channel) => markGuaranteed(buildRounds(loadGolds(channel)));

/**
 * 十连多金组：同频道内，把同秒且 sort 差 ≤ N 的连续金归为一组。
 *
 * 一组未必是 2 金。实测样本里有 雅 79 抽 → 1 抽 → 5 抽（同一发十连出三金），
 * 音擎也有 啜泣摇篮 68 → 青溟笼舍 4 → 青溟笼舍 2。
 * 所以这里返回整组，由调用方按 `length` 分档统计双金 / 三金 / 四金——
 * 只按「双金」写死会把三金一起吞进双金的计数里，标签和图例都会说谎。
 */
function multiGoldGroups(golds) {
  const groups = [];
  let run = [];
  const flush = () => {
    if (run.length > 1) groups.push([...run]);
    run = [];
  };
  golds.forEach((g, idx) => {
    run.push(g);
    const next = golds[idx + 1];
    if (!next || !sameTenPull(g, next)) flush();
  });
  flush();
  return groups;
}

/**
 * 多金组按金数分档：`{2: 5, 3: 1}` 表示 5 组双金、1 组三金。
 *
 * 分档而不只给总数，是因为「十连双金 ×5」这句话在有三金的账号里是错的：
 * 读者会以为那 5 次都是两金，实际其中一次是三金。
 */
function multiGoldBySize(groups) {
  const out = new Map();
  for (const g of groups) out.set(g.length, (out.get(g.length) ?? 0) + 1);
  return out;
}

/** 版本号主版本："1.4" → "1"。版本过滤器按主版本分档（1.x / 2.x / 3.x）。 */
const majorOf = (version) => String(version ?? '').split('.')[0] || '';

// ---------------------------------------------------------------- 组装报表数据

const channelReports = CFG.channels.map((ch) => {
  const golds = loadGolds(ch);
  const rounds = ch.kind === 'permanent' || ch.kind === 'bangboo' ? markGuaranteed(buildRounds(golds)) : roundsOf(ch);
  const stats = statsOf(ch.enum);
  const officialPulls = num(stats?.total_count) ?? rounds.reduce((s, r) => s + r.total, 0);
  const pity = num(stats?.next_s_cur_times) ?? 0;
  /*
   * 扣垫抽后再算每金成本。
   *
   * 官方 total_count 含「已经抽掉、但还没出 S」的垫抽。把它摊进每个金里，
   * 等于把一个尚未结算的成本算进历史均值——官方自己的 avr_up_count 也是扣掉垫抽的
   * （常驻 650 抽 / 9 金 = 72.2，官方 65.8 = (650-58)/9；独家重映 90/1=90，官方 76 = (90-14)/1）。
   * 角色池这次垫抽恰好是 0，所以旧口径没露馅；换个号就会系统性偏非，称号也会跟着偏。
   */
  const effectivePulls = Math.max(0, officialPulls - pity);
  const perGold = golds.length ? effectivePulls / golds.length : null;
  return {
    ...ch,
    golds,
    rounds,
    officialPulls,
    effectivePulls,
    pity,
    pityCap: ch.pityCap ?? null,
    stats: stats
      ? {
          pulls: officialPulls,
          effectivePulls,
          pity,
          pityCap: ch.pityCap ?? null,
          sCount: num(stats.s_count),
          upCount: num(stats.up_count),
          upAvg: num(stats.avr_up_count),
          hasDataVers: stats.has_data_vers ?? [],
        }
      : null,
    perGold,
  };
});

const character = channelReports.find((c) => c.key === 'character_up');
// 音擎频段：十连多金要和角色池合并统计（见下面的 multiGold 注释）
const weapon = channelReports.find((c) => c.key === 'weapon_up');
const charRounds = character.rounds;
// 每 UP 均同样扣垫抽：分母是「已经结算的金」，垫着的抽数还没换来金，不该摊进去
const pullsPerUp = charRounds.length ? character.effectivePulls / charRounds.length : null;
const winRate = cumulativeWinRate(charRounds);
const finalWinRate = winRate.length ? winRate[winRate.length - 1] : null;

/*
 * 轨迹形状（谷底 / 涨幅 / 非↔欧横跳）—— 供「翻身的非酋」「薛定谔的非酋」两个标签使用。
 * 阈值全部来自 config.numbers.winRateShape，改配置就生效。
 */
const charBits = winBits(charRounds);
const winShape = winRateShape(charBits, CFG.numbers.winRateShape ?? {});
if (winShape) {
  winShape.troughVersion = charRounds[winShape.troughIdx]?.version ?? null;
  winShape.peakVersion = charRounds[winShape.peakIdx]?.version ?? null;
  /*
   * 当下所在的版本（最后一轮的版本），给「最高/最低/当下」三点并列时用。
   */
  winShape.finalVersion = charRounds[charRounds.length - 1]?.version ?? null;
  /*
   * 横跳发生的位置 → 版本号。
   *
   * 为什么需要：`flips` 数的是**整个序列**（从第 window 轮一直数到最后），
   * 不是「最近几轮」。所以这个标签说的是「**曾经**来回过」，是历史事件，不是当前状态。
   * 光写「近期胜率来回跳」会让一个 44 轮前就稳定下来的号看起来还在跳——
   * 所以文案必须带上「哪一版到哪一版之间」和「距今多少轮」，读者才知道这是旧事。
   *
   * 实测 joker 号：2 次 flip 落在第 20 轮（v1.2）和第 27 轮（v1.4），距今 44 轮；
   * 近 30 个窗口的 flips 早已是 0。
   */
  const idxs = winShape.flipIdxs ?? [];
  winShape.flipFromVersion = idxs.length ? charRounds[idxs[0]]?.version ?? null : null;
  winShape.flipToVersion = idxs.length ? charRounds[idxs[idxs.length - 1]]?.version ?? null : null;
  winShape.flipToAgo = idxs.length ? charBits.length - (idxs[idxs.length - 1] + 1) : null;

  /*
   * 每一次横跳的可读明细，逐行拼好供 tip 用。
   *
   * 用户要的是「具体的横跳变化」，不是「来回 2 次」这种汇总。
   * 每行都带齐四件事：哪一版 · 哪一轮 · 往哪个方向跳 · 跳到多少。
   * 掉进非酋档的那一条再补上「这段最低到多少」——只有这个数能说明「掉得多深」。
   *
   * 方向箭头故意用「欧 → 非」这种汉字而不是 ↗↘：报表整体是中文，
   * 箭头在等宽字体下宽度不稳，多行对齐会歪。
   */
  winShape.flipLines = (winShape.flipEvents ?? []).map((ev) => {
    const round = charRounds[ev.idx] ?? {};
    const ver = round.version ? `v${round.version}` : '—';
    const dir = ev.to === -1 ? '欧 → 非' : '非 → 欧';
    /*
     * 有起点就写成「55% → 30%」的变化，没有起点（同档第一次读数就已是这天）才退回单值。
     * 起点缺失只在序列极短时发生，正常账号不会有。
     */
    const move = ev.prevWinRate != null && ev.prevWinRate !== ev.winRate
      ? `${ev.prevWinRate}% → ${ev.winRate}%`
      : `${ev.winRate}%`;
    const low = ev.to === -1 && ev.low != null && ev.low < ev.winRate ? `，最低 ${ev.low}%` : '';
    /*
     * 必须写「近 N 轮不歪率」而不是「窗口」。
     *
     * 「窗口」是算法内部的说法（rollingWinRate 的窗口长度），读者看到「窗口 50% → 30%」
     * 根本不知道在量什么——是这个号的运气？是抽数？还是某个比例？
     * 补上「不歪率」才和报表其余部分（顶部 KPI、折线、右轴）用的是同一套词，
     * 补上「近 N 轮」才说明它和「累计不歪率」不是一回事——
     * 这两个数是不同的量：joker 累计谷底 42.9%，但近 10 轮能掉到 20%。
     * 只写「不歪率 20%」读者会拿它去和顶部的 56.3% 比，然后发现对不上。
     */
    const win = `近 ${winShape.window} 轮不歪率`;
    return `${ver} 第 ${ev.idx + 1} 轮 ${dir}：${win} ${move}${low}`;
  });
}

const extremeRounds = charRounds.filter((r) => r.total <= CFG.numbers.extremePulls);
/*
 * 十连多金：**角色池 + 音擎**一起算。
 *
 * 为什么要跨频道合并：早年只统计角色池，音擎的多金完全没进标签。
 * 实测 joker 号角色池 5 组多金、音擎另有一组三金 + 一组双金，
 * 只写角色池等于漏报一半——读者会以为音擎从没出过多金。
 *
 * 合并前**必须按频道分段**再各自成组：
 * `sameTenPull` 比的是「同秒 + sort 差 ≤ N」，而 sort 是每个频道各自从 1 开始数的。
 * 不同频道的两个金如果 sort 恰好接近、recordTime 又落在同一秒，会被误判成同一发十连；
 * 这种错误不会报错，只会凭空多出一组多金。
 * 所以这里不是一个扁平数组，而是「按频道分段的数组」，
 * 段内才做同发十连的判定。
 */
const multiGoldGoldsByChannel = [character, weapon].filter(Boolean).map((ch) => ch.golds);
const multiGold = multiGoldGoldsByChannel.flatMap((golds) => multiGoldGroups(golds));
const multiGoldSize = multiGoldBySize(multiGold);
const upStreaks = seriesOf(charRounds, (r) => r.direct, { breakOnGuaranteed: true });
const lossStreaks = seriesOf(charRounds, (r) => r.off > 0);
const nearMiss = charRounds.filter((r) => r.off > 0 && r.total < pullsPerUp);

const metrics = {
  channelLabel: character.label,
  pulls: character.stats.pulls,
  goldCount: character.golds.length,
  upCount: charRounds.length,
  pullsPerUp: pullsPerUp == null ? null : Math.round(pullsPerUp * 10) / 10,
  winRate: finalWinRate,
  extremeRounds: extremeRounds.length,
  /*
   * 多金：total 是所有多金组的总数，multiGold2 / 3 / 4 按金数分档。
   * 只给 total 会让「十连双金 ×5」在有三金的账号里变成错的（5 次里有一次是三金）。
   * 标签模板可以写 {multiGold2} / {multiGold3} / {multiGold4}。
   */
  multiGoldRounds: multiGold.length,
  multiGold2: multiGoldSize.get(2) ?? 0,
  multiGold3: multiGoldSize.get(3) ?? 0,
  multiGold4: multiGoldSize.get(4) ?? 0,
  maxMultiGold: multiGold.reduce((m, g) => Math.max(m, g.length), 0),
  maxUpStreak: upStreaks.length ? upStreaks[0].k : 0,
  maxLossStreak: lossStreaks.length ? lossStreaks[0].k : 0,
  nearMissRounds: nearMiss.length,
  /*
   * 轨迹指标：把 winShape 摊平进 metrics，配置里的标签条件就能直接引用
   * （metric 条件只读 metrics，不认嵌套对象）。
   * 缺失时给 null，标签条件写 `>=` 时 null 不会被误判成立。
   */
  winRateTrough: winShape?.trough ?? null,
  winRateRise: winShape?.rise ?? null,
  winRateTroughVersion: winShape?.troughVersion ?? null,
  /*
   * 峰值：累计不歪率最高到过多少、在哪一版。
   * 「非酋翻身记」的 tip 用「最低 / 最高 / 当下」三点描述轨迹，
   * 涨幅是这三点的派生量，不再单独写出来（用户要求）。
   */
  winRatePeak: winShape?.peak ?? null,
  winRatePeakVersion: winShape?.peakVersion ?? null,
  winRateFinalVersion: winShape?.finalVersion ?? null,
  winRateFlips: winShape?.flips ?? 0,
  /*
   * 横跳发生的位置（历史事件，不是当前状态）。缺失给 null——
   * 标签条件写 `>=` 时 null 不会误判成立，tip 里也不会渲染出 "vnull"。
   */
  winRateFlipFromVersion: winShape?.flipFromVersion ?? null,
  winRateFlipToVersion: winShape?.flipToVersion ?? null,
  winRateFlipToAgo: winShape?.flipToAgo ?? null,
  /*
   * 每次横跳的逐行明细（`\n` 分隔，悬浮气泡是 `white-space: pre`，直接换行显示）。
   * 空数组时给空串而不是 null——tip 模板里 `{winRateFlipList}` 会渲染成 "null"。
   */
  winRateFlipList: (winShape?.flipLines ?? []).join('\n'),
  winRateSamples: winShape ? charBits.length : 0,
};

/** 称号：按每 UP 均查配置里的 10 档，取第一个满足的档位。 */
function titleFor(value) {
  if (value == null) return null;
  const tiers = CFG.titles.tiers;
  for (const t of tiers) {
    if (t.maxPullsPerUp == null || value <= t.maxPullsPerUp) return t;
  }
  return tiers[tiers.length - 1];
}
metrics.title = titleFor(metrics.pullsPerUp);

/** 条件求值：支持 > >= < <= == != */
const compare = (left, op, right) => {
  switch (op) {
    case '>': return left > right;
    case '>=': return left >= right;
    case '<': return left < right;
    case '<=': return left <= right;
    case '==': return left === right;
    case '!=': return left !== right;
    default: throw new Error(`未知比较符 ${op}`);
  }
};

const fill = (tpl, vars) => String(tpl ?? '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '').toString());

/** 计数后缀：只有出现不止一次时才写 ×N。 */
const times = (n) => (n > 1 ? ` ×${n}` : '');

function evaluateTags() {
  const out = [];
  // 提示文案可用的变量：指标 + 配置里的阈值
  const vars = { ...metrics, ...CFG.numbers };
  for (const rule of CFG.tags.rules) {
    if (rule.enabled === false) continue;
    const tone = CFG.tags.tone[rule.tone]?.color ?? CFG.tags.tone.positive.color;

    if (rule.kind === 'metric') {
      const groups = rule.any ? [rule.any] : [rule.all ?? []];
      const hit = groups.some((group) => group.every((c) => compare(metrics[c.metric] ?? 0, c.op, c.value)));
      if (!hit) continue;
      /*
       * `highlight` 决定前端悬浮时怎么高亮，**由配置声明、不在前端按 id 硬编码**：
       *   'line' → A 类：跟不歪率有关的标签（非酋翻身记 / 薛定谔的非酋）。
       *            悬浮时整条折线置顶提亮、柱状图整片压暗，没有「命中柱」的概念。
       *   缺省    → B 类：绑定柱位的标签（多金 / 连段 / 似非实欧等），压暗补集。
       * 以后再加 A 类标签只改 config，不动 charts.js。
       */
      out.push({ id: rule.id, name: fill(rule.name, metrics), tone, tip: fill(rule.tip ?? rule.name, vars), bars: [], highlight: rule.highlight ?? null });
      continue;
    }

    if (rule.kind === 'series') {
      const list = rule.series === 'upStreak' ? upStreaks : lossStreaks;
      if (!list.length) continue;
      /*
       * 每个不同的长度各出一个标签，不是只留最长那档。
       * 例：账号里有 5 连歪、也有 3 连歪，两个都要出现——
       * 只取最长会让「3 连歪」这个事实在报表里消失。
       * 同一长度出现多次才加 ×N。
       */
      const byLen = new Map();
      for (const item of list) {
        if (!byLen.has(item.k)) byLen.set(item.k, []);
        byLen.get(item.k).push(item);
      }
      // 单发成的「1 连」是噪音，不立标签（阈值可配）
      const minK = rule.minK ?? 2;
      const lens = [...byLen.keys()].filter((k) => k >= minK).sort((a, b) => b - a);
      if (!lens.length) continue;
      // 最长的那个仍用原 id，其余的加后缀，便于前端/测试稳定引用
      for (const [idx, k] of lens.entries()) {
        const same = byLen.get(k);
        const name = `${fill(rule.nameTemplate, { k })}${times(same.length)}`;
        const tip = same.map((s) => fill(rule.tipTemplate, s)).join('\n');
        out.push({
          id: idx === 0 ? rule.id : `${rule.id}-${k}`,
          name,
          /*
           * 最长的那条连 UP 用 highlight（更亮的金）。
           *
           * 连 UP 可能同时出 5 连、4 连、3 连好几条，它们现在都是同一个金色，
           * 读者第一眼分不出哪条是这个账号的「最高纪录」。
           * 只有 idx === 0（lens 按长度降序，第一个就是最长）提亮，
           * 其余保持常规 positive。
           *
           * **只对连 UP 生效**：连歪（loss-streak）走的是同一套代码，
           * 也给 idx===0 提亮的话，「代理人 7 连歪」这种最霉的纪录会被高亮成主角，
           * 语义完全反了。判据用规则的 tone 是不是 negative。
           */
          tone: idx === 0 && rule.tone !== 'negative'
            ? (CFG.tags.tone.highlight?.color ?? tone)
            : tone,
          tip,
          bars: same.map((s) => `${s.start}-${s.end}`),
        });
      }
      continue;
    }

    if (rule.kind === 'event') {
      if (!multiGold.length) continue;
      /*
       * 事件标签按金数分档：双金一条、三金一条、四金一条。
       *
       * 过去的写法是「只要有任意多金组就出一个 十连双金 ×N」——
       * 三金会被算进双金里，文案直接是错的：实测样本里就有
       * v1.4 雅 79 抽 → 1 抽 → 5 抽 的三金，写成「十连双金」等于说少了。
       *
       * 现在每组按自己的 length 落档：size=2 用 nameTemplate，
       * 更大的用 nameTemplate3 / nameTemplate4（模板里 {k} 是金数），
       * 缺省回落到 nameTemplate 里带 {k} 的写法。
       * 每个档位单独计数（{multiGold2} / {multiGold3}），tip 也只列自己档位的组。
       */
      const sizes = [...new Set(multiGold.map((g) => g.length))].sort((a, b) => a - b);
      for (const size of sizes) {
        const groups = multiGold.filter((g) => g.length === size);
        const tpl = (size === 2 ? rule.nameTemplate : rule[`nameTemplate${size}`]) ?? rule.nameTemplate;
        const name = fill(tpl, { k: size, ...metrics });
        const tip = groups
          .map((g) => `${[...new Set(g.map((x) => `v${x.version}`))].join('、')}：${g.map((x) => `${x.name} ${x.count} 抽`).join(' → ')}`)
          .join('\n');
        out.push({
          // 双金沿用原 id（配置 suppressWhen 里引用的是它），更高档位加后缀
          id: size === 2 ? rule.id : `${rule.id}-${size}`,
          name: rule.showCount ? `${name}${times(groups.length)}` : name,
          /*
           * 十连多金一律 highlight：这是整份报表里最罕见、最值得炫耀的事件，
           * 和普通「连 UP」放同一个金色会把它淹没。
           */
          tone: CFG.tags.tone.highlight?.color ?? tone,
          tip,
          bars: [],
          /*
           * 悬浮高亮用：**整组里每一金的** `sort`，按组内顺序展开成一维数组。
           *
           * 早先只存 `g[g.length - 1].sort`（每组最后一金），一次十连三金只亮最后一根柱子，
           * 另外两根不亮——标签写着「十连 3 金」，图上却只高亮 1 根，读起来像只出了 1 金。
           * 现在把整组的 sort 全带上，前端按当前频道逐根点亮；
           * 组与组之间用 `null` 分隔（见下面的 flatten），前端据此知道哪几根属于同一组。
           *
           * 为什么不在这里就算成柱子下标：`multiGold` 是**角色池 + 音擎合并**的
           * （见 multiGoldGoldsByChannel），而主图一次只画一个频道，
           * round 下标在不同频道里是两套互不相干的编号。在这里折成下标，
           * 音擎那几组会被错画到角色池的柱子上——不会报错，只是高亮错柱子。
           *
           * 所以只把稳定标识（频道内的 sort 序号）带给前端，
           * 由前端按「当前频道」自己映射成柱位——这就是悬浮高亮用的那条链路
           * （`barsOfTag()` → `sort` → 柱位），只有这一个入口，别处不要再写第二份。
           */
          multiGoldSorts: groups.flatMap((g, gi) => [
            ...(gi ? [null] : []),
            ...g.map((x) => x.sort),
          ]),
        });
      }
      continue;
    }

    if (rule.kind === 'round') {
      const m = rule.match ?? {};
      const hits = charRounds
        .map((r, idx) => ({ r, idx }))
        .filter(({ r }) => {
          if (m.offAbove != null && !(r.off > m.offAbove)) return false;
          if (m.totalBelowMean && !(r.total < pullsPerUp)) return false;
          return true;
        });
      if (!hits.length) continue;
      const name = rule.showCount ? `${rule.nameTemplate}${times(hits.length)}` : rule.nameTemplate;
      const tip = hits.map(({ r }) => `v${r.version} ${r.name}：${r.total} 抽，歪 ${r.off} 抽`).join('\n');
      out.push({ id: rule.id, name, tone, tip, bars: hits.map(({ idx }) => `${idx}-${idx}`) });
    }
  }
  return out;
}

const rawTags = evaluateTags();

/*
 * 标签去重与优先级。
 *
 * 冲突来自两类：
 *   1) 宏观概括 vs 具体明细：「运势极佳」(最长连 UP ≥ 4) 与「代理人 4 连 UP」是同一件事，
 *      两条同时出现等于说两遍。具体的那条更有信息量，所以概括让位（配置里的 suppressWhen）。
 *   2) 正向 vs 负向互斥：「欧气附体」与「非酋附体」理论上可同时成立，同时出现会自相矛盾。
 *
 * 规则：配置数组里靠前的优先级更高；被 suppressWhen 指向的标签一旦存在，本条就不再输出。
 */
const tags = (() => {
  const present = new Set(rawTags.map((t) => t.id));
  const killed = new Set();
  for (const t of rawTags) {
    const rule = CFG.tags.rules.find((r) => r.id === t.id);
    for (const dep of rule?.suppressWhen ?? []) {
      if (present.has(dep)) killed.add(t.id);
    }
  }
  // 正负互斥
  if (present.has('unlucky-aura')) killed.add('lucky-aura');
  return rawTags.filter((t) => !killed.has(t.id));
})();

if (rawTags.length !== tags.length) {
  const dropped = rawTags.filter((t) => !tags.includes(t)).map((t) => t.name);
  console.log(`  （标签去重，已省略：${dropped.join(' / ')}）`);
}

/** 详情行：逐金模式 = 每一金一行；合并模式 = 只留 UP 行，歪成本并入。 */
function detailRows(channel, merged) {
  const toRow = (g) => ({
    itemId: g.itemId,
    name: g.name,
    version: g.version,
    pulls: g.count,
    isUp: g.isUp,
    lost: channel.has5050 ? !g.isUp : null,
    stamp: channel.has5050 && !g.isUp,
    recordTime: g.recordTime,
  });
  if (!merged || !channel.has5050) {
    return channel.golds
      .slice()
      .reverse()
      .map((g) => toRow(g));
  }
  return channel.rounds
    .slice()
    .reverse()
    .map((r) => ({
      itemId: r.itemId,
      name: r.name,
      version: r.version,
      pulls: r.total,
      isUp: true,
      lost: r.off > 0,
      stamp: r.off > 0,
      up: r.up,
      off: r.off,
      recordTime: r.recordTime,
      side: r.side,
      // 歪出的角色在 losts 里（side 只装十连副金），tip 需要它
      losts: r.losts,
    }));
}

const details = Object.fromEntries(
  CFG.channels.map((ch) => {
    const c = channelReports.find((x) => x.id === ch.id);
    return [ch.id, { all: detailRows(c, false), merged: detailRows(c, true), perGold: c.perGold, has5050: ch.has5050 }];
  }),
);

const versions = (() => {
  const all = channelReports.flatMap((c) => c.golds.map((g) => g.version)).filter(Boolean);
  const uniq = [...new Set(all)];
  uniq.sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    return pa[0] - pb[0] || (pa[1] ?? 0) - (pb[1] ?? 0);
  });
  return uniq;
})();

/**
 * 把版本号切成「连续段」：同一版本的柱子归为一组，用于横轴只标一次版本。
 *
 * 为什么不直接每个柱子都写 v1.0：
 *   一个版本里抽得多时会有几根柱同属 v2.0，横轴就变成 v2.0 v2.0 v2.0 密麻麻一片，
 *   既读不出「这是同一个版本」，也挤压了真正需要辨认的相邻版本。
 *   切段之后每组只在中间标一次，组的范围由 `from`/`to` 给出，前端据此画组背景。
 *
 * 返回 [{version, from, to}]，from/to 是 rounds 的下标（闭区间）。
 */
function versionGroups(rounds) {
  const groups = [];
  rounds.forEach((r, i) => {
    const last = groups[groups.length - 1];
    // 只合并相邻的同版本柱。版本连续不交叉是采集数据的性质，
    // 若同一版本因数据异常再次出现，会另起一组而不是把中间别的版本吞进来。
    if (last && last.version === r.version) last.to = i;
    else groups.push({ version: r.version, from: i, to: i });
  });
  return groups;
}

/**
 * 主图数据集：一个频道一份。
 *
 * 为什么主图要支持多频道：
 *   抽卡总览原来只画角色池，音擎要翻到第二屏详情里才能看。
 *   音擎的 UP 成本是完全独立的一套数（保底 80 而非 90、每 UP 抽数也不同），
 *   把它并进角色池的柱子里会让两边都不成立，所以是「切数据集」而不是「加柱子」。
 */
function chartOf(channel) {
  const rounds = channel.rounds;
  const perUp = rounds.length ? channel.effectivePulls / rounds.length : null;
  const groups = multiGoldGroups(channel.golds);
  return {
    channelId: channel.id,
    key: channel.key,
    label: channel.label,
    detailLabel: channel.detailLabel,
    rounds,
    /*
     * 官方口径的总抽数与垫抽一起带出去。
     * 前端标题行要写「N 个 UP · N 抽」，用柱子求和会少掉垫抽
     * （实测 6320 官方 vs 6318 柱和），两个数并排出现时就对不上。
     */
    pulls: channel.stats?.pulls ?? rounds.reduce((s, r) => s + r.total, 0),
    pity: channel.pity ?? 0,
    perUp: perUp == null ? null : Math.round(perUp * 10) / 10,
    winRate: cumulativeWinRate(rounds),
    extremePulls: CFG.numbers.extremePulls,
    versionGroups: versionGroups(rounds),
    /*
     * 多金点的位置：取组内最后一金的 sort，前端再映射回所属柱子。
     * `size` 带出去让前端按金数给点不同大小——三金点比双金点大一圈，
     * 光看点的数量分不出「两次双金」和「一次三金」。
     */
    multiGold: groups.map((g) => ({
      sort: g[g.length - 1].sort,
      size: g.length,
      names: g.map((x) => x.name),
    })),
  };
}

const report = {
  schema: 'zzz-stats/report@1',
  generatedAt: new Date().toISOString(),
  meta: {
    // 昵称不在任何接口里，只能由采集步从页面 DOM 文本读到，写进 meta.json
    nickname: meta.nickname ?? null,
    nicknameKnown: Boolean(meta.nickname),
    uid: String(meta.uid ?? ''),
    region: meta.region ?? 'prod_gf_cn',
    /*
     * 区服名：优先按 region 查表，查不到再看 meta.server（cn / os），最后原样显示。
     * 过去写死「国服」——国际服账号的报表会印着「国服」，直接是错的。
     */
    serverLabel: SERVER_LABELS[String(meta.region ?? '')]
      ?? (meta.server === 'os' ? '国际服' : meta.server === 'cn' ? '国服' : String(meta.region ?? '')),
    fetchedAt: meta.fetched_at ?? null,
    versionFrom: versions[0] ?? null,
    versionTo: versions[versions.length - 1] ?? null,
  },
  metrics,
  tags,
  title: metrics.title,
  /*
   * 主图数据集按频道分开，前端用 tab 切换。
   *
   * 只收「有 50/50」且「真的折出了 UP 轮」的频道：
   *   - 常驻 / 邦布没有 UP 概念，折不出「这一轮花多少抽换到 UP」，画出来没有意义；
   *   - 独家重映 / 音擎回响常常是 0 轮（账号没抽过），留着会给出一个点进去全空的 tab。
   * 一个都没有时 charts 为空数组，前端会跳过整块图表而不是崩在 Math.max(...[])。
   */
  charts: channelReports
    .filter((c) => c.has5050 && c.rounds.length > 0)
    .map((c) => chartOf(c)),
  /*
   * 版本过滤器：按主版本分档（1.x / 2.x / 3.x）。
   * 只列当前账号真实出现过的档位，不写死 1/2/3——
   * 未来版本更新后不用改代码，也只给出有数据可筛的选项。
   */
  versionFilters: [...new Set(versions.map(majorOf))].filter(Boolean).sort((a, b) => Number(a) - Number(b)),
  channels: channelReports.map((c) => ({
    id: c.id,
    key: c.key,
    label: c.label,
    detailLabel: c.detailLabel,
    kind: c.kind,
    has5050: c.has5050,
    stats: c.stats,
    perGold: c.perGold,
    goldCount: c.golds.length,
    rounds: c.rounds.length,
    // 垫抽进度：前端详情头的进度条直接消费这几项，不再自己算
    pity: {
      cur: c.pity,
      cap: c.pityCap,
      remain: c.pityCap == null ? null : Math.max(0, c.pityCap - c.pity),
      pct: c.pityCap ? Math.min(100, Math.round((c.pity / c.pityCap) * 1000) / 10) : null,
      /*
       * 上一个 S：垫抽这个数的起点就是它。
       * 只写「已垫 58 / 90」读者还得自己想「从哪开始垫的」；
       * 带上名字与版本，「这 58 抽是抽在谁之后」才有上下文。
       * 整条频道还没出过金（如回响 103）时是 null，前端不显示这一行。
       */
      last: (() => {
        const g = c.golds[c.golds.length - 1];
        return g ? { name: g.name, itemId: g.itemId, version: g.version, recordTime: g.recordTime } : null;
      })(),
    },
  })),
  details,
  kpi: [
    { key: 'winRate', label: '角色池不歪', value: finalWinRate == null ? '—' : `${finalWinRate}%`, unit: '' },
    { key: 'pullsPerUp', label: '每 UP 角色', value: metrics.pullsPerUp ?? '—', unit: '抽' },
    // 每金 / 每 UP 一律用「官方总抽 − 当前垫抽」：垫抽还没结算成金，摊进历史均值会让称号系统性偏非
    { key: 'weaponPerUp', label: '每 UP 音擎', value: (() => { const w = channelReports.find((c) => c.key === 'weapon_up'); const n = w.stats?.upCount; return n ? Math.round((w.effectivePulls / n) * 10) / 10 : '—'; })(), unit: '抽' },
    { key: 'permanentPerGold', label: '常驻每金', value: (() => { const p = channelReports.find((c) => c.key === 'permanent'); return p.perGold ? Math.round(p.perGold * 10) / 10 : '—'; })(), unit: '抽' },
    { key: 'bangbooPerGold', label: '每邦布', value: (() => { const b = channelReports.find((c) => c.key === 'bangboo'); return b.perGold ? Math.round(b.perGold * 10) / 10 : '—'; })(), unit: '抽' },
  ],
  totals: {
    // 跨频道汇总只算同一种货币：邦布用邦布币，不计入
    pulls: channelReports.filter((c) => c.countsTowardTotals !== false).reduce((s, c) => s + (c.stats?.pulls ?? 0), 0),
    pullsUsingTicket: channelReports.reduce((s, c) => s + (c.stats?.pulls ?? 0), 0),
    golds: channelReports.filter((c) => c.countsTowardTotals !== false).reduce((s, c) => s + c.golds.length, 0),
    goldsUsingTicket: channelReports.reduce((s, c) => s + c.golds.length, 0),
    pullsOfficial: num(index.total_gacha_count),
    goldsOfficial: num(index.total_s_count),
    excludedChannels: channelReports.filter((c) => c.countsTowardTotals === false).map((c) => c.label),
  },
  config: CFG,
};

// ---------------------------------------------------------------- 渲染

/*
 * 图标内嵌 + 去重。
 *
 * 为什么内嵌：报表经常被单独发出去（发文件、贴到别的对话、当附件）。
 * 如果只写相对路径 `assets/report/icons/avatars/x.png`，接收方拿不到 assets 目录，
 * 就会看到一堆空框 —— 图表头像和详情图标全没了。
 *
 * 为什么要去重：同一张图在 HTML 里会出现很多次（同一角色反复 UP、歪出、
 * 十连副金，图标在「逐金」和「合并」两种详情里还各存一份）。
 * 旧实现每次都在数据里塞一整串 base64，产物 3.7 MB 里唯一内容只有不到 1 MB。
 *
 * 现在的做法：
 *   1) 按文件内容 sha1 去重 → 一份图标只编码一次，落到 `ICONS[hash]`；
 *   2) 数据里只存 `{ icon: hash }`（图表头像）/ `{ icon: hash }`（详情图标）；
 *   3) 前端用一次 `ICONS[...]` 取回 data URL，肉眼无差别，产物体积砍掉 2/3。
 */
function inlineImages(report) {
  const byHash = new Map();   // sha1 → dataURL
  const byId = new Map();     // `${dir}/${id}` → hash|null
  let missing = 0;

  const encode = (dir, id) => {
    const key = `${dir}/${id}`;
    if (byId.has(key)) return byId.get(key);
    /*
     * 图标只有 64px 一套，就在 `assets/report/icons/<dir>/`。
     * 96px 那套（原来的 `assets/avatars` / `assets/items`）已经删掉：
     * 实际显示尺寸最大 26 CSS px，DPR2 才需要 52px，64px 够用；
     * 而且 96px 本身也是从更大的原图缩出来的，不是原始资产。
     */
    const file = join(SKILL_DIR, 'assets/report/icons', dir, `${id}.png`);
    let buf = existsSync(file) ? readFileSync(file) : null;
    if (!buf) {
      missing += 1;
      console.warn(`  ⚠️  缺图标 assets/report/icons/${dir}/${id}.png，用占位图代替`);
      const fb = join(SKILL_DIR, 'assets/report/icons/items/_fallback.png');
      buf = existsSync(fb) ? readFileSync(fb) : null;
    }
    if (!buf) {
      byId.set(key, null);
      return null;
    }
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16);
    if (!byHash.has(hash)) byHash.set(hash, `data:image/png;base64,${buf.toString('base64')}`);
    byId.set(key, hash);
    return hash;
  };

  /*
   * 主图头像：数据里只留图标 hash，前端用 ICONS[hash] 还原。
   *
   * 图标目录按频道类型选：代理人头像是圆头像（icons/avatars），
   * 音擎只有方形道具图标（icons/items）——音擎的 item id 在 avatars 下根本不存在。
   * 早先主图只画角色池，写死 'avatars' 没事；接上音擎 tab 后写死会让每根音擎柱
   * 都掉到占位图上（还会刷一屏「缺图标」警告）。
   */
  for (const c of report.charts) {
    const dir = c.key.startsWith('weapon') ? 'items' : 'avatars';
    for (const r of c.rounds) {
      r.avatarKey = encode(dir, r.itemId);
      for (const s of r.side) s.avatarKey = encode(dir, s.itemId);
      for (const x of r.losts ?? []) x.avatarKey = encode(dir, x.itemId);
    }
  }
  // 详情图标
  for (const ch of Object.values(report.details)) {
    for (const mode of ['all', 'merged']) {
      for (const row of ch[mode]) row.iconKey = encode('items', row.itemId);
      for (const row of ch[mode]) {
        for (const s of row.side ?? []) s.iconKey = encode('items', s.itemId);
      }
    }
  }
  report.icons = Object.fromEntries(byHash);
  return { unique: byHash.size, used: byId.size, missing };
}

const template = readFileSync(join(SKILL_DIR, 'assets/report/template.html'), 'utf8');
const chartsJs = readFileSync(join(SKILL_DIR, 'assets/report/charts.js'), 'utf8');
const chartsCss = readFileSync(join(SKILL_DIR, 'assets/report/charts.css'), 'utf8');
const echartsJs = readFileSync(join(SKILL_DIR, 'assets/vendor/echarts.min.js'), 'utf8');

const icons = inlineImages(report);

/*
 * 配置注入 CSS 变量。
 *
 * 「改配色只改 config」是这份 skill 对外的承诺，但主色 / 歪章色 / 详情条色过去在
 * charts.css 里各写了一份硬编码，改配置纹丝不动。这里把颜色统一灌进 CSS 变量：
 *   --accent / --loss-stamp / --detail-good / --detail-bad / --ink-*
 * 之后再配置里改值，构建产物立刻生效，前端 CSS 不用动。
 */
const cssVars = {
  accent: CFG.colors.accent,
  lossStamp: CFG.colors.lossStamp,
  detailGood: CFG.colors.detailGood,
  detailBad: CFG.colors.detailBad,
  extremeTop: CFG.colors.extreme?.top,
  goodTop: CFG.colors.good?.top,
  badTop: CFG.colors.bad?.top,
};
const cssVarBlock = (() => {
  const pairs = Object.entries(cssVars)
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `  --${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${v};`);
  return pairs.length ? `:root {\n${pairs.join('\n')}\n}\n` : '';
})();

// 文案也一律从配置来：过去 copy.chartTitle / detailTitle / mergeToggle 有定义没人读
const textSubs = (() => {
  const map = {
    '/*__COPY_CHART_TITLE__*/': CFG.copy.chartTitle ?? '抽卡总览',
    '/*__COPY_DETAIL_TITLE__*/': CFG.copy.detailTitle ?? '抽卡详情',
    '/*__COPY_MERGE_TOGGLE__*/': CFG.copy.mergeToggle ?? '显示真实抽数',
  };
  return map;
})();

let html = template
  .replace('/*__CONFIG_CSS_VARS__*/', () => cssVarBlock)
  .replace('/*__CHARTS_CSS__*/', () => chartsCss)
  .replace('/*__ECHARTS__*/', () => echartsJs)
  .replace('/*__REPORT_DATA__*/', () => `window.__REPORT__ = ${JSON.stringify(report)};`)
  .replace('/*__CHARTS_JS__*/', () => chartsJs);
for (const [token, text] of Object.entries(textSubs)) {
  // 文案来自本地配置，但仍做一次 HTML 转义，避免配置里写了尖括号把模板打坏
  const esc = String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  html = html.split(token).join(esc);
}

// ---------------------------------------------------------------- 校验 + 摘要

/*
 * 通用完整性校验（6/6 频道实测成立，比「记录条数对得上」更强）：
 *     sum(cur_records[].count) + type_stats[].next_s_cur_times == type_stats[].total_count
 * 左边是「已出金的抽数 + 当前垫抽」，右边是官方总抽数。金数对得上但记录缺抽时会在这里露出来。
 * 常驻/邦布没有任何 is_up 记录，所以只对 50/50 频道额外做 UP 轮校验。
 */
/*
 * 校验分两级：
 *   warn  —— 数据层面的可疑点（缺图标、口径对不上等）。打印后照常出图：
 *            图标缺失有占位图兜底，是设计好的降级，不该挡住交付。
 *   fatal —— 产物一定不可信的问题。**必须挡住构建（exit 1）**，
 *            否则「跑一次没事」就会漏过去，断言等于没写。
 *
 * 目前只有坐标轴退化算 fatal：那条断言的整个存在意义是「不靠人记得」，
 * 只打一行 ⚠️ 而照样退出 0，下次改代码时仍然会静默退回去。
 */
const warn = [];
const fatal = [];
for (const c of channelReports) {
  if (!c.stats) {
    warn.push(`${c.label}: index 里没有对应 type_stats，抽数只能从记录推算`);
    continue;
  }
  const recordedPulls = c.golds.reduce((s, g) => s + g.count, 0);
  const pity = c.stats.pity ?? 0;
  if (recordedPulls + pity !== c.stats.pulls) {
    warn.push(`${c.label}: 金抽数 ${recordedPulls} + 垫抽 ${pity} = ${recordedPulls + pity} ≠ 官方 ${c.stats.pulls}`);
  }
  if (c.golds.length !== c.stats.sCount) {
    warn.push(`${c.label}: 金数 ${c.golds.length} ≠ 官方 s_count ${c.stats.sCount}`);
  }
  /*
   * 扣垫抽口径的自检：我们算的「每金」应当等于官方 avr_up_count。
   * 官方这个字段本身就是 (total_count - next_s_cur_times) / s_count，
   * 对不上说明垫抽读错了、或 total_count 不是同一个口径——这比金数对得上更有价值。
   */
  if (c.stats.upAvg != null && c.stats.upAvg > 0) {
    /*
     * 官方 avr_up_count 的分母是 up_count，没有 UP 的频道（常驻 / 邦布 / 空池）退回 s_count。
     * 实测 6/6 频道都严格等于 (total_count − next_s_cur_times) / 分母：
     *   独家 87.9 · 音擎 73.8 · 常驻 65.8 · 邦布 48.6 · 独家重映 76 · 音擎回响 0。
     * 对不上说明垫抽读错或 total_count 口径变了——这比「金数对得上」更能抓到问题。
     */
    const denom = (c.stats.upCount || 0) > 0 ? c.stats.upCount : c.stats.sCount;
    const ours = denom ? (c.stats.pulls - (c.stats.pity ?? 0)) / denom : null;
    if (ours != null && Math.abs(ours - c.stats.upAvg) > 0.1) {
      warn.push(`${c.label}: 每 ${denom === c.stats.upCount ? 'UP' : '金'} ${ours.toFixed(1)} ≠ 官方 avr_up_count ${c.stats.upAvg}（垫抽口径可能不一致）`);
    }
  }
  if (c.has5050) {
    const sumRounds = c.rounds.reduce((s, r) => s + r.total, 0);
    if (Math.abs(sumRounds - (c.stats.pulls - pity)) > 0) {
      warn.push(`${c.label}: UP 轮总抽 ${sumRounds} ≠ 官方已抽 ${c.stats.pulls - pity}`);
    }
  }
}
const nonBangbooPulls = channelReports.reduce((s, c) => s + (c.key === 'bangboo' ? 0 : c.stats?.pulls ?? 0), 0);
if (report.totals.pullsOfficial != null && report.totals.pullsOfficial !== nonBangbooPulls) {
  warn.push(`官方 total_gacha_count=${report.totals.pullsOfficial} ≠ 非邦布频道之和 ${nonBangbooPulls}（两个口径都不含邦布）`);
}

/*
 * 轴上限的防回归校验。
 *
 * 为什么要有这条：右轴（不歪率）曾经「修好又退回去」一次——
 * 左轴改成了「先读配置 axisPullsMax」，右轴漏了同一步、只留了自适应，
 * 于是角色池显 60%、音擎显 80%，跨图没法对比。
 * 之所以没被发现，是因为独家重映那栏峰值恰好 100%、自适应出来也是 100%，
 * 随便点开一个频道看着是对的。
 *
 * 这里做的不是「验证图表」，而是**验证产物里每个频道都拿到了配置的固定上限**：
 * 产物 HTML 里会内嵌 report 数据，前端照这个值设轴。只要有一个频道缺键，
 * 前端就会静默回退到自适应——所以必须在这里断言「每个可画频道都有值」。
 */
const axisWinMax = CFG.numbers.axisWinRateMax;
const pullsMaxCfg = CFG.numbers.axisPullsMax ?? {};
/*
 * 上面那段只验「配置在不在」，但这次的回归根因是**前端没读配置**（charts.js 只留了自适应）。
 * 所以再断言一次：charts.js 里必须真的出现这两个配置键的读取。
 *
 * 检查前必须先剥掉注释：这两个键名在注释里也出现过（就是解释这段历史的那段），
 * 直接 includes 会被注释骗过去——实测把读取那行删掉、注释留着，检查仍然通过。
 */
const stripJsComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const chartsCode = stripJsComments(chartsJs);
for (const key of ['axisWinRateMax', 'axisPullsMax']) {
  if (!chartsCode.includes(`CFG.numbers.${key}`)) {
    fatal.push(`assets/report/charts.js 没有真正读取 CFG.numbers.${key}：坐标轴会退化成按数据自适应，跨图不可比`);
  }
}
if (axisWinMax == null) {
  fatal.push('config.numbers.axisWinRateMax 没配：右轴会回退成按数据自适应，跨图将无法对比');
} else {
  for (const c of report.charts) {
    if (!c.winRate?.length) continue;
    const peak = Math.max(...c.winRate);
    if (peak > axisWinMax) {
      fatal.push(`${c.label}: 不歪率峰值 ${peak}% > 固定上限 ${axisWinMax}%，曲线会被截断`);
    }
  }
}
if (!Object.keys(pullsMaxCfg).length) {
  fatal.push('config.numbers.axisPullsMax 没配：左轴会回退成按数据自适应，跨图将无法对比');
} else {
  for (const c of report.charts) {
    if (!pullsMaxCfg[c.key]) {
      fatal.push(`${c.label}: axisPullsMax 里没有 ${c.key}，左轴会回退成自适应，与其他频道不可比`);
    } else {
      const tallest = c.rounds.reduce((m, r) => Math.max(m, r.total), 0);
      if (tallest > pullsMaxCfg[c.key]) {
        fatal.push(`${c.label}: 最高柱 ${tallest} 抽 > 固定上限 ${pullsMaxCfg[c.key]}，柱子会被截断`);
      }
    }
  }
}

/*
 * fatal 优先：**不写产物、直接退出 1**。
 *
 * 顺序很关键：文件写出必须放在校验之后。早先 writeFileSync 在校验之前，
 * 就算这里真退 1，坏产物也已经躺在 output/ 里了——CI 红了，但人打开文件看到的还是坏图。
 */
if (fatal.length) {
  console.error('');
  for (const f of fatal) console.error(`  ✖ ${f}`);
  console.error('');
  console.error(`构建失败：${fatal.length} 个致命问题，未写出 ${OUT_FILE}`);
  process.exit(1);
}

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, html);

const sizeMB = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`报表 → ${OUT_FILE}（${sizeMB} MB，内嵌 ${icons.unique} 张图标去重后引用 ${icons.used} 处，可单独发送）`);
console.log(`  角色池 ${metrics.upCount} UP / ${metrics.pulls} 抽 / 每 UP ${metrics.pullsPerUp} / 不歪 ${metrics.winRate}% / 称号「${metrics.title?.name}」`);
console.log(`  KPI: ${report.kpi.map((k) => `${k.label} ${k.value}${k.unit}`).join(' · ')}`);
console.log(`  标签: ${tags.map((t) => t.name).join(' / ') || '（无）'}`);
for (const w of warn) console.warn(`  ⚠️  ${w}`);
process.exit(0);
