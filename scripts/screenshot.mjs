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
 *   node scripts/screenshot.mjs --chart 音擎 --filter 2
 *   node scripts/screenshot.mjs --detail 复刻角色     # 切底部详情面板的频段
 *
 * 只依赖本机 Chrome，不需要 Playwright，不联网。
 * 浏览器查找复用 drivers.mjs 的 findChrome()，与采集期同一份候选列表。
 */
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { findChrome, chromeArgs } from './drivers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

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

const abs = (p) => (isAbsolute(p) ? p : resolve(ROOT, p));
const HTML = abs(argOf('html', 'output/report.html'));
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
 * --detail 复刻角色     切底部「抽卡详情」面板的频段 tab（按 .detail-tab 的文字匹配）
 *
 * 和 --chart 分开：主图只画有 50/50 且折出过 UP 的频道（独家/音擎/复刻），
 * 详情面板要覆盖全部 6 个频段（含常驻/邦布/复刻音擎）。两者能点的 tab 不是同一批，
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

/**
 * 两档尺寸来自 references/report-rules.md §9.3：
 * 1440×900 与 1280×800 都必须「首屏无滚动、图例单行」。
 */
const TARGETS = SINGLE_W && SINGLE_H
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
    // 详情面板的 tab 遍布全部 6 个频段，文字是「复刻角色」这种短名，同样先精确后包含
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
writeFileSync(pageFile, withState(readFileSync(HTML, 'utf8'), { privacy: PRIVACY, chartLabel: CHART, filters: FILTER, detailLabel: DETAIL, collapse: COLLAPSE }), 'utf8');

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
    const name = `report-${width}x${height}.png`;
    const out = join(OUT_DIR, name);
    const profileDir = join(tmpDir, `profile-${width}`);
    mkdirSync(profileDir, { recursive: true });

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
       * 真视口。deviceScaleFactor 固定 1（出 1x 图，尺寸与标称一致），
       * mobile: false —— 传 true 会让 Chrome 按移动端缩放，innerWidth 变成 ~658，
       * 又回到「假宽度」的老问题上。
       */
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
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

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(out, Buffer.from(shot.data, 'base64'));

      let vw = null;
      try { vw = vp?.result?.value ? JSON.parse(vp.result.value) : null; } catch { /* ignore */ }

      if (existsSync(out)) {
        written.push({ path: out, width, height, innerWidth: vw?.w ?? null });
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
 */
console.log('\n自检（需要人眼确认「首屏无滚动、图例单行」）：');
for (const f of written) {
  const buf = readFileSync(f.path);
  // PNG IHDR：宽高在第 16~24 字节，大端 32 位
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const ok = w === f.width && h === f.height;
  const vw = f.innerWidth == null ? '' : ` · 页面视口 ${f.innerWidth}`;
  const vwOk = f.innerWidth == null || f.innerWidth === f.width;
  console.log(`  ${f.width}x${f.height} → 实际 ${w}x${h}${vw}${ok && vwOk ? '' : '  ⚠️ 不符'}`);
}
process.exit(failed ? 1 : 0);
