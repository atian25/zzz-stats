#!/usr/bin/env node
/**
 * 报表截图 —— 开发期验收专用。
 *
 * 为什么单独成脚本：
 *   开发期要看的是「本地 output/report.html 在 1440×900 和 1280×800 下装不装得下」，
 *   和采集期「找一个能扫码登录的浏览器」是两件完全不同的事。
 *   以前没有这个脚本，每个 agent 都要现拼 Chrome 命令行，
 *   并且一定会踩 --user-data-dir 的坑（不带就起不来），白绕几分钟。
 *
 * 用法：
 *   node scripts/screenshot.mjs                       # 两档尺寸，输出到 docs/shots/
 *   node scripts/screenshot.mjs --width 1440 --height 900
 *   node scripts/screenshot.mjs --out-dir /tmp/shots --html output/report.html
 *   node scripts/screenshot.mjs --privacy 2           # 截图前先点全打码（对外用）
 *   node scripts/screenshot.mjs --preview             # README 预览图 → docs/preview.png（整页 2x，强制打码）
 *   node scripts/screenshot.mjs --chart 音擎 --filter 2
 *   node scripts/screenshot.mjs --detail 独家重映     # 切底部详情面板的频段
 *
 * 只依赖本机 Chrome，不需要 Playwright，不联网。
 * 浏览器查找复用 drivers.mjs 的 findChrome()，与采集期同一份候选列表。
 */
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { findChrome, chromeArgs } from './drivers.mjs';
import { wantsHelp, printHelp, WORK_DIR_NOTE } from './cli-help.mjs';

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
      { flag: '--html <file>', desc: '要截的报表。不传时在 output/ 下找唯一的 report-*.html；有多份会报错' },
      { flag: '--out-dir <dir>', desc: '截图落点，默认 docs/shots' },
      { flag: '--width <n> --height <n>', desc: '只截一个尺寸（两个都要给）' },
      { flag: '--privacy <0|1|2>', desc: '先把眼睛按钮点到 N：0 全显示 / 1 打码 UID / 2 全打码' },
      { flag: '--chart <名>', desc: '切到指定主图频段 tab（如 音擎）' },
      { flag: '--filter <档>', desc: '只留指定版本档位（如 2；多个用 1,2）' },
      { flag: '--detail <名>', desc: '切底部详情面板的频段 tab（如 独家重映）' },
      { flag: '--collapse', desc: '收起主图，让详情面板进首屏' },
      { flag: '--preview', desc: '出 README 头图：整页 2x，强制打码到 2 并断言' },
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
 * 产物按数据集分名（`output/report-<数据集名>.html`），`output/report.html` 已废弃，
 * 所以这里不能再写死那个文件名——写死的话 `--preview` 一跑就是「找不到 output/report.html」。
 * 现在按顺序找：
 *   1) `--html` 显式指定，优先；
 *   2) `output/` 下恰好一份 `report-*.html` → 用它（单数据集项目不用写参数）；
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
  const outDir = HTML_SEARCH_DIR;
  const candidates = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => /^report-.*\.html$/.test(f)).map((f) => join(outDir, f))
    : [];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    console.error(`${relative(WORK_DIR, outDir)}/ 下有 ${candidates.length} 份报表，用 --html 指定要截哪一份：`);
    for (const p of candidates) console.error(`  node skills/zzz-stats/scripts/screenshot.mjs --html ${relative(WORK_DIR, p)}`);
    process.exit(1);
  }
  return abs('output/report.html');
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
 * --preview         产出 README 用的整页预览图（默认 docs/preview.png）
 * --out-file 路径   配合 --preview 指定输出文件
 *
 * 为什么单独一个模式：README 那张图要的是「整页长图 + 2x 高清」，
 * 跟 §9.3 的两档视口验收图（1x、只看首屏装不装得下）是两个用途。
 * 以前这张图是手工截的、随仓库带一份，于是代码一路改、图一直停在初始化那版——
 * 折线还是黄的、图例还带「黄线＝累计不歪率」、右轴还是 60%。让它跟得上，只能由脚本出。
 */
const PREVIEW = args.includes('--preview');
const OUT_FILE = abs(argOf('out-file', 'docs/preview.png'));
/*
 * 宽度 1440 与验收图一致（看到的排版就是用户看到的），DPR 2 让文字在高分屏不发虚。
 * 高度由整页截图自己算，这里的 900 只保证首帧有视口。
 */
const PREVIEW_WIDTH = 1440;
const PREVIEW_DPR = 2;

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
 * 预览图**强制**打码到 2，不接受用 --privacy 覆盖。
 * README 是对外公开的，这张图从默认的全显示状态直接截就等于把真名和 UID 贴到互联网上；
 * report-rules.md §2 把这条定成硬约束，已经因为同一件事踩过两次。
 */
const EFFECTIVE_PRIVACY = PREVIEW ? 2 : PRIVACY;
writeFileSync(pageFile, withState(readFileSync(HTML, 'utf8'), { privacy: EFFECTIVE_PRIVACY, chartLabel: CHART, filters: FILTER, detailLabel: DETAIL, collapse: COLLAPSE }), 'utf8');

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
       * 打码硬断言：对外发的图在截图**之前**确认真的盖住了。
       *
       * report-rules.md §2 把这条定成硬约束，理由是踩过两次——README 的预览图
       * 连着两版把真名和 UID 截进了公开仓库，而打码版一旦推送就再也收不回来
       * （`git show <旧commit>:docs/preview.png` 永远取得到）。
       * 脚本原来只负责点击、不负责验证，等于把「点没点中」交给运气。
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
        const nickOk = !!g && g.nick.includes('*');
        const uidOk = !!g && /\*/.test(g.uid);
        if (!g || g.eye !== '2' || !nickOk || !uidOk) {
          failed += 1;
          console.error(`  ✗ 打码断言没过（eye=${g?.eye} nick=${JSON.stringify(g?.nick)} uid=${JSON.stringify(g?.uid)}）`);
          console.error('    对外图不允许带真名/真 UID，已中止，未写文件。');
          continue;
        }
      }

      /*
       * 预览图要整页：README 展示的是「首屏主图 + 第二屏详情」的完整效果。
       * captureBeyondViewport 让 Page.captureScreenshot 越过视口去截，
       * 再用 clip 把高度收到 scrollHeight —— 不收的话会因为滚动容差多出空白带。
       */
      let clip;
      if (PREVIEW) {
        const dim = await cdp.send('Runtime.evaluate', {
          expression: 'JSON.stringify({ w: document.documentElement.clientWidth, h: document.documentElement.scrollHeight })',
          returnByValue: true,
        }, sessionId).catch(() => null);
        let d = null;
        try { d = dim?.result?.value ? JSON.parse(dim.result.value) : null; } catch { /* ignore */ }
        if (!d) {
          failed += 1;
          console.error('  ✗ 拿不到页面高度，整页截图会截不完整，中止');
          continue;
        }
        clip = { x: 0, y: 0, width: d.w, height: d.h, scale: 1 };
      }

      const shot = await cdp.send('Page.captureScreenshot',
        PREVIEW ? { format: 'png', captureBeyondViewport: true, clip } : { format: 'png' },
        sessionId);
      writeFileSync(out, Buffer.from(shot.data, 'base64'));

      let vw = null;
      try { vw = vp?.result?.value ? JSON.parse(vp.result.value) : null; } catch { /* ignore */ }

      if (existsSync(out)) {
        /*
         * 预览图记 dpr=2、高度记 null：整页图的高度由页面内容决定，
         * 拿标称 900 去比对必然「不符」，那是自检写错了，不是图错了。
         */
        written.push({
          path: out, width, height, innerWidth: vw?.w ?? null,
          dpr: PREVIEW ? PREVIEW_DPR : 1, fullPage: PREVIEW,
        });
        console.log(`✓ ${name}${vw ? `（页面视口 ${vw.w}×${vw.h}）` : ''}`);
        /*
         * 视口与标称不符就是真 bug，直接判失败。
         * 这正是旧实现栽的坑：图截出来了、尺寸也对，但内容是按另一个宽度渲染的。
         */
        if (vw && vw.w !== width) {
          failed += 1;
          console.error(`  ✗ 视口是 ${vw.w}，标称 ${width}——CDP 设备模拟没生效`);
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
 * 预览图是整页 2x 图，规则不同：宽 = 标称 × DPR、高由内容决定（只要 ≥ 视口就行）。
 * 拿标称高度去比会永远「不符」，那是自检写错了。
 */
console.log(PREVIEW ? '\n自检：' : '\n自检（需要人眼确认「首屏无滚动、图例单行」）：');
for (const f of written) {
  const buf = readFileSync(f.path);
  // PNG IHDR：宽高在第 16~24 字节，大端 32 位
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const dpr = f.dpr ?? 1;
  const wantW = f.width * dpr;
  const ok = f.fullPage ? w === wantW && h >= f.height : w === f.width && h === f.height;
  const vw = f.innerWidth == null ? '' : ` · 页面视口 ${f.innerWidth}`;
  const vwOk = f.innerWidth == null || f.innerWidth === f.width;
  const label = f.fullPage ? `${f.width} @${dpr}x 整页` : `${f.width}x${f.height}`;
  console.log(`  ${label} → 实际 ${w}x${h}${vw}${ok && vwOk ? '' : '  ⚠️ 不符'}`);
}
process.exit(failed ? 1 : 0);
