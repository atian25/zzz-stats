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
import { buildReport } from '../lib/index.mjs';

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
/*
 * 报表渲染器就在 skill 里（`lib/build.mjs`），它自己按
 * `SKILL_DIR = resolve(HERE, '..')` 定位模板 / charts / icons / vendor，
 * 所以这里**不需要**再算一整套资源路径。
 *
 * 与采集层相反：`packages/sdk/` 的 `collectData()` 必须由调用方传 `cfg`，
 * 因为它跟 skill 目录已经分离；渲染器没搬，照旧自己读。
 */
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



// ---------------------------------------------------------------- 读磁盘 → 虚拟文件系统

/*
 * core 不认识磁盘，只认识 `{ 'index.json': ..., 'cur_pool_stat_2.json': ... }`。
 * 这一段就是「把目录读成那个 map」，是 Node 外壳区别于浏览器外壳的唯一一处。
 *
 * 读四类文件：index / meta / 每个频道的 cur 与 hist。
 * 缺文件**不在这里报错**：`meta.json` 本来就可选，某个频道没记录也是合法的
 * （音擎回响常常只有垫抽）。真正「一份都没有」的判定交给 core 之后的 index 检查 ——
 * 那条判定要给出「先跑采集」的提示，属于外壳语义。
 */
/*
 * 频道的 cur/hist 文件名要按**配置里的频道**去读，不能只读「目录里存在的那几个」：
 * core 拿不到某个频道的 hist 文件时会当成「该频道没有金」，而这个账号其实可能有。
 * 反过来也不行 —— 目录里有、配置里没有的文件没人读。所以以 CFG.channels 为准。
 */
function readFilesFromDisk() {
  const files = {};
  const put = (name) => {
    const p = join(DATA_DIR, name);
    if (existsSync(p)) files[name] = JSON.parse(readFileSync(p, 'utf8'));
  };
  put('index.json');
  put('meta.json');
  for (const ch of CFG.channels) {
    put(`cur_pool_stat_${ch.id}.json`);
    put(`hist_pool_stat_${ch.id}.json`);
  }
  return files;
}

const files = readFilesFromDisk();
if (!files['index.json']) {
  console.error(`找不到 ${join(DATA_DIR, 'index.json')}。先跑采集步骤（数据落到 output/<账号名>/data/），或用 --data 指定数据集目录。`);
  process.exit(1);
}

/*
 * 构建内核在 `lib/build.mjs`（口径 + 模板装配 + 校验），本文件只是薄壳：
 * 解析参数 → 把磁盘目录读成虚拟文件系统 → 调内核 → 写文件 → 打摘要 → 退出码。
 *
 * 内核**不写盘也不退出**（见 lib/build.mjs 文件头）：写不写、往哪写、失败怎么退，
 * 都是外壳的决定。这里保持改前的行为一字不变：fatal 时打印 ✖ 并 exit 1、不写产物。
 */
const built = buildReport({
  files,
  cfg: CFG,
  /*
   * 图标缺失的告警必须打出来（缺图标会退到占位图，是设计好的降级，但要让人知道）。
   * 内核不直接 console.warn，改由调用方决定去处 —— 服务里该进日志，CLI 里就该进 stderr。
   */
  logWarn: (m) => console.warn(m),
});
const { html, report, metrics, tags, warnings, fatal, icons } = built;

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
for (const w of warnings) console.warn(`  ⚠️  ${w}`);
process.exit(0);
