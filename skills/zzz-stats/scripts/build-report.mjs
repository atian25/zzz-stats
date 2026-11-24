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
      '--data 认任意相对/绝对路径：开发本仓库时用 --data fixtures/baseline（fixtures/ 不进运行期兜底），',
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
 * 用户项目里 `data/` 和 `fixtures/` 都极常见。本仓库开发时用 `--data fixtures/baseline`
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
  console.error('    （开发本仓库时用 --data fixtures/baseline）。');
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
 * 显式 `--data fixtures/baseline` 时，上一级是 `fixtures/`，**不能往那儿写**
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
      losts.push({
        name: g.name,
        itemId: g.itemId,
        count: g.count,
        sort: g.sort,
        // 非 UP 角色 tip 的「逐次来源」要用它来排时间、标版本（见 charSummary 的 ③）
        recordTime: g.recordTime,
        version: g.version,
      });
      i += 1;
      continue;
    }
    const round = {
      version: g.version,
      name: g.name,
      itemId: g.itemId,
      /*
       * UP 本身那条金的类型。音擎频段也有 50/50（输了给音擎、期间可能歪出角色），
       * 所以「这一轮是角色还是音擎」不能按频道类型猜，必须照抄原始记录——
       * 详情行要靠它决定标不标「本体/影画」（音擎重复是精炼，没有影画）。
       */
      itemType: g.itemType,
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
      round.side.push({
        name: golds[j].name,
        itemId: golds[j].itemId,
        count: golds[j].count,
        sort: golds[j].sort,
        recordTime: golds[j].recordTime,
        version: golds[j].version,
      });
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
 * 走法可以完全相反——实测基线账号从 14.3% 一路爬到 48.1%（爬出来的），
 * 多金账号则在 70% 和 20% 之间来回起伏（跳出来的）。终值读不出这件事。
 *
 * **横跳的分界线不是 50%**。50% 是「小欧」和「大欧」的分界，两边都是欧，
 * 在 50% 上下浮动不代表横跳。真正的横跳是**在非酋和欧之间来回**：
 * `nonEdge`（非酋档上界）以下算非、`euroEdge`（50/50 理论期望）以上算欧，
 * 中间的「薛定谔」带两边都不算——它本来就是「还看不出来」的地带，在里面游荡不算横跳。
 *
 * **横跳必须看滑动窗口，不能看累计值**。累计值是全程平均，早期的大坑会被越摊越淡：
 * 多金账号的累计值从未跌破 35%（谷底 42.9%），但把窗口收到最近 10 轮，
 * 它的近期胜率一路从 70% 掉到 20% 再回到 80%——那是实实在在的「一会欧一会非」，
 * 只是在全程累计里被平均没了。所以 `flips` 在 `rollingWinRate()` 的序列上统计。
 *
 * `minSamples`：前几轮的累计值是噪音，不是这个人的水平。
 * 1 轮 0%、2 轮 50% 这种极值会把谷底拉到 0%，于是每个账号都能自称「曾是非酋」。
 * 默认从第 5 轮起算（实测基线账号前 3 轮都是 0%，排除后谷底落在第 7 轮的 14.3%）。
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
   * 实测多金账号用错偏移会算出 v1.1～v1.2、53 轮前，正确是 v1.2～v1.4、44 轮前。
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
   * 这是横跳里最有信息量的那个数：多金账号的**累计**谷底是 42.9%（从没进过非酋档），
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
   * 实测多金账号：2 次 flip 落在第 20 轮（v1.2）和第 27 轮（v1.4），距今 44 轮；
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
     * 这两个数是不同的量：多金账号累计谷底 42.9%，但近 10 轮能掉到 20%。
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
 * 实测多金账号角色池 5 组多金、音擎另有一组三金 + 一组双金，
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
    /*
     * `itemType` 与 `sort` 是「本体/影画N」的坐标，不是给渲染层用的：
     *   - itemType 决定要不要标（音擎 = 精炼、邦布无影画，都不标）；
     *   - sort 是同一 recordTime 内的唯一区分（十连双金同秒），
     *     只按 recordTime 回贴编号会把同秒两只标成同一号。
     * 编号本身在构建期算好写进 `portrait`，前端只读，不重算。
     */
    itemType: g.itemType,
    sort: g.sort,
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
      // 合并模式下这一行代表的那条金记录（UP 本身），坐标与 all 视图同一条
      itemType: r.itemType,
      sort: r.sort,
      side: r.side,
      // 歪出的角色在 losts 里（side 只装十连副金），tip 需要它
      losts: r.losts,
    }));
}

/*
 * 右栏：角色维度汇总。
 *
 * ## 为什么是**跨全部频段**聚合，而不是跟着左边 tab 走
 *
 * 影画必须全局算。独家频段能歪出常驻角色，同一个角色的重复获取会散落在不同频道里：
 * 实测 fixtures/baseline 的珂蕾妲在独家 4 次 + 常驻 2 次，按频道分开算得到 3 影 + 1 影，
 * 而正确影画是 5 影；猫又同样（独家 2 + 常驻 2，分开算各 1 影，实际 3 影）。
 * 共享池就是这样，分频道算必然少算。
 *
 * 右栏是对面左边的独立分栏，**不随 tab 变化**：左栏回答「这 41 金怎么来的」，
 * 右栏回答「这个号一共拿到过哪些角色、各几只」。
 *
 * ## 只统计角色（`item_type === 'ItemType_Avatar'`）
 *
 * 音擎和邦布**没有影画概念**。音擎频段里两种金混在一起（音擎 + 歪出的角色），
 * 邦布整列都是邦布，一律不进右栏。常驻频段里抽到的角色照常计入（它们是角色）。
 *
 * ## 三个指标的口径
 *
 * - **出现次数**：该角色在**所有频段**的金记录里出现几条。每出现一次就是「拿到了一个」。
 * - **影画** = 出现次数 − 1。第 1 只给 0 影画，第 2 只给 1 影画（游戏里升 1 影需要 2 只）。
 *   注意这是**按记录次数反推**的，不是游戏里读到的影画等级：超过 7 只（6 影后继续抽）
 *   的情况照实显示 6 以上，所以前端要注明口径，不能写成确定结论。
 * - **总抽数** = 该角色**每一轮那一轮的 `total`** 累加，不是只取 UP 那一条的 `count`。
 *   一轮 `total` = 期间歪出的抽数 + 这一只自己的 `count` + 十连副金的 `count`。
 *   所以雅 3 只 = 152 + 154 + 78 = 384 抽。大保底那一只必须把前面歪掉的抽算进成本，
 *   否则「为了拿到它花了多少抽」会系统性偏低（只取 `count` 会算成 230，差 154 抽）。
 *
 * ## 自洽校验（构建期 fatal，见 testPullsClosure 附近的断言）
 *
 * 右栏所有 UP 角色的 `pulls` 之和必须等于**独家 + 独家重映的官方总抽数**
 * （`GACHA_TYPE_CHARACTER_UP` 2372 + `GACHA_TYPE_CHARACTER_RETURN` 76 = 2448）。
 * 这两个频道里每一抽都必然属于某一轮，所以只要口径是「轮 total 累加」就一定闭合；
 * 一旦谁改回「只取 up 的 count」，这个和会立刻对不上（实测 1759 ≠ 2448），构建直接失败。
 *
 * **只有 UP 角色才展示抽数与歪**（用户定的：「非 UP 角色显示几命即可」）。
 * 非 UP 角色从没当过 UP，给它算「一共多少抽」没有意义（抽数属于把它歪出来的那个 UP），
 * 而「歪了几次」在它身上恰好是反的。数据里仍保留 `pulls` / `lostOut` 供 tip 与将来使用，
 * 但渲染层不输出。
 *
 * ## 「歪」的两种语义（这是被写错过一次的地方，别再用 `is_up === false` 数条数）
 *
 * `is_up === false` 的意思是**这个角色是被歪出来的**，不是「这个角色歪了 N 次」。
 * 拿它当「歪次数」，会让猫又这种常驻角色显示「歪 2 次」——语义正好反了：
 * 它从来没当过 UP，怎么可能输 50/50。
 *
 * 正确的判定走**已有的轮次模型**（`buildRounds` / `markGuaranteed`，与主图同一套）：
 *
 * - **UP 角色**：一轮 UP 里 `off > 0`（期间出过非 UP 金）或 `guar`（上一轮副金带出的保底）
 *   = 这一轮歪了。所以「歪 N 次」= 为了追它，一共歪过几轮。
 * - **非 UP 角色**：「被歪出 N 次」= 它在别人的轮次里作为非 UP 金出现过几回
 *   （`round.losts` 是被歪掉的，`round.side` 是十连里跟在 UP 后面的副金，两者都是「被歪出」）。
 *
 * 只数 `has5050` 且 `kind === 'avatar'` 的频道（独家 / 独家重映）：歪的语义是「50/50 输了」，
 * 常驻和邦布没有 50/50，那里的角色不算被歪出；音擎的 50/50 输给音擎，与角色无关。
 *
 * ## 排序
 *
 * UP 角色在前、非 UP 在后；两组各自按**最后获得时间倒序**（该角色所有记录的 `record_time` 最大值），
 * 最后按 itemId 稳定排序。不按名字排——中文名排序对读者没有意义。
 * 不按出现次数排：那样「从没 UP 过但最近刚拿到」的珂蕾妲会压在最新的 UP 角色上面。
 */
/*
 * 右栏每行的「欧 / 非」标记：**总抽倍率** vs 该角色的期望抽数。
 *
 * 口径用户已定死（config 的 numbers._luckComment 有完整理由）：
 *   expect = upRounds × luckExpectPerUp      （upRounds = 这个角色当过几次 UP，每次期望 93.75 抽）
 *   ratio  = pulls / expect
 *   再按 numbers.luckTiers 的区间落档（欧档只给 max 不含，非档 min 不含 + max 含）
 *   谁都落不进 → null，不标，保持干净
 *
 * **改前是「每 UP 均抽 = pulls / upRounds」直接比 93.75 ±15%**，二分欧/非。
 * 换成总抽倍率的原因：19 只里 14 只只抽过 1 只，均抽等于把单次运气当角色属性；
 * 按总抽算，多只角色有 N × 93.75 的基准（蕾米埃尔 3 只 194 抽 / 期望 281.25 = 0.690 属欧）。
 *
 * **只对 isUp 判**：非 UP 角色没有抽数（它们是被歪出来的，抽数记在别人头上），
 * 给它们判会算出 0 抽 = 极欧，纯属胡说。
 */
function luckOf(c, numbers) {
  if (!c.isUp || !c.upRounds) return null;
  const per = numbers.luckExpectPerUp;
  const tiers = numbers.luckTiers;
  if (!(per > 0) || !tiers || typeof tiers !== 'object') return null; // 配置写坏了就不标，不猜
  const ratio = c.pulls / (c.upRounds * per);
  for (const [key, t] of Object.entries(tiers)) {
    if (!t || typeof t !== 'object') continue;
    if (t.min != null && !(ratio > t.min)) continue;
    if (t.max != null && !(ratio < t.max)) continue;
    return key;
  }
  return null;
}

function charSummary() {
  const byId = new Map();
  const touch = (itemId, name) => {
    let cur = byId.get(itemId);
    if (!cur) {
      cur = {
        itemId,
        name,
        appearances: 0,
        pulls: 0,
        lastTime: 0,
        upRounds: 0,
        lostRounds: 0, // UP 角色的「歪 N 次」
        gains: [], // 逐次获得明细：{recordTime, version, total, losses[]}，供右栏 tip
        /*
         * 非 UP 角色的逐次获得来源：`{recordTime, sort, version, kind, count, upName?}`。
         *
         * 用户原话：「换行注明下它的每一影的分别来源，是常驻多少抽出的还是抽哪个 up 多少抽歪的」。
         * `kind` 三种，与真实数据来源一一对应：
         *   'perm' 常驻频段直接出（`count` = 距上一金的抽数，**不是获取成本**）
         *   'lost' 抽某个 UP 时歪出来（`count` = 那一金自己的 count）
         *   'side' 十连里跟在 UP 后面的副金（`count` 恒为 1，措辞不写抽数，见 charts.js）
         */
        sources: [],
        lostOut: 0, // 非 UP 角色的「被歪出 N 次」
        lostOutMain: 0, // 其中：作为轮内非 UP 金被歪掉
        lostOutSide: 0, // 其中：十连里跟在 UP 后面的副金
      };
      byId.set(itemId, cur);
    }
    return cur;
  };

  // ① 出现次数 / 最后获得时间：跨全部频段
  for (const channel of channelReports) {
    for (const g of channel.golds) {
      if (g.itemType !== 'ItemType_Avatar') continue;
      const cur = touch(g.itemId, g.name);
      cur.appearances += 1;
      if (g.recordTime > cur.lastTime) cur.lastTime = g.recordTime;
    }
  }

  /*
   * ② 抽数 / 歪：走轮次模型，只认有 50/50 的角色频道（独家 / 独家重映）。
   *
   * 抽数 = 该角色每一轮那一轮的 `total` 累加（含期间歪出的 + 十连副金）。
   * 这是「为了拿到这只花了多少抽」的真实成本，也能与官方总抽数闭合：
   * fixtures/baseline 19 个 UP 角色合计 2448 = 2372 + 76，一抽不差。
   */
  for (const channel of channelReports) {
    if (!channel.has5050 || channel.kind !== 'avatar') continue;
    for (const r of channel.rounds) {
      const up = touch(r.itemId, r.name);
      up.upRounds += 1;
      up.pulls += r.total;
      if (r.off > 0 || r.guar) up.lostRounds += 1;
      /*
       * 逐次获得明细：右栏 tip 一行一次获得，按时间正序排。
       *
       * `losts` 是这一轮里被歪掉的那几只（每只带自己的 count），
       * 与 `round.off` 是同一个东西的两种形态：`off` 只给总数，`losts` 给「歪了谁、多少抽」。
       * tip 必须用 `losts` 而不是 `off`——用户要的是 `77 抽歪「珂蕾妲」` 这种点名写法。
       *
       * **只写 `losts`，不写 `side`**（这条踩过）：
       * `side` 是同一发十连里跟在 UP 后面的非 UP 金，它在轮次模型里表达的是
       * **「下一轮的 50/50 已经被这一发吃掉了」**（`markGuaranteed` 的 `guar`），
       * 不是「这一轮歪了」。实测南宫羽那一轮 `losts` 空、`side` 有猫又，
       * 而 `lostRounds = 0`（它本身直出）；若把 side 写进这一行，tip 会出现
       * 「45 抽（1 抽歪「猫又」）」，与行内「歪 0 次」直接打脸。
       * 反过来维琳娜那一轮 `side` 空、`lostRounds = 1`（它的歪来自上一轮猫又那发副金），
       * tip 这一行没有歪是**对的**——那笔成本记在带出保底的那一发上，不重复计。
       * 所以 tip 行内的「歪」= 这一轮自己的 `losts`，与行内「歪 N 次」的统计口径
       * （`off > 0 || guar`）刻意不同：前者回答「这次花了多少、期间歪出谁」，
       * 后者回答「追它一共歪过几轮」，`guar` 那种轮次没有可点名的歪出记录。
       */
      up.gains.push({
        recordTime: r.recordTime,
        version: r.version,
        // sort 只用于同 recordTime 的兜底排序，tip 不显示
        sort: r.sort,
        total: r.total,
        losses: (r.losts ?? []).map((x) => ({ name: x.name, count: x.count })),
      });
      for (const x of r.losts ?? []) {
        const c = touch(x.itemId, x.name);
        c.lostOut += 1;
        c.lostOutMain += 1;
      }
      for (const x of r.side ?? []) {
        const c = touch(x.itemId, x.name);
        c.lostOut += 1;
        c.lostOutSide += 1;
      }
    }
  }

  /*
   * ③ 非 UP 角色的「每一影分别从哪来」——右栏 tip 逐行写它。
   *
   * 用户原话：「不要写『没当过 UP』，然后换行注明下它的每一影的分别来源，
   * 是常驻多少抽出的还是抽哪个 up 多少抽歪的」。
   *
   * 三个来源全部收齐（一个角色可能同时出现在多处，实测珂蕾妲 6 次里
   * 2 次常驻、4 次从不同 UP 的轮里歪出）：
   *
   *   a) `round.losts`  → kind='lost'，抽某个 UP 时歪出来的
   *   b) `round.side`   → kind='side'，十连里跟在 UP 后面的副金
   *   c) 常驻频段 golds → kind='perm'，常驻直接出
   *
   * **只认 `ItemType_Avatar`**：邦布频道里全是邦布，音擎频道里全是音擎，
   * 不筛的话「某邦布」会混进角色影画表，而且它的 count 与角色池完全不是一套语义。
   *
   * ## 闭合（构建期有断言拦着）
   *
   * `sources.length` 必须**恒等于** `appearances`：每一条获得记录都必须有且只有一条来源，
   * 否则 tip 要么少写一影、要么凭空多一影。实测 baseline 六个非 UP 角色全部闭合
   * （珂蕾妲 6/6、猫又 4/4、「11号」4/4、格莉丝 2/2、丽娜 2/2、莱卡恩 1/1）。
   *
   * 能闭合的结构性原因：非 UP 角色在角色池里的每一次出现，要么落在某一轮的 `losts`
   * （轮前的非 UP 金），要么落在 `side`（十连副金），要么在常驻频段的 golds 里——
   * 这三处覆盖了所有能产出角色的地方。口径差异（常驻的 count 是「距上一金」）不影响条数。
   */
  for (const channel of channelReports) {
    // a) 抽 UP 时歪出 + b) 十连副金：都在 has5050 的角色频道里
    if (channel.has5050 && channel.kind === 'avatar') {
      for (const r of channel.rounds) {
        for (const x of r.losts ?? []) {
          const c = touch(x.itemId, x.name);
          c.sources.push({
            kind: 'lost',
            recordTime: x.recordTime,
            sort: x.sort,
            version: x.version ?? r.version,
            count: x.count,
            upName: r.name,
          });
        }
        for (const x of r.side ?? []) {
          const c = touch(x.itemId, x.name);
          c.sources.push({
            kind: 'side',
            recordTime: x.recordTime,
            sort: x.sort,
            version: x.version ?? r.version,
            count: x.count,
            upName: r.name,
          });
        }
      }
    }
    // c) 常驻频段直接出
    if (channel.kind === 'permanent') {
      for (const g of channel.golds) {
        if (g.itemType !== 'ItemType_Avatar') continue;
        const c = touch(g.itemId, g.name);
        c.sources.push({
          kind: 'perm',
          recordTime: g.recordTime,
          sort: g.sort,
          version: g.version,
          count: g.count,
        });
      }
    }
  }

  return [...byId.values()]
    .map((x) => ({
      itemId: x.itemId,
      name: x.name,
      appearances: x.appearances,
      // 影画 = 出现次数 − 1，第 1 只给 0
      portraits: Math.max(0, x.appearances - 1),
      pulls: x.pulls,
      lastTime: x.lastTime,
      // 「UP 角色」= 在 50/50 角色频道里当过 UP
      isUp: x.upRounds > 0,
      upRounds: x.upRounds,
      lostRounds: x.lostRounds,
      /*
       * 逐次获得明细，右栏 tip 用它一行写一次获得（`本体` / `影画1` / `影画2`…）。
       *
       * 按 recordTime 正序：readrow tip 从「本体」往下读到最新一只，
       * 和游戏里看影画顺序一致。并列时用 sort 兜底（同一天两只的极端情况）。
       */
      gains: x.gains
        .slice()
        .sort((a, b) => a.recordTime - b.recordTime || (a.sort ?? 0) - (b.sort ?? 0)),
      /*
       * 非 UP 角色的逐次来源（UP 角色这里是空数组，tip 走 `gains` 那套）。
       *
       * 排序与 `gains` 同一规则：recordTime 正序，第一个是「本体」，之后影画1..N。
       * 并列时用 sort 兜底——实测「11号」有两条都落在 v2.0，recordTime 不同但版本相同，
       * 时间戳能分开；真出现同秒的极端情况靠 sort。
       */
      sources: x.sources
        .slice()
        .sort((a, b) => a.recordTime - b.recordTime || (a.sort ?? 0) - (b.sort ?? 0)),
      lostOut: x.lostOut,
      lostOutMain: x.lostOutMain,
      lostOutSide: x.lostOutSide,
      /*
       * 欧 / 非标记：档位名（euro3 / euro2 / euro1 / bad1 / bad2 / bad3）或 null。
       * 渲染层只按这个值去 numbers.luckTiers 里取 emoji/count/label，
       * 不在前端重算——阈值改了要跟着 config 走，两处各算一遍必然漂移。
       */
      luck: luckOf({ isUp: x.upRounds > 0, upRounds: x.upRounds, pulls: x.pulls }, CFG.numbers),
    }))
    .sort((a, b) => Number(b.isUp) - Number(a.isUp)
      || b.lastTime - a.lastTime
      || String(a.itemId).localeCompare(String(b.itemId)));
}

/*
 * 右栏是全局的，所以挂在 `report.charSummary` 上，不放进 `details[频道]`。
 * 放进 details 会诱使人以为它该跟着频道变。
 */
const charSummaryRows = charSummary();

/**
 * 详情条的分母：**该频道当前视图自己的最大抽数**，但不低于该频道的保底上限。
 *
 * 改前是 `numbers.detailBarDivisor = 100` 写死的固定参照——**超过 100 抽的全部封顶满宽**，
 * 于是 104 抽和 159 抽画出一样长的条（1440 实测两者都是 948.11px，十条并排时肉眼完全
 * 分不出来）。固定参照的另一个毛病是频道间不可比：同一档宽度下，9 抽的小频道和 159 抽的
 * 大频道都被压在同一个 100 上。
 *
 * 现在按「这个视图自己」定标：
 *   divisor = max(该视图所有行的最大 pulls, 该频道 channels[].pityCap)
 *
 * **为什么要 pityCap 兜底**：只取最大值时，单条记录的频道分母就等于它自己 → 必然 100% 满格。
 * 独家重映正好是这种情况（1 行 76 抽），拿 90 兜底后是 84.4%，不满格。
 * 超过保底上限的极端单行（例如只有一轮 100 抽的 90 保底频道）仍会满格——
 * 那是它的抽数真的越过了这条基准线，不是分母退化，照实画。
 *
 * **all 与 merged 各自算**，不共用：两者同一时刻只显示一个，没有并排比较的场景，
 * 而共用会让「all 最长 82 抽」把 merged 的 159 抽压成半格。用户已明确两者不必一致。
 *
 * **和主图不同轴是刻意的**，用户原话「详情条的比例不需要和上方主图保持一致，各自独立」：
 * 主图比较的是「每一轮成本」在固定 Y 轴（`numbers.axisPullsMax`）里的位置，
 * 详情条比较的是「这个频道里谁最贵」。两处各自独立定标，跨图比长度本就不是读者会做的事。
 */
function detailBarDivisor(rows, channel) {
  const maxPulls = (rows ?? []).reduce((m, r) => Math.max(m, r.pulls ?? 0), 0);
  const cap = channel?.pityCap ?? 0;
  return Math.max(maxPulls, cap) || null;
}

/*
 * 左栏每一行的「本体 / 影画N」标记：**跨全部频段按 itemId 全局编号**。
 *
 * 用户原话：「菲欧妮・本体/影画一 —— 在 up 角色后面也加下这个」。
 *
 * ## 为什么必须全局编号，不能按频道各自从 1 数
 *
 * 影画是账号级属性，而同一个角色的重复获取会散在不同频道里：实测 fixtures/baseline
 * 的珂蕾妲本体是「抽雅时歪出」（独家频道），影画1 是「常驻 6 抽」（常驻频道）。
 * 按频道各自数，常驻里那只珂蕾妲会显示「本体」，和右栏的「影画1」正面矛盾。
 * 右栏 `charSummary()` 已经是全局口径（`portraits = 跨频段出现次数 − 1`），
 * 所以左栏必须跟着它走，否则同一份报表两个地方对同一个角色说两套话。
 *
 * ## 编号来源就是右栏那份，不另写一套
 *
 * 直接用 `charSummaryRows` 的 `gains` / `sources`：它们已经按
 * `recordTime` 正序（并列用 `sort` 兜底）排好，第 1 条 = 本体，第 2 条 = 影画1。
 * **不要在左栏重新排序或重新计数**——两处各算一遍必然漂移，而且漂移的症状是
 * 「左栏说影画2、右栏说影画1」这种没人会主动去查的静默错误。
 *
 * 这里只做一件事：把「(itemId, recordTime, sort) → 第几只」建成一张索引表，
 * 让左栏每一行按自己那条记录的坐标回贴编号。坐标必须**三个字段全带上**：
 * 同一角色在同一天拿到两只的情况 `recordTime` 会相同，只按时间匹配会把两只
 * 都标成同一号（实测 multigold 有同 recordTime 的多金对）。
 *
 * ## 为什么只给角色，不给音擎 / 邦布
 *
 * 音擎重复获得是**精炼**（`ItemType_Weapon`），没有「影画」这个概念；
 * 邦布整列都是邦布，也没有影画。给它们标「本体/影画」是错的术语。
 * 判据用 `itemType === 'ItemType_Avatar'`，与 `charSummary()` 里筛角色的口径同一处。
 */
function portraitIndex() {
  const key = (itemId, recordTime, sort) => `${itemId}|${recordTime}|${sort}`;
  const idx = new Map();
  for (const c of charSummaryRows) {
    // 右栏 UP 角色用 gains，非 UP 角色用 sources——两者都是「逐次获得」，排好序的
    const list = c.isUp ? c.gains : c.sources;
    list.forEach((g, i) => {
      idx.set(key(c.itemId, g.recordTime, g.sort), i);
    });
  }
  return {
    /** 第几只（0 = 本体）。查不到返回 null——不是角色，或坐标对不上。 */
    of(itemId, recordTime, sort) {
      const i = idx.get(key(itemId, recordTime, sort));
      return i == null ? null : i;
    },
    size: idx.size,
  };
}
const portraitOf = portraitIndex();

/**
 * 给一行的「本体/影画N」文案。非角色返回 null（音擎 / 邦布不标）。
 *
 * 措辞用「本体 / 影画N」而不是「0 影 / 1 影」：用户原话就是「菲欧妮・本体/影画一」，
 * 第 1 只叫本体（游戏里也没有「0 影」这个说法），第 2 只起才是影画 1。
 */
function portraitLabel(row) {
  if (row.itemType !== 'ItemType_Avatar') return null;
  const i = portraitOf.of(row.itemId, row.recordTime, row.sort);
  return i == null ? null : (i === 0 ? '本体' : `影画${i}`);
}

const details = Object.fromEntries(
  CFG.channels.map((ch) => {
    const c = channelReports.find((x) => x.id === ch.id);
    const all = detailRows(c, false);
    const merged = detailRows(c, true);
    for (const rows of [all, merged]) {
      for (const r of rows) r.portrait = portraitLabel(r);
    }
    return [ch.id, {
      all,
      merged,
      /*
       * 分母随「当前视图」走，前端按 `d.divisor[merged ? 'merged' : 'all']` 取，
       * 不再自己算 —— 口径只在构建期算一次，`charts.js` 只负责画。
       */
      divisor: {
        all: detailBarDivisor(all, c),
        merged: detailBarDivisor(merged, c),
      },
      perGold: c.perGold,
      has5050: ch.has5050,
    }];
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
    /*
     * 这套数据是不是编的（`fixtures/` 里的开发基线）。
     *
     * 唯一消费者是 scripts/screenshot.mjs 的 `--preview`：标注为 true 的数据集
     * 出 README 头图时不再强制打码（「绳匠A」遮成「绳*****」只是难看，不保护任何人）；
     * 没有这个标记的**一律当真实数据**，仍然强制打码 + 原断言。
     *
     * 只认严格的布尔 true：`"true"` 字符串、1、缺失 都按真实处理——
     * 手写 meta.json 时最容易写成字符串，而那种错误必须往安全那边倒。
     * 前端不读这个字段，它不进任何渲染路径。
     */
    synthetic: meta.synthetic === true,
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
  /*
   * 右栏：角色维度汇总，**跨全部频段**（不跟 tab 走），只含角色。
   * 放在顶层而不是 details[频道] 里，是因为它是全局口径——
   * 放在频道下会诱使人以为它该跟着 tab 变。
   */
  charSummary: charSummaryRows,
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
   * 右栏：同一个 id 到底该用哪个目录的图标，只能看文件在不在。
   *
   * 音擎频道一个频道里就有两种金：音擎（id 在 items/）和歪出来的角色（id 在 avatars/）。
   * 邦布也是 items/。所以「按频道选一次目录」必然出错，只能逐个 id 试。
   * 两个目录都没有时不报缺失警告——占位图本来就是为这种情况准备的。
   */
  const iconKeyFor = (id) => {
    for (const dir of ['avatars', 'items']) {
      if (existsSync(join(SKILL_DIR, 'assets/report/icons', dir, `${id}.png`))) return encode(dir, id);
    }
    return encode('avatars', id);
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
  /*
   * 右栏代理人汇总的图标：**先试 avatars，再退回 items**。
   *
   * 右栏现在只收 `ItemType_Avatar`，理论上全在 avatars/ 下，直接 encode('avatars')
   * 就够。但仍然走 `iconKeyFor()` 逐个判断文件在不在，理由有两条：
   *   1) 某些头像可能只同步到了 items/（sync-icons 按接口给的 icon URL 分类，
   *      分类依据是 item_type，历史上出过 item_type 缺字段的记录）；
   *   2) 反过来，将来右栏如果重新收别的类型，这里不用再改一次。
   * 早先的坑是「按频道类型一刀切目录」：音擎频道里音擎走 items、歪出的角色走 avatars，
   * 一刀切必然让其中一类整列掉占位图（实测 14118 / 14121 报缺失）。
   * 所以这里**不按频道判断，只按单个 id 的文件是否存在**。
   */
  for (const c of report.charSummary ?? []) c.iconKey = iconKeyFor(c.itemId);
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
    // 右栏标题和「抽卡详情」并列在头部，由模板输出（不是 charts.js 画的）
    '/*__COPY_DETAIL_CHARS_TITLE__*/': CFG.copy.detailCharsTitle ?? '代理人汇总',
    '/*__COPY_MERGE_TOGGLE__*/': CFG.copy.mergeToggle ?? '真实抽数',
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
 * 右栏口径的防回归断言。
 *
 * 右栏的影画**必须**跨全部频段算：独家能歪出常驻角色，按频道分开算会少算。
 * 这条被写错一次（右栏一度跟着 tab 走），症状很隐蔽——每个 tab 单独看着都对，
 * 只有把同一个角色在两个频道的记录加起来才能发现珂蕾妲少 1 影。
 *
 * 所以断言两件事：
 *   1) 右栏里没有「一半在 50/50 频道、一半在常驻」的角色按频道分算的痕迹：
 *      凡是在常驻出现过的角色，它的 appearances 必须 > 它在任何单个频道的出现次数。
 *      （等价于「合并过了」，比直接检查代码更靠近结果。）
 *   2) 右栏只有角色：音擎 / 邦布一条都不许进。
 */
{
  const perChannelAppear = new Map();
  for (const channel of channelReports) {
    for (const g of channel.golds) {
      if (g.itemType !== 'ItemType_Avatar') continue;
      const k = `${g.itemId}@${channel.id}`;
      perChannelAppear.set(k, (perChannelAppear.get(k) ?? 0) + 1);
    }
  }
  for (const c of report.charSummary ?? []) {
    const perChannel = channelReports
      .map((ch) => perChannelAppear.get(`${c.itemId}@${ch.id}`) ?? 0);
    const maxOne = Math.max(0, ...perChannel);
    if (perChannel.filter((n) => n > 0).length > 1 && c.appearances <= maxOne) {
      fatal.push(`右栏 ${c.name} 出现 ${c.appearances} 次，但单频道最多就有 ${maxOne} 次：影画疑似按频道分开算了（必须跨全部频段合并）`);
    }
  }
  const nonAvatar = (report.charSummary ?? []).filter((c) => {
    const g = channelReports.flatMap((ch) => ch.golds).find((x) => x.itemId === c.itemId);
    return g && g.itemType !== 'ItemType_Avatar';
  });
  for (const c of nonAvatar) {
    fatal.push(`右栏含非角色条目 ${c.name}(${c.itemId})：音擎 / 邦布没有影画概念，不该进右栏`);
  }
}

/*
 * 抽数闭合断言：右栏所有 UP 角色的 pulls 之和 == 独家 + 独家重映的官方总抽数。
 *
 * 这两条断言是给「抽数口径」上的护栏。它被改错过两次：
 *   ① 一开始拿 `is_up === false` 的条数当「歪」，语义整个反了；
 *   ② 后来把抽数改成「只累加该角色自己那条 UP 记录的 count」，雅算出 230 —— 真实是 384。
 * 第 ② 种的症状极隐蔽：每个数字单看都像个合理值，只有**加起来**才暴露
 * （19 个 UP 只加到 1759，而官方是 2448，凭空少掉 689 抽全被「歪」藏走了）。
 *
 * 闭合成立的原因：这两个频道的每一抽都必然落在某一轮里（轮 = 一次 UP 获得及其前缀），
 * 所以「轮 total 累加」在数学上恒等于官方总抽数；换成别的口径就一定不等。
 *
 * 范围只取 `has5050 && kind === 'avatar'`：右栏只统计角色，UP 轮也只在这两个频道产生。
 * 音擎 / 常驻 / 邦布不参与（它们没有 UP 轮，也不该进这个和）。
 *
 * 官方口径取 `total_count − next_s_cur_times`（已抽，不含垫抽），与轮 total 天然对齐：
 * 垫抽是「还没换来金」的部分，不属于任何一轮。实测独家重映 90 − 14 = 76 = 琉音那轮 total。
 */
{
  const upChannels = channelReports.filter((c) => c.has5050 && c.kind === 'avatar');
  if (upChannels.length) {
    const official = upChannels.reduce((s, c) => s + c.effectivePulls, 0);
    const ours = (report.charSummary ?? [])
      .filter((c) => c.isUp)
      .reduce((s, c) => s + c.pulls, 0);
    if (ours !== official) {
      const names = upChannels.map((c) => c.label).join(' + ');
      fatal.push(
        `右栏 UP 角色抽数合计 ${ours} ≠ ${names} 官方已抽 ${official}：` +
        `抽数口径错了（必须是「该角色各轮 total 累加」，含期间歪出的抽，不能只取 UP 那条的 count）`,
      );
    }
    /*
     * 兜底：万一所有角色都没被认成 UP（比如 has5050 标记丢了），
     * 上面那条会因为 0 ≠ official 而报警，不会静默通过。这里再显式挡一次
     * 「官方有抽数但一个 UP 轮都没有」——那种情况说明轮次模型根本没跑起来。
     */
    const roundCount = upChannels.reduce((s, c) => s + c.rounds.length, 0);
    if (roundCount === 0 && official > 0) {
      fatal.push(`右栏 ${names} 官方有 ${official} 抽，但一轮都没解析出来：轮次模型没跑起来`);
    }
  }
}

/*
 * 详情条分母断言：防「分母退化」与「不同抽数画出同样长度」。
 *
 * 分母是详情条唯一的量值来源，写错了不会报错、只会静默把长条压成一样长
 * （改前 `/100` 就是这个症状：1440 独家 merged 里 104 抽和 159 抽都是 948.11px）。
 * 三条检查：
 *
 * ① **分母必须 ≥ 该视图最长行的 pulls。** 小于它就意味着有行超出 100%，
 *    前端 `Math.min(1, …)` 会把它悄悄截成满格，两条不同的抽数画出一样的长度。
 * ② **分母必须 ≥ 该频道 pityCap。** 这是「单条记录的频道不许必然满格」那条口径的
 *    实现方式：独家重映只有 1 行 76 抽，若分母退化成 76，它就恒为 100%。
 * ③ **同一视图里 pulls 不同的两行，条宽必须能区分。** 用和前端完全相同的公式复算
 *    `max(minPx, (轨道宽−34) × pct)`，同一档宽度下若有两条不同 pulls 落到同一个像素值，
 *    说明它们都被 44px 保底吃掉了——那是保底的正常行为，**但不同 pulls 必须来自保底**
 *    （都在 44px 时才允许相等），不能是分母算错导致的封顶。
 *
 * 这里只算**逻辑比例**（不含轨道宽），所以用「比例值」而不是像素：
 * 比例相同且都不是保底钳制 → 报错。
 */
{
  const minPx = CFG.numbers.detailBarMinPx;
  if (!(minPx > 0)) {
    fatal.push(`numbers.detailBarMinPx(${minPx}) 不是正数：详情条会塌成 0 宽`);
  }
  for (const ch of CFG.channels) {
    const c = channelReports.find((x) => x.id === ch.id);
    if (!c) continue;
    const d = details[ch.id];
    if (!d) {
      fatal.push(`频道 ${ch.label} 没有 details 条目：详情面板会空白`);
      continue;
    }
    for (const mode of ['all', 'merged']) {
      const rows = d[mode];
      const divisor = d.divisor?.[mode];
      if (!rows.length) continue;
      if (!(divisor > 0)) {
        fatal.push(`频道 ${ch.label} 的 ${mode} 视图分母 ${divisor} 不是正数：条宽无法计算`);
        continue;
      }
      const maxPulls = rows.reduce((m, r) => Math.max(m, r.pulls ?? 0), 0);
      if (divisor < maxPulls) {
        fatal.push(
          `频道 ${ch.label} 的 ${mode} 视图分母 ${divisor} < 最长行 ${maxPulls} 抽：` +
          '超出的行会被截成满格，不同抽数画出同样长度',
        );
      }
      if (ch.pityCap != null && divisor < ch.pityCap) {
        fatal.push(
          `频道 ${ch.label} 的 ${mode} 视图分母 ${divisor} < pityCap ${ch.pityCap}：` +
          '单条记录的频道会必然满格（分母退化）',
        );
      }
      /*
       * 比例去重：同一比例值上出现**不同 pulls** 就是「不同抽数画成一样长」。
       * 允许相等的情形只有一种——两行都被 minPx 保底钳制，此时比例不生效。
       * 判断方法：该行的原始条宽 `(轨道−34) × pct` 是否小到连 minPx 都不到。
       * 轨道宽未知（随视口变），所以用 1440 的实测轨道 982.1 做参照：
       * 只要 `(982.1−34) × pct < minPx`，这一行在 1440 就是保底钳制的。
       */
      const REF_TRACK = 982.1; // 1440 实测 .detail-track 宽
      const clamped = (pct) => (REF_TRACK - 34) * pct < minPx;
      const seen = new Map();
      for (const r of rows) {
        const pct = Math.max(0, Math.min(1, (r.pulls ?? 0) / divisor));
        const key = pct.toFixed(6);
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push({ name: r.name, pulls: r.pulls, clamped: clamped(pct) });
      }
      for (const [, group] of seen) {
        const pulls = new Set(group.map((g) => g.pulls));
        if (pulls.size <= 1) continue;
        if (group.every((g) => g.clamped)) continue; // 全被保底钳制，长度相同是刻意的
        const names = group.map((g) => `${g.name} ${g.pulls}抽`).join('、');
        fatal.push(
          `频道 ${ch.label} 的 ${mode} 视图有不同抽数却同条宽：${names}` +
          `（都算成 ${group[0].pulls} 抽 / 分母 ${divisor} 的比例）`,
        );
      }
    }
  }
}

/*
 * 右栏 tip 明细断言（`gains`）：防的是「tip 与行内数字互相打脸」。
 *
 * 两条独立校验：
 *
 * ① **`Σgains[].total` 必须等于行内 `pulls`。**
 *    tip 一次获得一行，全部加起来就是行内那个总数；不等说明有获得漏进/漏出了 gains
 *    （比如 side 被当成了独立一轮，或某轮的 total 被重复计）。
 *
 * ② **`losses` 里不许出现「十连副金」造成的歪。**
 *    判定方法：某轮 `losses` 有理，但该轮其实是 `guar`（歪来自上一轮带出的保底）而不是
 *    `off > 0`（本轮自己歪），就会出现「tip 说歪了、行内 lostRounds 却没算它」。
 *    实测反例：南宫羽 `side` 有猫又但 `off = 0`、`lostRounds = 0`；
 *    若把 side 掺进 losses，tip 会写「45 抽（1 抽歪「猫又」）」而行内那一格是空的。
 *    这里用「同一角色 Σ(有 losses 的轮数) ≤ lostRounds」来兜：
 *    `guar` 轮自己没有任何 losts，所以只要有人把 side 掺进来，这个不等式立刻被打破。
 */
{
  for (const c of report.charSummary ?? []) {
    if (!c.isUp) continue;
    const gains = c.gains ?? [];
    const sum = gains.reduce((s, g) => s + (g.total ?? 0), 0);
    if (sum !== c.pulls) {
      fatal.push(
        `右栏 ${c.name} 的 tip 明细合计 ${sum} 抽 ≠ 行内 ${c.pulls} 抽：` +
        `gains 有遗漏或重复（每次获得必须恰好一条，且 total 之和等于 pulls）`,
      );
    }
    const withLoss = gains.filter((g) => (g.losses ?? []).length > 0).length;
    if (withLoss > c.lostRounds) {
      fatal.push(
        `右栏 ${c.name} 有 ${withLoss} 次获得在 tip 里写了歪出明细，但它只有 ${c.lostRounds} 轮歪：` +
        `疑似把十连副金（round.side）混进了 losses——side 的语义是「下一轮的保底已被吃掉」，不是这一轮歪`,
      );
    }
  }
}

/*
 * 非 UP 角色 tip 来源断言（`sources`）：防「tip 少写一影 / 多写一影」。
 *
 * 右栏 tip 对非 UP 角色是**逐影列举**（本体：… / 影画1：…），所以条数必须正好等于影画数 + 1。
 * 少一条 tip 就少一行、多一条就凭空多一影；两种都不会报错，只会安静地显示错内容。
 *
 * 为什么这条断言值得存在：`sources` 来自三处（轮 losts / 轮 side / 常驻 golds），
 * 任何一处漏遍历（比如忘了常驻频道、或者 side 的 recordTime 没补上导致排序错）
 * 都会让某个角色的条数对不上。而 `appearances` 是另一条独立路径数出来的
 * （跨全部频段数 avatar 金），拿它当标尺正好能抓到这类漏洞。
 *
 * 注意**不能拿 `portraits` 当标尺**：portraits = appearances − 1，用它反推等于
 * 把两个本就该独立的量绑在一起，断言会退化成「sources = sources」。
 */
{
  for (const c of report.charSummary ?? []) {
    if (c.isUp) continue;
    const n = (c.sources ?? []).length;
    if (n !== c.appearances) {
      const kinds = (c.sources ?? []).map((s) => s.kind).join(',') || '（空）';
      fatal.push(
        `右栏 ${c.name} 的来源 ${n} 条 ≠ 出现 ${c.appearances} 次：` +
        `tip 会少写或多写影画（来源明细：${kinds}）。` +
        '三处来源必须全覆盖——轮 losts / 轮 side / 常驻 golds，且只收 ItemType_Avatar',
      );
    }
  }
}

/*
 * 左栏「本体 / 影画N」标记断言：防「左右两栏对同一个角色说两套话」。
 *
 * 三条独立校验：
 *
 * ① **左栏每一行的 `portrait` 必须等于右栏同一 itemId 那一条的编号。**
 *    编号是从 `charSummary().gains/sources` 建表回贴的，正常情况恒等；
 *    一旦有人把左栏改成「按频道从 1 数」，这条立刻全线失败（实测会报出几十条）。
 *    这条断言的存在意义就是：左栏编号一旦漂移，**构建就挂**，而不是安静地显示错内容。
 *
 * ② **左栏某 itemId 的最高编号 == 右栏该角色的 `portraits`。**
 *    例：蕾米埃尔 2 影 → 左栏最高必须是「影画2」。这条是①的独立补刀——
 *    ① 只证明「查表查到了」，②证明「表里装的东西本身对」。
 *
 * ③ **音擎 / 邦布行不许有标记。** 术语错误：音擎重复是精炼、邦布没有影画。
 *
 * 编号查不到（null）也当失败：那意味着某个角色行在右栏里找不到对应记录，
 * 渲染出来 tip 第一行就光秃秃一个名字，用户以为漏了。
 */
{
  const byId = new Map((report.charSummary ?? []).map((c) => [c.itemId, c]));
  const maxSeen = new Map(); // itemId → 左栏见过的最高编号
  let mismatch = 0;
  let nonAvatarMarked = 0;
  const mismatchSamples = [];

  for (const ch of CFG.channels) {
    const d = details[ch.id];
    if (!d) continue;
    for (const mode of ['all', 'merged']) {
      for (const r of d[mode] ?? []) {
        const isAvatar = r.itemType === 'ItemType_Avatar';
        if (!isAvatar) {
          if (r.portrait != null) nonAvatarMarked += 1;
          continue;
        }
        if (r.portrait == null) {
          mismatch += 1;
          if (mismatchSamples.length < 5) mismatchSamples.push(`${ch.label}/${mode} ${r.name} 编号查不到`);
          continue;
        }
        const sum = byId.get(r.itemId);
        if (!sum) {
          mismatch += 1;
          if (mismatchSamples.length < 5) mismatchSamples.push(`${ch.label}/${mode} ${r.name} 右栏没有这个角色`);
          continue;
        }
        // 右栏这一条记录是第几只
        const list = sum.isUp ? (sum.gains ?? []) : (sum.sources ?? []);
        const i = list.findIndex((g) => g.recordTime === r.recordTime && (g.sort ?? 0) === (r.sort ?? 0));
        const expect = i < 0 ? null : (i === 0 ? '本体' : `影画${i}`);
        if (expect !== r.portrait) {
          mismatch += 1;
          if (mismatchSamples.length < 5) {
            mismatchSamples.push(`${ch.label}/${mode} ${r.name}: 左栏「${r.portrait}」≠ 右栏「${expect ?? '查不到'}」`);
          }
          continue;
        }
        const n = i;
        if (!maxSeen.has(r.itemId) || n > maxSeen.get(r.itemId)) maxSeen.set(r.itemId, n);
      }
    }
  }

  if (mismatch > 0) {
    fatal.push(
      `左栏「本体/影画N」与右栏对不上 ${mismatch} 行：${mismatchSamples.join('；')}。` +
      '编号必须从 charSummary 的 gains/sources 回贴，不许在左栏按频道各自从 1 数',
    );
  }
  let portraitMismatch = 0;
  const portraitSamples = [];
  for (const [itemId, n] of maxSeen) {
    const c = byId.get(itemId);
    if (!c) continue;
    if (n !== c.portraits) {
      portraitMismatch += 1;
      if (portraitSamples.length < 5) {
        portraitSamples.push(`${c.name}: 左栏最高影画${n}，右栏 portraits=${c.portraits}`);
      }
    }
  }
  if (portraitMismatch > 0) {
    fatal.push(
      `左栏最高影画编号与右栏 portraits 不一致 ${portraitMismatch} 个角色：${portraitSamples.join('；')}。` +
      '两栏必须用同一份全局编号（跨全部频段、按获得时间排序）',
    );
  }
  if (nonAvatarMarked > 0) {
    fatal.push(
      `有 ${nonAvatarMarked} 行音擎 / 邦布被标了「本体/影画」：` +
      '音擎重复是精炼、邦布没有影画，这些行不许有该标记',
    );
  }
}

/*
 * 右栏欧非标记断言：防「标记与行内数字互相打脸」。
 *
 * ① **只许 UP 角色有标记。** 非 UP 角色没有抽数，标了就是 0 抽 = 极欧的胡说。
 * ② **标记必须与行内数字自洽。** 逐行用 `pulls / (upRounds × luckExpectPerUp)`
 *    复算倍率、再独立落一次档，与 `luck` 对不上说明判定用错了字段
 *    （比如还在拿 pulls / upRounds 去比阈值，那是已作废的旧口径）。
 * ③ **档位表必须真从 config 读、且是一张单调阶梯。** 三个检查：
 *    a) luckExpectPerUp 是正数；
 *    b) 每档都有 emoji / 正整数 count / 非空 label（渲染层直接用它，缺了就是空标记）；
 *    c) 档位覆盖互不重叠、边界严格递增——上界写反（比如 euro1 的 max 也写成 0.6）
 *       会静默让一整档角色消失，光靠「标记数看起来正常」发现不了。
 */
{
  const rows = report.charSummary ?? [];
  const num = CFG.numbers;
  const tiers = num.luckTiers;
  const per = num.luckExpectPerUp;

  if (!(per > 0)) {
    fatal.push(`numbers.luckExpectPerUp(${per}) 不是正数：算不出期望抽数`);
  }
  if (!tiers || typeof tiers !== 'object' || !Object.keys(tiers).length) {
    fatal.push('numbers.luckTiers 缺失或为空：右栏标记没有档位可落');
  } else {
    let edge = -Infinity;
    for (const [key, t] of Object.entries(tiers)) {
      if (!t || typeof t !== 'object') {
        fatal.push(`numbers.luckTiers.${key} 不是对象`);
        continue;
      }
      if (!t.emoji) fatal.push(`numbers.luckTiers.${key} 缺 emoji：渲染层会生成空标记`);
      if (!(Number.isInteger(t.count) && t.count > 0)) {
        fatal.push(`numbers.luckTiers.${key}.count(${t.count}) 必须是正整数`);
      }
      if (!t.label) fatal.push(`numbers.luckTiers.${key} 缺 label：aria-label 会空`);
      /*
       * 区间必须单调递增、**不许重叠**。`min` 缺省表示「从负无穷开始」（只允许第一档），
       * `max` 缺省表示「到正无穷为止」（只允许最后一档）。
       *
       * 注意**允许留空隙**：euro1 上界 0.85 与 bad1 下界 1.15 之间那一段就是刻意留空的平档，
       * 「不标」正是要的效果。所以这里只拦 `min < 上一档 max`（重叠会让后一档永远落不到），
       * 不要求首尾相接——第一版断言按「必须相接」写，直接把这份合法配置判成了致命错误。
       */
      const lo = t.min ?? -Infinity;
      const hi = t.max ?? Infinity;
      if (!(lo < hi)) {
        fatal.push(`numbers.luckTiers.${key} 区间无效：[${lo}, ${hi})`);
      } else if (t.min != null && t.min < edge) {
        fatal.push(
          `numbers.luckTiers.${key}.min(${t.min}) 小于上一档的上界(${edge})：区间重叠，` +
          '后一档永远落不到，那一档的角色会静默消失',
        );
      }
      edge = hi;
    }
  }

  if (per > 0 && tiers) {
    for (const c of rows) {
      if (!c.isUp && c.luck) {
        fatal.push(`右栏 ${c.name} 不是 UP 角色却有欧非标记 ${c.luck}：非 UP 没有抽数，不该判`);
      }
      if (!c.isUp) continue;
      const expect = c.upRounds * per;
      const ratio = c.pulls / expect;
      let want = null;
      for (const [key, t] of Object.entries(tiers)) {
        if (!t || typeof t !== 'object') continue;
        if (t.min != null && !(ratio > t.min)) continue;
        if (t.max != null && !(ratio < t.max)) continue;
        want = key;
        break;
      }
      if (c.luck !== want) {
        fatal.push(
          `右栏 ${c.name} 实抽 ${c.pulls} / 期望 ${expect}（${c.upRounds} 只 × ${per}）` +
          ` = 倍率 ${ratio.toFixed(3)}，应落 ${want ?? '平档'}，实际 ${c.luck ?? '平档'}：判定口径与行内数字不一致`,
        );
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
