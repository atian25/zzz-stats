#!/usr/bin/env node
/**
 * 报表截图 —— 开发期验收专用。
 *
 * 为什么单独成脚本：
 *   开发期要看的是「本地 output/<账号名>/report.html 在 1440×900 和 1280×800 下装不装得下」，
 *   和采集期「找一个能扫码登录的浏览器」是两件完全不同的事。
 *   以前没有这个脚本，每个 agent 都要现拼 Chrome 命令行，
 *   并且一定会踩 --user-data-dir 的坑（不带就起不来），白绕几分钟。
 *
 * 用法：
 *   node skills/zzz-stats/scripts/screenshot.mjs                       # 两档尺寸，输出到 docs/shots/
 *   node skills/zzz-stats/scripts/screenshot.mjs --width 1440 --height 900
 *   node skills/zzz-stats/scripts/screenshot.mjs --out-dir /tmp/shots --html output/<账号名>/report.html
 *   node skills/zzz-stats/scripts/screenshot.mjs --privacy 2           # 截图前先点全打码（对外用）
 *   node skills/zzz-stats/scripts/screenshot.mjs --preview             # README 预览图 → docs/preview.png（固定高度 2x）
 *                                                                      # 真实数据强制打码；meta.synthetic === true 的数据集不打码
 *   node skills/zzz-stats/scripts/screenshot.mjs --chart 音擎 --filter 2
 *   node skills/zzz-stats/scripts/screenshot.mjs --detail 独家重映     # 切底部详情面板的频段
 *   node skills/zzz-stats/scripts/screenshot.mjs --preview --preview-height 1200
 *                                                                      # 覆盖预览图的固定高度（不传就是 1200）
 *
 * 只依赖本机 Chrome，不需要 Playwright，不联网。
 * 浏览器查找复用 drivers.mjs 的 findChrome()，与采集期同一份候选列表。
 */
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { findChrome, chromeArgs } from './drivers.mjs';
import { wantsHelp, printHelp, WORK_DIR_NOTE } from './cli-help.mjs';
import { listOutputReports } from './datasets.mjs';
import { extractReport, previewPrivacyPolicy, checkPreviewGuard } from './preview-privacy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/*
 * 两个根目录，跟 build-report.mjs 一致：
 *   SKILL_DIR：skill 本体，只读（这个脚本只用它定位自身，不读资产）
 *   WORK_DIR：用户工作目录，`--cwd` 优先，否则 `process.cwd()`
 * 报表产物和截图都相对 WORK_DIR 算——截图截的是用户项目里的那份 HTML。
 */
if (wantsHelp()) {
  printHelp('screenshot', {
    summary: '给本地报表截图（验收用两档尺寸 / 对外用的 README 头图）',
    options: [
      { flag: '--html <file>', desc: '要截的报表。不传时找 output/<账号名>/report.html，只有一份就用；有多份会报错' },
      { flag: '--out-dir <dir>', desc: '截图落点，默认 docs/shots' },
      { flag: '--width <n> --height <n>', desc: '只截一个尺寸（两个都要给）' },
      { flag: '--privacy <0|1|2>', desc: '先把眼睛按钮点到 N：0 全显示 / 1 打码 UID / 2 全打码' },
      { flag: '--chart <名>', desc: '切到指定主图频段 tab（如 音擎）' },
      { flag: '--filter <档>', desc: '只留指定版本档位（如 2；多个用 1,2）' },
      { flag: '--detail <名>', desc: '切底部详情面板的频段 tab（如 独家重映）' },
      { flag: '--preview-height <n>', desc: '预览图的固定高度（逻辑 px，默认 1200）；自动吸附到离它最近的不切半行位置' },
      { flag: '--collapse', desc: '收起主图，让详情面板进首屏' },
      { flag: '--preview', desc: '出 README 头图：固定高度 2x；真实数据强制打码到 2 并断言，meta.synthetic 为 true 的数据集不打码' },
      { flag: '--out-file <file>', desc: '配合 --preview 指定输出，默认 docs/preview.png' },
      { flag: '--cwd <dir>', desc: '用户工作目录，默认当前目录' },
      { flag: '--help, -h', desc: '打印本帮助后退出，不启动浏览器' },
    ],
    notes: [WORK_DIR_NOTE],
  });
}

const SKILL_DIR = resolve(HERE, '..');

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) {
    const v = args[i + 1];
    // 同时支持 --name value 与 --name=value：早期脚本只认前者，传等号会被静默忽略
    if (v && !v.startsWith('--')) return v;
  }
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return def;
};

const WORK_DIR = resolve(argOf('cwd', process.cwd()));

const abs = (p) => (isAbsolute(p) ? p : resolve(WORK_DIR, p));
/*
 * 默认截哪份产物。
 *
 * 产物结构是 `output/<账号名>/report.html`，一个账号一个目录。
 * 找法：
 *   1) `--html` 显式指定，优先；
 *   2) `output/<账号名>/report.html` 恰好一份 → 用它（单账号项目不用写参数）；
 *   3) 有多份 → 报错退出，不猜（截错账号的图比失败更糟，README 头图是对外公开的）。
 *
 * **找报表的目录固定是 WORK_DIR/output，不受 `--out-dir` 影响。**
 * `--out-dir` 只表示「截图往哪写」。早期这里复用了 `--out-dir` 去找报表，
 * 于是 `--out-dir /tmp/x` 会同时改变「从哪读报表」和「往哪写截图」两件事——
 * 用户只想换输出位置，却连输入都换了，属于一个参数担两个语义。
 */
const HTML_SEARCH_DIR = abs('output');
function pickHtml() {
  const explicit = argOf('html', null);
  if (explicit) return abs(explicit);
  const candidates = listOutputReports(WORK_DIR);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    console.error(`${relative(WORK_DIR, HTML_SEARCH_DIR)}/ 下有 ${candidates.length} 份报表，用 --html 指定要截哪一份：`);
    for (const p of candidates) console.error(`  node skills/zzz-stats/scripts/screenshot.mjs --html ${relative(WORK_DIR, p)}`);
    process.exit(1);
  }
  // 一份都没有：报一句「先构建」，不要猜一个不存在的路径
  console.error(`找不到报表：${relative(WORK_DIR, HTML_SEARCH_DIR)}/<账号名>/report.html 一个都没有。`);
  console.error('  → 先跑 node skills/zzz-stats/scripts/build-report.mjs，或用 --html 指定文件。');
  process.exit(1);
}
const HTML = pickHtml();
/** 截图落点。跟「从哪读报表」无关，读报表固定看 WORK_DIR/output。 */
const OUT_DIR = abs(argOf('out-dir', 'docs/shots'));
const SINGLE_W = argOf('width', null);
const SINGLE_H = argOf('height', null);
const PRIVACY = argOf('privacy', null);
/*
 * --chart weapon        切到音擎频段（按 .chart-tab 的文字匹配）
 * --filter 2            只留 2.x（可重复用逗号写多个：--filter 1,2）
 *
 * 这两个是给验收「主图频段 tab」和「版本过滤」用的。没有参数时截的是默认状态。
 * 交互必须排在 init() 之后触发，否则拿到的是未初始化的空图。
 */
const CHART = argOf('chart', null);
const FILTER = argOf('filter', null);
/*
 * --detail 独家重映     切底部「抽卡详情」面板的频段 tab（按 .detail-tab 的文字匹配）
 *
 * 和 --chart 分开：主图只画有 50/50 且折出过 UP 的频道（独家 / 音擎 / 独家重映），
 * 详情面板要覆盖全部 6 个频段（含常驻/邦布/音擎回响）。两者能点的 tab 不是同一批，
 * 所以必须两个参数，不能共用一个。
 */
const DETAIL = argOf('detail', null);
/*
 * --collapse        收起主图，让底部「抽卡详情」面板进入首屏
 *
 * 详情面板在 1440×900 的折叠线以下，不收起主图就只能截到它的 tab 栏、看不到内容。
 * 用报表自己的收起按钮（#collapse-chart），不是改样式——改样式会截到一个真实用户看不到的布局。
 */
const COLLAPSE = args.includes('--collapse');

if (!existsSync(HTML)) {
  console.error(`找不到 ${HTML}。先跑 node scripts/build-report.mjs。`);
  process.exit(1);
}

const chrome = findChrome();
if (!chrome) {
  console.error('没有找到本机 Chrome。装一个，或用 CHROME_PATH=/path/to/chrome 指定。');
  process.exit(1);
}

/*
 * --preview         产出 README 用的预览图（默认 docs/preview.png）
 * --out-file 路径   配合 --preview 指定输出文件
 * --preview-height  预览图的固定高度（逻辑 px），默认 1200
 *
 * 为什么单独一个模式：README 那张图要的是「高清 + 尺寸可控」，
 * 跟 §9.3 的两档视口验收图（1x、只看首屏装不装得下）是两个用途。
 * 以前这张图是手工截的、随仓库带一份，于是代码一路改、图一直停在初始化那版——
 * 折线还是黄的、图例还带「黄线＝累计不歪率」、右轴还是 60%。让它跟得上，只能由脚本出。
 */
const PREVIEW = args.includes('--preview');
const OUT_FILE = abs(argOf('out-file', 'docs/preview.png'));
/*
 * 宽度 1440 与验收图一致（看到的排版就是用户看到的），DPR 2 让文字在高分屏不发虚。
 */
const PREVIEW_WIDTH = 1440;
const PREVIEW_DPR = 2;

/*
 * --preview-height <n>   预览图的**固定高度**（逻辑 px），默认 1200。
 *
 * ## 为什么是「固定高度截图」而不是「过滤掉后面的内容」
 *
 * 这里踩过一次方向错误。用户原话两条，说的是同一件事：
 *   1)「README 的截图，抽卡详情那部分不要截太长，2 个版本够了」
 *   2)「抽卡详情和代理人汇总都是按固定高度截图即可，不是让你过滤抽卡详情」
 *
 * 第一版把要求理解成「隐藏后面的版本组」（`--detail-versions`），那是**改内容**：
 * 图里只剩 2 个组，右栏还完整留着 25 行，两栏被强行修成不同深度。
 * 用户要的是**内容全在、只是截到固定高度就停**——超出部分天然不在图里，
 * 两栏受同一高度约束，谁超出谁被裁。所以那套过滤逻辑整个删掉了，不留两套机制。
 *
 * ## 页面本身不定高
 *
 * 用户早前明确说过「不要定高吧，抽卡详情多的话就直接在页面下面，方便滚动截图」，
 * 所以**只改截图范围，不动 `.detail-body` / `.detail-list` 的 CSS**。
 *
 * ## 自动吸附到「不切半行」的位置（上下都试）
 *
 * 硬切在某个像素上很可能把一行切成两半（截图里出现只有上半截的字）。
 * 所以实际高度会在名义高度之上找最近的一个**安全切口**：
 * 从名义值开始往下逐像素试，直到没有任何 `.detail-row` / `.detail-char` /
 * `.detail-group` 横跨这一条线（即切点落在行与行、组与组的间隙里）。
 *
 * 优先吸附到**版本组的底边**：组的最后一行底边正好是干净的断点，
 * 图末不会出现「组还没结束就断了」的观感。找不到再退回任意行间隙。
 *
 * ## 量几何前必须确认视口高 == 截图视口高
 *
 * 行盒坐标全由排版决定，而排版随**视口高**变化（首屏 `.screen` 是 `calc(100vh - 26px)`）：
 * 同一份产物，视口 1000 时整页 2271、视口 900 时 2171，行边界整体位移。
 * 拿另一个视口下的坐标来判断 900 视口该切在哪，会得出完全错误的结论
 * （实测过：用 1000 的坐标判断，会以为「两栏没有共同安全切点」，其实 900 下 1191 就是干净的）。
 * 所以量几何前显式断言 `window.innerHeight === TARGETS` 的 height，不等就中止。
 *
 * ## 没有安全切口时中止，不静默按名义值截
 *
 * 「找不到就不吸附、按名义值截」是真实半行的来源：它会安静地出一张切了半行的图。
 * 宁可不出图也不要出一张坏图，所以这种情况直接判失败、不写文件。
 */

/**
 * 辅助函数：`--preview` 下「页面自报视口」与标称尺寸不符时判失败。
 *
 * 为什么不能只比宽度：预览图的高度是**固定**的，它由吸附算出来，
 * 而吸附依赖行盒坐标——那些坐标又依赖视口高。宽度对了、高度不对，
 * 图会「尺寸看着对、切点却是按另一个排版算的」，比截错更难发现。
 */
function viewportMismatch(vp, wantW, wantH, { checkHeight }) {
  if (!vp) return null;
  if (vp.w !== wantW) return `视口宽是 ${vp.w}，标称 ${wantW}——CDP 设备模拟没生效`;
  if (checkHeight && wantH != null && vp.h !== wantH) {
    return `视口高是 ${vp.h}，标称 ${wantH}——排版会因此位移，几何不可用`;
  }
  return null;
}
const PREVIEW_HEIGHT_RAW = argOf('preview-height', null);
const PREVIEW_HEIGHT = (() => {
  if (PREVIEW_HEIGHT_RAW != null && PREVIEW_HEIGHT_RAW !== '') {
    const n = Number(PREVIEW_HEIGHT_RAW);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`--preview-height 要给一个正数，收到的是 ${JSON.stringify(PREVIEW_HEIGHT_RAW)}`);
      process.exit(1);
    }
    return Math.floor(n);
  }
  return 1200;
})();

/**
 * 两档尺寸来自 references/report-rules.md §9.3：
 * 1440×900 与 1280×800 都必须「首屏无滚动、图例单行」。
 */
const TARGETS = PREVIEW
  ? [{ width: PREVIEW_WIDTH, height: 900 }]
  : SINGLE_W && SINGLE_H
    ? [{ width: Number(SINGLE_W), height: Number(SINGLE_H) }]
    : [{ width: 1440, height: 900 }, { width: 1280, height: 800 }];

mkdirSync(OUT_DIR, { recursive: true });

/**
 * 截图前的页面状态注入。
 *
 * 三件事共用一段注入脚本（一次改完再渲染，避免多次 click 之间的中间态被截到）：
 *   1. --privacy N  把眼睛按钮点到 N（0 全显示 → 1 打码 UID → 2 全打码）。对外截图必须先到 2。
 *   2. --chart 名称 切到指定频段 tab（按按钮文字匹配，不按顺序，避免顺序变了就点错）
 *   3. --filter 1,2 只留这些主版本档位
 *
 * 为什么用注入点击而不是改内部变量：charts.js 里的 privacy / chartState 都是闭包内变量，
 * 外部拿不到，只能走报表自己支持的公开交互（按钮）。
 *
 * 时机：全部排在 init() 之后。charts.js 在 readyState === 'loading' 时挂 DOMContentLoaded，
 * 否则立即 init，所以这里统一等 DOMContentLoaded + setTimeout(0)。
 * 点太早会拿到未初始化的空图——这不是猜测，是踩过的。
 */
function withState(srcHtml, { privacy, chartLabel, filters, detailLabel, collapse }) {
  const n = privacy == null ? 0 : Math.max(0, Math.min(2, Number(privacy)));
  const wantsChart = chartLabel != null && chartLabel !== '';
  const wantsFilter = filters != null && filters !== '';
  const wantsDetail = detailLabel != null && detailLabel !== '';
  if (!n && !wantsChart && !wantsFilter && !wantsDetail && !collapse) return srcHtml;

  const inject = `<script>
(function () {
  function act() {
    ${n ? `var eye = document.getElementById('eye');
    for (var i = 0; i < ${n}; i += 1) if (eye) eye.click();` : ''}
    ${wantsChart ? `var tabs = [].slice.call(document.querySelectorAll('.chart-tab'));
    var want = ${JSON.stringify(String(chartLabel))};
    // 先按完整文字精确匹配，退化成包含匹配（按钮文字是「独家频段」这种带后缀的）
    var tab = tabs.filter(function (t) { return t.textContent.trim() === want; })[0]
           || tabs.filter(function (t) { return t.textContent.indexOf(want) >= 0; })[0];
    if (tab) tab.click();` : ''}
    ${wantsFilter ? `var majors = ${JSON.stringify(String(filters))}.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    // chip 默认是全选中的，所以这里要「点掉不要的」而不是「点亮要的」。
    // 直接点目标档位会把它关掉，截出来正好是反的。
    [].slice.call(document.querySelectorAll('.chip')).forEach(function (chip) {
      var on = chip.getAttribute('aria-pressed') === 'true';
      var want = majors.indexOf(chip.dataset.major) >= 0;
      if (on !== want) chip.click();
    });` : ''}
    ${wantsDetail ? `var dtabs = [].slice.call(document.querySelectorAll('.detail-tab'));
    var dwant = ${JSON.stringify(String(detailLabel))};
    // 详情面板的 tab 遍布全部 6 个频段，文字是「独家重映」这种短名，同样先精确后包含
    var dtab = dtabs.filter(function (t) { return t.textContent.trim() === dwant; })[0]
            || dtabs.filter(function (t) { return t.textContent.indexOf(dwant) >= 0; })[0];
    if (dtab) dtab.click();` : ''}
    ${collapse ? `var col = document.getElementById('collapse-chart');
    if (col) col.click();` : ''}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(act, 0); });
  else setTimeout(act, 0);
})();
</script>`;
  /*
   * 必须插在**最后一个** </body> 之前。
   *
   * 报表把 ECharts 源码内联进了 HTML，那段源码的字符串里本身就含有 "</body>"
   * （实测产物有 2 个匹配，第一个落在 echarts 内部）。
   * 用 replace() 会命中第一个，等于把注入脚本塞进 echarts 源码中间——
   * 表现为图表整块变白，报错却完全不指向真正原因。
   */
  const at = srcHtml.lastIndexOf('</body>');
  if (at < 0) return srcHtml;
  return srcHtml.slice(0, at) + `${inject}\n` + srcHtml.slice(at);
}

const tmpDir = join(tmpdir(), `zzz-shot-${randomBytes(4).toString('hex')}`);
mkdirSync(tmpDir, { recursive: true });
const pageFile = join(tmpDir, 'report.html');
/*
 * 预览图的隐私策略：**按数据集来源分流**，判据只有一个——产物里 `report.meta.synthetic === true`。
 *
 * 这段历史必须留着，改之前先读懂：
 *   - README 的预览图连着两版把真名和真 UID 截进了公开仓库，事后才发现。
 *     于是 `--preview` 被定成**无条件**强制打码到 2，截图前再断言 `#nick` / `#uid` 都含 `*`，
 *     断言不过就中止、不写文件。那道断言是对的，**不能拆**。
 *   - 但它对 `fixtures/` 里的假数据没有意义。`fixtures/baseline` 是「绳匠A / 10000001」，
 *     本来就是编的，遮成「绳*****」只是让预览图变难看，还掩盖真实排版（用户原话：
 *     「github 截图没更新，既然是模拟名字的话，就不用打星号了」）。
 *
 * 所以现在分两条路，**都在脚本里断言，不是「记得点两下」**：
 *   synthetic === true  → 不点眼睛（保持状态 0），断言反着来：昵称/UID 里**不含** `*`；
 *   其余（含字段缺失）  → 维持原样：强制 2，断言 `*` 必须在。
 *
 * 判定逻辑在 preview-privacy.mjs（纯函数，可对着假数据测，见 test-preview-privacy.mjs）。
 * **没有标记一律当真实数据**：不猜、不按 UID 长度或昵称形状推断——
 * 猜错一次就是真名进公开仓库，而「忘了写标记」只会让图难看一点。
 */
const previewPolicy = PREVIEW
  ? previewPrivacyPolicy(extractReport(readFileSync(HTML, 'utf8')))
  : null;
const EFFECTIVE_PRIVACY = PREVIEW ? previewPolicy.privacy : PRIVACY;

if (PREVIEW) {
  console.log(`预览图隐私：${previewPolicy.reason} → 眼睛点到 ${EFFECTIVE_PRIVACY}`
    + `，断言「${previewPolicy.expectMasked ? '已打码（必须含 *）' : '未打码（不许含 *）'}」`);
}
if (PREVIEW) {
  console.log(`预览图高度：名义 ${PREVIEW_HEIGHT} 逻辑 px`
    + `${PREVIEW_HEIGHT_RAW == null ? '（默认）' : '（显式 --preview-height）'}`
    + '，两栏共用同一高度；实际值会吸附到离它最近的不切半行位置（上下都试）');
}
writeFileSync(pageFile, withState(readFileSync(HTML, 'utf8'), {
  privacy: EFFECTIVE_PRIVACY,
  chartLabel: CHART,
  filters: FILTER,
  detailLabel: DETAIL,
  collapse: COLLAPSE,
}), 'utf8');

/*
 * 截图一律走 CDP 设备模拟，不再用 `--screenshot` + `--window-size`。
 *
 * **为什么换掉**：Chrome headless 的 `--window-size` 有 500px 最小宽度。
 * 传 `--width 390`，页面拿到的其实是 `innerWidth = 500`：
 *
 *   window=390 → innerWidth=500  bodyScrollW=658
 *   window=500 → innerWidth=500  bodyScrollW=658
 *
 * 也就是「390 宽」那张图从来不是真机宽度，是 500px 视口渲染完按 390 裁掉右边——
 * 右边被裁的地方刚好是过滤条，于是「窄屏过滤条点不到」看起来像是 CSS 的锅，
 * 实际一半是这个假视口造成的。名不副实的图比截不出来更糟：它会让人去改本来没坏的地方。
 *
 * 现在用 `Emulation.setDeviceMetricsOverride` 显式设视口，任意宽度都是真的。
 * 不再需要 Node 内置 WebSocket 之外的东西（Node ≥ 22 自带 WebSocket）。
 */

/** 起一个带 --remote-debugging-port 的 headless Chrome，返回 {proc, wsUrl, close}。 */
async function launchChrome(port, profileDir) {
  const proc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    /*
     * --user-data-dir 必须带。
     * 不带的话 Chrome 会去抢默认 profile，headless 下直接失败退出，
     * 报错还只说「Failed to move to new namespace」之类，看不出根因。
     */
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    // CDP 会自己设视口，这里的 window-size 只保证浏览器窗口别太小
    '--window-size=1600,1000',
    ...chromeArgs(),
    'about:blank',
  ], { stdio: 'ignore' });

  /*
   * 端口就绪要轮询：Chrome 起得慢，硬编码 sleep 在高负载机器上会不稳。
   * 最多等 12s（60 × 200ms），超时就报错退出，别静默截一张空白图。
   */
  let wsUrl = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(200);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
    } catch { /* 还没起来，继续等 */ }
  }
  if (!wsUrl) {
    proc.kill('SIGKILL');
    throw new Error('Chrome 调试端口没起来（12s 超时）');
  }
  return { proc, wsUrl };
}

/** 极简 CDP 客户端：只实现 send + 事件等待。 */
function cdpConnect(wsUrl) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('open', () => {
      resolveConn({
        send(method, params = {}, sessionId) {
          return new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        close() { try { ws.close(); } catch { /* ignore */ } },
      });
    });
    ws.addEventListener('error', () => rejectConn(new Error('CDP WebSocket 连接失败')));
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m.id || !pending.has(m.id)) return;
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(`${m.error.message} (${m.error.code})`));
      else res(m.result);
    });
  });
}

const written = [];
let failed = 0;

/*
 * 端口从 9400 起递增，撞了就换下一个。
 * 固定端口在并行跑两份数据集时会互相抢占，报错还只是一句「连不上」。
 */
let basePort = 9400;
const chromeProc = { current: null };
const chromeWs = { current: null };

try {
  for (const { width, height } of TARGETS) {
    const name = PREVIEW ? 'preview.png' : `report-${width}x${height}.png`;
    const out = PREVIEW ? OUT_FILE : join(OUT_DIR, name);
    const profileDir = join(tmpDir, `profile-${width}`);
    mkdirSync(profileDir, { recursive: true });
    if (PREVIEW) mkdirSync(dirname(out), { recursive: true });

    /* 每个尺寸一个独立浏览器实例：设备模拟是会话级的，复用会串状态。 */
    const port = basePort;
    basePort += 1;
    const { proc, wsUrl } = await launchChrome(port, profileDir);
    const cdp = await cdpConnect(wsUrl);
    chromeProc.current = proc;
    chromeWs.current = cdp;

    try {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

      /*
       * 真视口。验收图用 deviceScaleFactor 1（出 1x 图，尺寸与标称一致）；
       * 预览图用 2 —— README 在高分屏上显示，1x 字会发虚。
       * mobile: false —— 传 true 会让 Chrome 按移动端缩放，innerWidth 变成 ~658，
       * 又回到「假宽度」的老问题上。
       */
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: PREVIEW ? PREVIEW_DPR : 1, mobile: false,
      }, sessionId);

      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Page.navigate', { url: `file://${pageFile}` }, sessionId);
      /*
       * 等渲染完：图表用 SVG renderer、图标是内嵌 data URL，
       * 但字体排版和 ECharts 首帧要一点时间。3s 与旧的 --virtual-time-budget 对齐。
       */
      await sleep(3000);

      /* 从页面自己报视口，作为「这张图是不是真宽度」的硬证据 */
      const vp = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })',
        returnByValue: true,
      }, sessionId).catch(() => null);

      /*
       * 打码硬断言：对外发的图在截图**之前**确认隐私状态真的对上了。
       *
       * 两条分支的期待相反，都由 preview-privacy.mjs 的 checkPreviewGuard() 判定：
       *   - 真实数据：必须已经遮住（`*` 必须在），这是踩过两次的那条硬约束；
       *   - synthetic 数据：必须没遮（`*` 不许在），且昵称/UID 不能是空——空说明页面没渲染出来。
       *
       * 为什么两边都要断言、而不是「模拟数据就放松一下」：
       * 放松成「不管」的话，一次 CSS/JS 事故把页面渲染成空白、或者把 synthetic 判错，
       * 就没人看得出来了。断言反着写，两种事故都会当场中止。
       *
       * 宁可不出图，也不出一张带真名的图：断言不过直接中止，不写文件。
       */
      if (PREVIEW) {
        const guard = await cdp.send('Runtime.evaluate', {
          expression: `JSON.stringify({
            eye: document.getElementById('eye')?.dataset.state ?? null,
            nick: document.getElementById('nick')?.textContent ?? '',
            uid: document.getElementById('uid')?.textContent ?? '',
          })`,
          returnByValue: true,
        }, sessionId).catch(() => null);
        let g = null;
        try { g = guard?.result?.value ? JSON.parse(guard.result.value) : null; } catch { /* ignore */ }
        const verdict = checkPreviewGuard(previewPolicy, g);
        if (!verdict.ok) {
          failed += 1;
          console.error(`  ✗ 隐私断言没过（${verdict.why}）`);
          console.error('    真实数据不允许带真名/真 UID，synthetic 数据不允许被误遮，已中止，未写文件。');
          continue;
        }
        console.log(`  ✓ 隐私断言：eye=${g.eye} nick=${JSON.stringify(g.nick)} uid=${JSON.stringify(g.uid)}`);
      }

      /*
       * 预览图按**固定高度**截，不再整页截。
       *
       * captureBeyondViewport 让 Page.captureScreenshot 越过视口去截，
       * 再由 clip 把范围收成「宽 = 页面宽、高 = 吸附后的固定高度」。
       *
       * **高度不是硬切名义值**：页面里量一遍所有行 / 版本组的边界，
       * 把切点吸附到最近的安全间隙（没有任何行横跨它），
       * 这样图末不会出现「半行字」。
       *
       * 量几何**必须先确认视口高 == 截图视口高**（排版随视口高变），
       * 量不到几何 / 选择器量到空 / 上下都没有安全切口时一律中止，不按名义值硬截。
       */
      let clip;
      let appliedHeight = null;
      let snap = null;
      if (PREVIEW) {
        /*
         * 量几何之前先确认视口就是截图视口。
         *
         * 行盒坐标是排版的产物，而排版随视口高变化（首屏 `.screen` = `calc(100vh - 26px)`）：
         * 同一份产物视口 1000 时整页 2271、视口 900 时 2171，行边界整体位移。
         * 拿错视口的坐标去判断切点会得出完全相反的结论——真实踩过：按 1000 的坐标量，
         * 会以为「两栏没有共同安全切点」，但 900 下 1191 本来就是干净的。
         *
         * 所以这里和上面校验宽度一样，把高度也当成硬条件：不等就中止，不拿错坐标去吸附。
         */
        const vpNow = (() => {
          try { return vp?.result?.value ? JSON.parse(vp.result.value) : null; } catch { return null; }
        })();
        const mismatch = viewportMismatch(vpNow, width, height, { checkHeight: true });
        if (mismatch) {
          failed += 1;
          console.error(`  ✗ ${mismatch}`);
          console.error('    几何必须按截图用的视口量，否则切点算在另一套排版上，已中止，未写文件。');
          continue;
        }
        const geom = await cdp.send('Runtime.evaluate', {
          expression: `JSON.stringify((() => {
            const q = (s) => [].slice.call(document.querySelectorAll(s));
            const bottom = (el) => { const r = el.getBoundingClientRect(); return r.bottom + window.scrollY; };
            const rng = (el) => {
              const r = el.getBoundingClientRect();
              return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY };
            };
            return {
              w: document.documentElement.clientWidth,
              docH: document.documentElement.scrollHeight,
              /* 两栏的行区间**分开收集**（top/bottom 都要）：行高不同（左 26 / 右 34），
                 底边交集实测为空，所以安全切口必须落在「两栏都不横跨」的位置 */
              left: q('#detail-list .detail-row').map(rng),
              right: q('#detail-chars-fill .detail-char').map(rng),
              /* 组底边优先：切在组与组之间，图末不会像「组没结束」 */
              groupBottoms: q('#detail-list .detail-group').map(bottom),
            };
          })())`,
          returnByValue: true,
        }, sessionId).catch(() => null);
        let g = null;
        try { g = geom?.result?.value ? JSON.parse(geom.result.value) : null; } catch { /* ignore */ }
        if (!g) {
          failed += 1;
          console.error('  ✗ 拿不到页面几何，无法保证「不切半行」，中止');
          continue;
        }
        /*
         * 选择器失效（改了类名 / 详情区还没渲染）时几何是空的，
         * 空数组会让 `safeAt()` 恒真——**任何**高度都「安全」，吸附看起来成功了，
         * 实际却可能把某一栏切在半行上。这和拿不到几何一样致命，一起中止。
         */
        if (!g.left.length || !g.right.length) {
          failed += 1;
          console.error(`  ✗ 行盒选择器没量到内容（左 ${g.left.length} 行 / 右 ${g.right.length} 行），中止`);
          console.error('    空数组会让「不跨行」恒成立，吸附会静默失准；选择器或渲染时机变了。');
          continue;
        }

        /*
         * 找安全切口：**两栏都必须完整**。
         *
         * 左栏行高 26、右栏行高 34，两栏行底边的**交集实测为空**——不存在天然对齐两栏的高度。
         * 所以不能「取两栏各自最近底边的较小值」（那个值可能正好横跨另一栏的某一行：
         * 实测 1189 是左栏组底边，但它切在右栏 1157~1191 那行的中间）。
         *
         * 正确做法是**逐行校验**：从名义高度往下试，第一个满足
         * 「没有任何左栏行 / 右栏行横跨它」的像素就是答案。
         *
         * 优先在这个答案之上找**版本组底边**（组结束处最自然，图末不像「组没结束」）；
         * 只有在它同样满足两栏不跨行时才采用。
         */
        const crosses = (H, list) => list.some((r) => H > r.top + 0.01 && H < r.bottom - 0.01);
        const safeAt = (H) => !crosses(H, g.left) && !crosses(H, g.right);
        const ceiling = Math.min(PREVIEW_HEIGHT, g.docH);

        /*
         * 找**离名义高度最近**的安全切口，不是只会往下掉。
         *
         * 上一步只向下找，结果 `--preview-height 1400` 会一路掉到 1191
         * （因为 1191~1400 之间确实没有安全值），离名义值差了 209px——
         * 用户显式传 1400 却得到 1191 会以为参数没生效。
         * 实测这份数据离 1400 最近的安全值是 1429（差 29px），明显更符合预期。
         *
         * 所以先向下、再向上各找一遍，取距离更近的；距离相同优先取小的
         * （宁可少显示一点，也别让图比用户要的高）。
         * **向上不设 ceiling 上限**：`--preview-height 1400` 实测最近的安全值是 1429
         * （向下最远只能到 1191、差 209px，向上 1429 只差 29px）。
         * 名义值只是「离它最近的参考点」，不是硬上限——否则显式传 1400 会得到 1191，
         * 用户以为参数没生效。差多少由下面的组底边优先级再收敛一次。
         */
        let down = Math.floor(ceiling);
        while (down > 0 && !safeAt(down)) down -= 1;
        let up = Math.ceil(ceiling);
        while (up <= g.docH && !safeAt(up)) up += 1;

        const downOk = down > 0;
        const upOk = up <= g.docH;
        let pickH;
        if (downOk && upOk) pickH = (ceiling - down) <= (up - ceiling) ? down : up;
        else if (downOk) pickH = down;
        else if (upOk) pickH = up;
        else pickH = Math.floor(ceiling);

        /*
         * 版本组底边优先：找离 ceiling 最近、且两栏不跨行的组底边。
         *
         * 组底边是**左栏**的组边界，天然落在左栏行间；关键是它也必须不跨右栏的行。
         * 候选只取 `<= ceiling` 的：组底边是「更自然但更矮」的选项，让它越过名义值去
         * 和向上吸附抢位置没有意义（那会为了一个组边界把图拉得比安全间隙更长）。
         * 只有它**不比 pickH 更远**时才采用——即组底边足够接近名义值，才值得为观感让步。
         */
        let bestGroup = null;
        for (const gb of g.groupBottoms) {
          const v = Math.round(gb);
          if (v > ceiling) continue;
          if (!safeAt(v)) continue;
          if (bestGroup == null || Math.abs(v - ceiling) < Math.abs(bestGroup - ceiling)) bestGroup = v;
        }

        if (bestGroup != null && Math.abs(bestGroup - ceiling) <= Math.abs(pickH - ceiling)) {
          appliedHeight = bestGroup;
          snap = '版本组底边';
        } else if (downOk || upOk) {
          appliedHeight = pickH;
          snap = pickH <= ceiling ? '名义高度下方最近空隙' : '名义高度上方最近空隙';
        } else {
          /*
           * 上下都没找到安全切口：**不许静默按名义值截**。
           *
           * 这是真实的半行来源——旧实现会打一行「名义值（没找到安全切口）」照样出图，
           * 图末就可能是半行字，而且没有任何东西会拦住它（自检只比尺寸，尺寸永远对）。
           * 宁可不出图也不要出一张坏图：判失败、不写文件。
           */
          failed += 1;
          console.error(`  ✗ 名义高度 ${PREVIEW_HEIGHT} 上下都找不到「两栏都不跨行」的切口，中止`);
          console.error(`    行盒：左 ${g.left.length} 行 / 右 ${g.right.length} 行，整页 ${g.docH}；`
            + '详情区没渲染或选择器变了？不按名义值硬截（会切出半行）。');
          continue;
        }

        /* 内容比名义高度还短时按整页收，别在底部截出一片空白 */
        appliedHeight = Math.min(appliedHeight, g.docH);
        clip = { x: 0, y: 0, width: g.w, height: appliedHeight, scale: 1 };
        console.log(`  · 固定高度：名义 ${PREVIEW_HEIGHT} → 实际 ${appliedHeight}（吸附到${snap}，页面整页 ${g.docH}）`);
      }

      const shot = await cdp.send('Page.captureScreenshot',
        PREVIEW ? { format: 'png', captureBeyondViewport: true, clip } : { format: 'png' },
        sessionId);
      writeFileSync(out, Buffer.from(shot.data, 'base64'));

      let vw = null;
      try { vw = vp?.result?.value ? JSON.parse(vp.result.value) : null; } catch { /* ignore */ }

      if (existsSync(out)) {
        /*
         * 预览图记一个**固定高度**（吸附后的实际值），自检就能像验收图那样精确比对
         * 「图高 == 逻辑高 × DPR」。改前整页截图时高度是页面内容决定的，
         * 只能退化成 `h >= 名义高` 的弱检查。
         */
        written.push({
          path: out,
          width,
          height: PREVIEW ? appliedHeight : height,
          innerWidth: vw?.w ?? null,
          innerHeight: vw?.h ?? null,
          wantViewportHeight: PREVIEW ? height : null,
          dpr: PREVIEW ? PREVIEW_DPR : 1,
          fixedHeight: PREVIEW,
        });
        console.log(`✓ ${name}${vw ? `（页面视口 ${vw.w}×${vw.h}）` : ''}`);
        /*
         * 视口与标称不符就是真 bug，直接判失败。
         * 这正是旧实现栽的坑：图截出来了、尺寸也对，但内容是按另一个宽度渲染的。
         *
         * 预览图额外校验**高度**：它的固定高度是量几何算出来的，而几何随视口高位移
         * （实测同一份产物 1000 视口整页 2271、900 视口 2171）。高度不对就说明
         * 这份几何算在另一套排版上——尺寸依然「看着对」，切点却是错的。
         */
        const mismatch = viewportMismatch(vw, width, height, { checkHeight: PREVIEW });
        if (mismatch) {
          failed += 1;
          console.error(`  ✗ ${mismatch}`);
        }
      } else {
        failed += 1;
        console.error(`✗ ${name}（没写出文件）`);
      }
    } finally {
      chromeWs.current?.close();
      chromeProc.current?.kill('SIGKILL');
      chromeWs.current = null;
      chromeProc.current = null;
    }
  }
} finally {
  /* 兜底：异常路径上也要把浏览器收掉，别留孤儿进程 */
  chromeWs.current?.close();
  chromeProc.current?.kill('SIGKILL');
  sleep(150);
  rmSync(tmpDir, { recursive: true, force: true });
}

if (!written.length) {
  console.error('一张都没截出来。');
  process.exit(1);
}


for (const f of written) console.log(`  ${f.path}`);
if (failed) console.error(`${failed} 档失败`);

/*
 * 尺寸自检：图片尺寸 + 页面自报视口，两个都要对。
 * 「首屏无滚动」要靠人眼确认，脚本只能把图交出来——
 * 但图片尺寸和页面视口都必须等于标称值，否则截出来的是名不副实的图。
 * 后者才是真坑：headless 的 --window-size 有 500px 下限，
 * 早先「390 宽」的图其实是 500 视口裁出来的（见上方 CDP 注释）。
 *
 * 预览图是固定高度 2x 图：宽 = 标称 × DPR、高 = 吸附后的逻辑高 × DPR，
 * 两个都精确比（吸附算错、DPR 没生效都会露出来）。它同时要求页面视口**高**
 * 等于标称视口高——吸附用的行盒坐标来自那个视口，视口换了坐标就作废。
 */
console.log(PREVIEW ? '\n自检：' : '\n自检（需要人眼确认「首屏无滚动、图例单行」）：');
for (const f of written) {
  const buf = readFileSync(f.path);
  // PNG IHDR：宽高在第 16~24 字节，大端 32 位
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const dpr = f.dpr ?? 1;
  const wantW = f.width * dpr;
  const wantH = f.height * dpr;
  /*
   * 预览图现在是**固定高度**，所以和验收图一样精确比对（宽高都要对上）。
   * 精确比对是有意义的：吸附算错了、DPR 没生效，都会在这里露出来。
   */
  const ok = f.fixedHeight ? w === wantW && h === wantH : w === f.width && h === f.height;
  const vp = f.innerWidth == null
    ? ''
    : ` · 页面视口 ${f.innerWidth}${f.innerHeight == null ? '' : `×${f.innerHeight}`}`;
  const vwOk = f.innerWidth == null || f.innerWidth === f.width;
  const vhOk = f.wantViewportHeight == null || f.innerHeight == null
    || f.innerHeight === f.wantViewportHeight;
  const label = f.fixedHeight ? `${f.width} @${dpr}x 固定高 ${f.height}` : `${f.width}x${f.height}`;
  console.log(`  ${label} → 实际 ${w}x${h}${vp}${ok && vwOk && vhOk ? '' : '  ⚠️ 不符'}`);
}
process.exit(failed ? 1 : 0);
