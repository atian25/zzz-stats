#!/usr/bin/env node
/**
 * 浏览器外壳的端到端验收：等价性 + 渲染 + console 干净。
 *
 * ## 为什么这条必须是真浏览器
 *
 * 「core.js 在浏览器里算出的 report 与 Node 端逐字段相同」这件事，用 Node 测不出来：
 * Node 里 import 的是同一个文件，但**加载路径不同**（浏览器要过 <script type=module>、
 * 要 fetch config.json、要用 manifest 查图标 key）。这三个环节任何一个坏了，
 * Node 端都毫无反应，浏览器端则静默退化成空页面或占位图。
 *
 * ## 断言
 *
 *   A. 等价性：浏览器算出的 report 与 Node 产物内嵌的那个逐字段相同。
 *      唯一允许的差异：`icons` 的**值**（Node = dataURL，浏览器 = 相对路径）与
 *      `generatedAt`（两端各自取当前时间）。键集必须完全一致。
 *   B. 渲染：KPI / 标签 / 主图 tab / 详情 tab / 详情行 / 右栏行 / 主图 svg 全部非空，
 *      且**数量与 Node 产物逐项相同**。
 *   C. console 里 0 个 error。
 *   D. 页面几何与 Node 产物相同（同宽 1440 下 docH 一致）。
 *
 * 需要 chrome（用 skill 自带的 drivers.mjs 找）与一个静态服务。
 * 用法：
 *   node skills/zzz-stats/scripts/test-app-browser.mjs \
 *     --base http://127.0.0.1:8901 --data fixtures/baseline --report output/绳匠A/report.html
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeArgs } from './drivers.mjs';
import { wantsHelp, printHelp } from './cli-help.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, '..');
const CHANNELS = [2, 3, 102, 103, 1, 5];

if (wantsHelp()) {
  printHelp('test-app-browser', {
    summary: '用真实浏览器验证 app.html 与 Node 产物等价（需要静态服务 + chrome）',
    options: [
      { flag: '--base <url>', desc: '静态服务根（指向 skill 目录），如 http://127.0.0.1:8901' },
      { flag: '--data <dir>', desc: '数据集目录，如 fixtures/baseline' },
      { flag: '--report <file>', desc: '同数据集的 Node 产物，用来比对' },
      { flag: '--help, -h', desc: '打印本帮助后退出' },
    ],
    notes: [
      '起服务：cd skills/zzz-stats && python3 -m http.server 8901 --bind 127.0.0.1',
      '不传参数时按 fixtures/baseline + output/绳匠A/report.html 跑，方便本地回归。',
    ],
  });
}

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const eq = args.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3) || d;
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = argOf('base', 'http://127.0.0.1:8902');
const DATA_DIR = resolve(argOf('data', join(SKILL_DIR, '..', '..', 'fixtures/baseline')));
const REPORT_HTML = resolve(argOf('report', join(SKILL_DIR, '..', '..', 'output/绳匠A/report.html')));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- 造 payload

const idx = JSON.parse(readFileSync(join(DATA_DIR, 'index.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(DATA_DIR, 'meta.json'), 'utf8'));
const channels = {};
for (const id of CHANNELS) {
  channels[id] = {
    curPoolStat: JSON.parse(readFileSync(join(DATA_DIR, `cur_pool_stat_${id}.json`), 'utf8')),
    histPoolStat: JSON.parse(readFileSync(join(DATA_DIR, `hist_pool_stat_${id}.json`), 'utf8')),
  };
}
/*
 * 带上 meta：真实链路里 meta.json 是落盘时生成的，浏览器端靠 payload.meta
 * （没有就走 metaFromInPage 从顶层字段推）。这里给 meta 是为了让两端的 meta 完全同源，
 * 从而验证「除 icons 值以外逐字段相同」——如果这里不带，差异会跑到 meta 上，
 * 那条断言就永远红，而根因是测试数据没对齐、不是代码有问题。
 */
const payload = JSON.stringify({
  ok: true, schema: 'zzz-stats/v1', uid: meta.uid, region: meta.region,
  fetchedAt: meta.fetched_at, server: meta.server, nickname: meta.nickname,
  index: idx, channels, meta,
});

// ---------------------------------------------------------------- 浏览器

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'zzz-app-test-'));
const port = 30800 + Math.floor(Math.random() * 90);
const chrome = spawn(findChrome(), [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--window-size=1600,1000', ...chromeArgs(), 'about:blank',
], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 240; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
  } catch { /* 还没起来 */ }
  await sleep(150);
}
if (!wsUrl) { console.error('chrome 没起来，跳过（用 --help 看前提）'); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let SID = null;
let nid = 10;
const pend = new Map();
const rpc = (m, p = {}) => new Promise((res, rej) => {
  const id = nid++;
  pend.set(id, { res, rej });
  const msg = { id, method: m, params: p };
  if (SID) msg.sessionId = SID;
  ws.send(JSON.stringify(msg));
});
const consoleErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(`EXCEPTION: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
  }
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result);
  }
});
const tg = await rpc('Target.getTargets');
SID = (await rpc('Target.attachToTarget', {
  targetId: tg.targetInfos.find((x) => x.type === 'page').targetId, flatten: true,
})).sessionId;
const ev = async (x) => {
  const r = await rpc('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
await rpc('Runtime.enable');
await rpc('Page.enable');
await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

/*
 * `chartSvg` 只数「有没有 svg 元素」，数不到「画布有没有内容」：
 * ECharts 在 init 时量容器尺寸，若那一刻容器是 display:none，会画出一块
 * **0×0 的 svg** —— 元素在、计数 1、断言全绿、肉眼一片空白。
 * 所以同时量 `#chart` 与 `#chart svg` 的**像素尺寸**，两者都必须是正常大小。
 * 这条断言就是被一次真实事故换来的（见 app.js 里 data-ready 的注释）。
 */
const COUNTS = `JSON.stringify((()=>{
  const q = (s)=>document.querySelectorAll(s).length;
  const box = (s)=>{const n=document.querySelector(s);if(!n)return null;
    const r=n.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)};};
  return { kpi:q('#kpi .kpi'), tags:q('#tags .tag'), chartTabs:q('#chart-tabs .chart-tab'),
           detailTabs:q('#detail-tabs .detail-tab'), detailRows:q('#detail-list .detail-row'),
           charRows:q('#detail-chars .detail-char'), chartSvg:q('#chart svg'),
           chartBox: box('#chart'), chartSvgBox: box('#chart svg'),
           docH: document.documentElement.scrollHeight };
})())`;

console.log(`数据集 ${DATA_DIR}`);
console.log(`产物   ${REPORT_HTML}`);
console.log('');

// ---- 打开 app 页
await rpc('Page.navigate', { url: `${BASE}/skills/zzz-stats/assets/report/app.html` });
await sleep(2400);
ok('app.js 就绪（window.zzzReport 存在）', await ev(`typeof window.zzzReport === 'function'`));

await ev(`window.zzzReport(${JSON.stringify(payload)})`);
await sleep(2600);

const ready = await ev(`document.documentElement.dataset.ready === '1'`);
ok('算出并渲染完成（data-ready）', ready);
const browserReport = JSON.parse(await ev(`JSON.stringify(window.__REPORT__ || null)`));
const appState = JSON.parse(await ev(COUNTS));

// ---- 打开 Node 产物
await rpc('Page.navigate', { url: `${REPORT_HTML.startsWith('http') ? REPORT_HTML : ''}` || 'about:blank' });
await sleep(200);
/*
 * Node 产物用 file:// 打不开（2026-11 实测：headless 下 file:// 导航在某些版本会被
 * 安全策略拦成 ERR_CONNECTION_REFUSED）。所以这里换成本地静态服务：
 * 把 output/ 也挂在同一个 base 下时直接取同名路径。取不到就跳过几何比对，不假装通过。
 */
let nodeCounts = null;
{
  const nav = await rpc('Page.navigate', { url: `${BASE}/output/${encodeURIComponent(basename(dirname(REPORT_HTML)))}/report.html` });
  await sleep(2800);
  if (!nav.errorText) {
    const has = await ev('!!window.__REPORT__');
    if (has) nodeCounts = JSON.parse(await ev(COUNTS));
  }
}

// ---------------------------------------------------------------- A. 等价性

console.log('');
console.log('A. 等价性（浏览器 core vs Node 产物）');
ok('拿到浏览器算出的 report', Boolean(browserReport));

/*
 * Node 侧的 report 直接从产物 HTML 里抠 `window.__REPORT__ = {...};`
 * —— 那就是「Node 端最终交给前端的那个对象」，比重新跑一遍 core 更贴近验收目标。
 */
const html = readFileSync(REPORT_HTML, 'utf8');
const marker = 'window.__REPORT__ = ';
/*
 * 结束位置必须按「从 marker 往后找第一个 `</script>`」算，不能假定 `;</script>` 紧挨着：
 * 模板里 `window.__REPORT__ = {…};` 后面还有一个换行才到 `</script>`，
 * 用 `';</script>'` 会找不到、于是把整份剩余 HTML 当成 JSON 送去 parse
 * —— 报的是「Unexpected non-whitespace character after JSON」，
 * 与真正的原因（分隔符写错）看起来毫无关系。实测踩过一次。
 */
const start = html.lastIndexOf(marker);
const end = html.indexOf('</script>', start);
const jsonText = html.slice(start + marker.length, end).trim().replace(/;\s*$/, '');
const nodeReport = JSON.parse(jsonText);

function deepDiff(x, y, path, out) {
  if (x === y) return;
  const tx = Object.prototype.toString.call(x);
  const ty = Object.prototype.toString.call(y);
  if (tx !== ty) { out.push(`${path}: 类型 ${tx} vs ${ty}`); return; }
  if (tx === '[object Array]') {
    if (x.length !== y.length) { out.push(`${path}: 长度 ${x.length} vs ${y.length}`); return; }
    for (let i = 0; i < x.length; i += 1) deepDiff(x[i], y[i], `${path}[${i}]`, out);
    return;
  }
  if (tx === '[object Object]') {
    const kx = Object.keys(x);
    const ky = Object.keys(y);
    const onlyX = kx.filter((k) => !(k in y));
    const onlyY = ky.filter((k) => !(k in x));
    if (onlyX.length) out.push(`${path}: 只在浏览器 ${onlyX.join(',')}`);
    if (onlyY.length) out.push(`${path}: 只在 Node ${onlyY.join(',')}`);
    for (const k of kx) if (k in y) deepDiff(x[k], y[k], `${path}.${k}`, out);
    return;
  }
  /*
   * 截断长值：报告的字段里有整段 tip（几十行中文）与图标路径，
   * 原样打出来会把终端和前 30 条 diff 一起淹没 —— 之前实测过一次，
   * 输出被一条 tip 撑到几万字符，真正的结论反而看不见了。
   */
  const brief = (v) => {
    const t = JSON.stringify(v);
    return t != null && t.length > 80 ? `${t.slice(0, 77)}...` : t;
  };
  out.push(`${path}: ${brief(x)} vs ${brief(y)}`);
}

const diffs = [];
deepDiff(browserReport, nodeReport, '', diffs);
const allowed = (d) => d.startsWith('.generatedAt') || d.startsWith('.icons');
const unexpected = diffs.filter((d) => !allowed(d));
const iconDiffs = diffs.filter((d) => d.startsWith('.icons'));
const generatedAt = diffs.filter((d) => d.startsWith('.generatedAt'));

ok('除 icons 值与 generatedAt 外逐字段相同', unexpected.length === 0, unexpected.slice(0, 3).join('；'));
ok('generatedAt 是唯一的时间戳差异', generatedAt.length <= 1, `${generatedAt.length} 处`);
ok('icons 键集完全一致',
  JSON.stringify(Object.keys(browserReport.icons ?? {}).sort())
  === JSON.stringify(Object.keys(nodeReport.icons ?? {}).sort()),
  `浏览器 ${Object.keys(browserReport.icons ?? {}).length} / Node ${Object.keys(nodeReport.icons ?? {}).length}`);
ok('每种 icon 的值都是差异（值本来就不同：dataURL vs 路径）',
  iconDiffs.length === Object.keys(nodeReport.icons ?? {}).length,
  `${iconDiffs.length} 项`);
const badValue = Object.entries(browserReport.icons ?? {})
  .filter(([, v]) => typeof v !== 'string' || /^data:image\//.test(v));
ok('浏览器端 icon 值全是相对路径、没有内嵌 base64', badValue.length === 0,
  badValue.slice(0, 3).map(([k]) => k).join(','));

// ---------------------------------------------------------------- B. 渲染

console.log('');
console.log('B. 渲染');
for (const [k, v] of Object.entries(appState)) {
  if (k === 'docH' || k === 'chartBox' || k === 'chartSvgBox') continue;
  ok(`${k} 非空（${v}）`, v > 0);
}
ok('#chart 容器有实际尺寸', (appState.chartBox?.w ?? 0) > 600 && (appState.chartBox?.h ?? 0) > 200,
  JSON.stringify(appState.chartBox));
ok('#chart svg 已铺满容器（不是 0×0 空画布）',
  (appState.chartSvgBox?.w ?? 0) > 600 && (appState.chartSvgBox?.h ?? 0) > 200,
  JSON.stringify(appState.chartSvgBox));
if (nodeCounts) {
  const skip = new Set(['docH', 'chartBox', 'chartSvgBox']);
  let same = 0;
  for (const k of Object.keys(appState)) {
    if (skip.has(k)) continue;
    if (appState[k] === nodeCounts[k]) same += 1;
  }
  const keys = Object.keys(appState).filter((k) => !skip.has(k)).length;
  ok(`结构计数与 Node 产物逐项相同（${same}/${keys}）`, same === keys,
    Object.keys(appState).filter((k) => !skip.has(k) && appState[k] !== nodeCounts[k])
      .map((k) => `${k} ${appState[k]}≠${nodeCounts[k]}`).join(' '));
  ok('主图容器尺寸与 Node 产物相同',
    appState.chartBox?.w === nodeCounts.chartBox?.w && appState.chartBox?.h === nodeCounts.chartBox?.h,
    `${JSON.stringify(appState.chartBox)} vs ${JSON.stringify(nodeCounts.chartBox)}`);
  ok(`页面高度与 Node 产物一致（${appState.docH} vs ${nodeCounts.docH}）`,
    appState.docH === nodeCounts.docH);
} else {
  console.log('  （跳过几何比对：产物没能在同一服务下打开，见文件头说明）');
}

// ---------------------------------------------------------------- C. console

console.log('');
console.log('C. console');
ok('0 个 error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

console.log('');
console.log(fail === 0 ? `结果：通过 ${pass} / 失败 0` : `结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
