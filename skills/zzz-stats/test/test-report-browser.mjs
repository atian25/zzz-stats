#!/usr/bin/env node
/**
 * 产物端到端验收：**浏览器现算的 `__REPORT__` 与 Node 口径完全一致**，且页面真的渲染出来了。
 *
 * ## 这套用例测的是什么（和上一版的差别）
 *
 * 上一版测的是 `assets/report/app.html`（粘贴 JSON 的静态页），那个入口已经按用户要求删除。
 * 现在产物自己是「内嵌原始 JSON + 浏览器现算」，所以这套用例改成**直接打开产物 HTML**，
 * 断言三件事：
 *
 *   A. 等价性：产物里浏览器算出的 `__REPORT__`，与 Node 端 `computeReport()` 对**同一批
 *      fixtures** 算出的对象逐字段相同。`generatedAt` 两侧归一化掉（一个是构建时刻，
 *      一个是本次运行）——除此之外一个字节都不许差。
 *
 *      **注意这一版比上一版更强**：上一版允许 `icons` 的值不同（浏览器是相对路径、
 *      Node 是 dataURL）。现在图标走同一套 sha1 + 同一份 base64 内嵌，两侧必须**完全相同**。
 *
 *   B. 渲染：KPI / 标签 / 主图 tab / 详情 tab / 详情行 / 右栏行 / 主图 svg 全部非空，
 *      且 `#chart` 与 `#chart svg` 的**像素尺寸**都正常。
 *
 *      「元素在、尺寸 0」是真实踩过的坑：ECharts 在容器还是 `display:none` 时 init，
 *      会画出一块 0×0 的 svg —— 结构计数全绿、截图一片空白。
 *
 *   C. console 0 error。
 *
 *   D. 产物内容自检：内嵌的原始 JSON 与 `fixtures/<name>/*.json` 逐键对得上；
 *      产物里 0 处 `/*__` 占位符残留、0 个 `type="module"`、0 处 `await import`。
 *
 * ## 为什么必须是真浏览器
 *
 * 「转换后的 core 在浏览器里算出的结果与 Node 一致」这件事 Node 测不出来：Node import 的
 * 是 ESM 原文件，产物里跑的是**剥掉 export、包进 IIFE、按文本内嵌**的那一份。转换环节坏了，
 * Node 端毫无反应，浏览器端则 `ReferenceError` 白屏或算错 —— 而构建日志照样打印「成功」。
 *
 * 用法（需要 chrome；默认用 file:// 打开，也可走静态服务）：
 *   node skills/zzz-stats/scripts/test-report-browser.mjs
 *   node skills/zzz-stats/scripts/test-report-browser.mjs --data fixtures/multigold --report output/绳匠B/report.html
 *   node skills/zzz-stats/scripts/test-report-browser.mjs --base http://127.0.0.1:8899
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeArgs } from '../../../packages/sdk/drivers.mjs';
import { wantsHelp, printHelp } from '../scripts/cli-help.mjs';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { computeReport } from '../assets/report/core.js';
import { PAYLOAD_ID } from '../scripts/core-inline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, '..');
const REPO_DIR = resolve(SKILL_DIR, '..', '..');

if (wantsHelp()) {
  printHelp('test-report-browser', {
    summary: '用真实浏览器验收产物：浏览器现算的 report 与 Node 口径逐字段相同',
    options: [
      { flag: '--data <dir>', desc: '数据集目录，如 fixtures/baseline（用来独立跑一遍 Node 口径）' },
      { flag: '--report <file>', desc: '要验收的产物，如 output/绳匠A/report.html' },
      { flag: '--base <url>', desc: '可选。走静态服务打开产物，如 http://127.0.0.1:8899；默认 file://' },
      { flag: '--help, -h', desc: '打印本帮助后退出' },
    ],
    notes: [
      '需要 chrome（用 skill 自带的 drivers.mjs 找）。不需要起服务：默认 file:// 直接打开。',
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
const DATA_DIR = resolve(argOf('data', join(REPO_DIR, 'fixtures/baseline')));
const REPORT_HTML = resolve(argOf('report', join(REPO_DIR, 'output/绳匠A/report.html')));
const BASE = argOf('base', null);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
};

console.log(`数据集 ${DATA_DIR}`);
console.log(`产物   ${REPORT_HTML}`);
console.log('');

// ---------------------------------------------------------------- D. 产物静态自检

console.log('D. 产物内容（不用浏览器，先静态查一遍）');
const html = readFileSync(REPORT_HTML, 'utf8');

/*
 * 占位符残留是**最贵的坑**：模板换了占位符、构建脚本没跟着换，产物里会留着字面量
 * `/*__XXX__*\/`、`window.__REPORT__` 一次都没赋值 —— 页面全白，而构建日志照样打印
 * 「报表 → xxx，2.15 MB，成功」。这真实发生过一次。
 */
const leftover = html.match(/\/\*__[A-Z0-9_]+__\*\//g);
ok('0 处 /*__ 占位符残留', leftover === null, leftover ? [...new Set(leftover)].join(' ') : '');

const SCRIPT_MODULE = /<script[^>]*\btype\s*=\s*["']module["']/i;
ok('没有 type="module" 脚本（会把执行变成异步）', !SCRIPT_MODULE.test(html));
ok('没有 await import（同上）', !html.includes('await import'));
ok('没有动态 import(', !/\bimport\s*\(/.test(html));

/*
 * 三段脚本的顺序是硬要求：原始 JSON → core+引导 → charts.js。
 * 顺序错了，charts.js 会在 `__REPORT__` 还没赋值时先跑，静默 return、页面全白。
 */
const atPayload = html.indexOf(`id="${PAYLOAD_ID}"`);
const atBoot = html.indexOf('window.__REPORT__ = out.report');
const atCharts = html.indexOf('const R = window.__REPORT__');
ok('三段脚本都在', atPayload >= 0 && atBoot >= 0 && atCharts >= 0,
  `payload=${atPayload} boot=${atBoot} charts=${atCharts}`);
ok('顺序正确：原始 JSON → core+引导 → charts.js', atPayload < atBoot && atBoot < atCharts);

// 内嵌的原始 JSON 必须与 fixtures 逐键一致
const payloadMatch = html.match(new RegExp(`<script type="application/json" id="${PAYLOAD_ID}">([\\s\\S]*?)</script>`));
ok('取到内嵌的原始 JSON', Boolean(payloadMatch));
let embeddedFiles = null;
try { embeddedFiles = payloadMatch ? JSON.parse(payloadMatch[1]) : null; } catch { /* 下面断言会红 */ }
ok('内嵌 JSON 可解析', embeddedFiles !== null);

/*
 * 独立跑一遍 Node 口径：用磁盘上的 fixtures（不是产物里的那份 JSON）。
 * 这样「产物里的 JSON 有没有被裁剪/改坏」与「转换后的 core 算得对不对」是两条独立的证据链。
 */
const CFG = JSON.parse(readFileSync(join(SKILL_DIR, 'config/report.json'), 'utf8'));
const diskFiles = {};
for (const name of ['index.json', 'meta.json']) {
  try { diskFiles[name] = JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')); } catch { /* meta 可选 */ }
}
for (const ch of CFG.channels) {
  for (const prefix of ['cur_pool_stat', 'hist_pool_stat']) {
    const name = `${prefix}_${ch.id}.json`;
    try { diskFiles[name] = JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')); } catch { /* 该频道无记录 */ }
  }
}
const sortedKeys = (o) => JSON.stringify(Object.keys(o).sort());
ok('内嵌 JSON 的键集与磁盘数据集一致', embeddedFiles && sortedKeys(embeddedFiles) === sortedKeys(diskFiles),
  embeddedFiles ? `产物 ${Object.keys(embeddedFiles).length} / 磁盘 ${Object.keys(diskFiles).length}` : '');
if (embeddedFiles) {
  const canon = (v) => JSON.stringify(v, Object.keys(v ?? {}).sort());
  const mismatch = Object.keys(diskFiles).filter((k) => {
    if (!(k in embeddedFiles)) return true;
    // 用排序后的键做一次规整比较：JSON.stringify 的键序随对象而来，不影响内容
    const norm = (x) => JSON.stringify(x, (key, val) => (
      val && typeof val === 'object' && !Array.isArray(val)
        ? Object.fromEntries(Object.keys(val).sort().map((k2) => [k2, val[k2]]))
        : val));
    return norm(diskFiles[k]) !== norm(embeddedFiles[k]);
  });
  ok('内嵌 JSON 与磁盘数据集逐键一致（14 个文件全对）', mismatch.length === 0, mismatch.slice(0, 5).join(','));
  void canon;
}

// ---------------------------------------------------------------- 启动 chrome

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chromePath = findChrome();
if (!chromePath) {
  console.error('');
  console.error('找不到 chrome，无法做浏览器验收。');
  console.error('  装在常见位置即可（drivers.mjs 的 CHROME_CANDIDATES），或用 ZZZ_CHROME_ARGS 指定启动参数。');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'zzz-report-test-'));
const port = 30900 + Math.floor(Math.random() * 90);
const chrome = spawn(chromePath, [
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
if (!wsUrl) {
  console.error('chrome 没起来，验收中止（不是用例失败，是环境没起来）');
  chrome.kill();
  process.exit(2);
}

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

/*
 * 打开产物。默认 file:// —— 产物是单文件（图标 base64 内嵌、ECharts 内联），
 * 没有任何相对资源要取，所以不需要静态服务。`--base` 只是给「必须走 http」的场合留的口子。
 */
const url = BASE
  ? `${BASE.replace(/\/$/, '')}/output/${encodeURIComponent(basename(dirname(REPORT_HTML)))}/report.html`
  : `file://${REPORT_HTML}`;
await rpc('Page.navigate', { url });
/*
 * 等待策略与 screenshot.mjs 完全一致：只等 DOMContentLoaded + 一点字体/首帧时间。
 * **不加任何特殊等待**——这正是 B 项要证明的事：三段同步脚本跑完，
 * 页面在这个时机就已经完整，不需要为「异步加载」补偿。
 */
await sleep(2500);

// ---------------------------------------------------------------- A. 等价性

console.log('');
console.log('A. 等价性（浏览器现算 vs Node 口径）');

const ready = await ev(`document.readyState`);
ok('页面已加载完（readyState=complete）', ready === 'complete', String(ready));
ok('window.__REPORT__ 已就绪', await ev('!!window.__REPORT__'));

const browserReport = JSON.parse(await ev('JSON.stringify(window.__REPORT__ || null)'));

/*
 * Node 侧独立算一遍。`generatedAt` 不传 —— 两侧随后都归一化掉这个字段。
 * 顺带说明为什么不用「从产物里抠 report」：现在产物里**根本没有**预算好的 report，
 * 有的话 D 项就失败了。所以只能重算，而这恰好是更强的检验。
 *
 * **icons 必须传**：core 只负责把 key 贴到结构上，`report.icons` 由调用方填
 * （core 不知道图标是 dataURL 还是路径）。不传的话 Node 侧 `avatarKey` 全是 null、
 * `icons` 是空对象，于是每一条都会被判成差异 —— 那是用例自己漏了参数，不是产物有问题。
 * 这里按产物里的同一套规则（`dir/id` → sha1 前 16 位 → base64）复算一份。
 */
const ICONS_DIR = join(SKILL_DIR, 'assets/report/icons');
function makeNodeIcons() {
  const byHash = new Map();
  const byId = new Map();
  const encode = (dir, id) => {
    const key = `${dir}/${id}`;
    if (byId.has(key)) return byId.get(key);
    const file = join(ICONS_DIR, dir, `${id}.png`);
    let buf = existsSync(file) ? readFileSync(file) : null;
    if (!buf) {
      const fb = join(ICONS_DIR, 'items/_fallback.png');
      buf = existsSync(fb) ? readFileSync(fb) : null;
    }
    if (!buf) { byId.set(key, null); return null; }
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16);
    if (!byHash.has(hash)) byHash.set(hash, `data:image/png;base64,${buf.toString('base64')}`);
    byId.set(key, hash);
    return hash;
  };
  return {
    encode,
    resolveId: (id) => {
      for (const dir of ['avatars', 'items']) {
        if (existsSync(join(ICONS_DIR, dir, `${id}.png`))) return encode(dir, id);
      }
      return encode('avatars', id);
    },
    map: () => Object.fromEntries(byHash),
  };
}
const nodeIcons = makeNodeIcons();
const nodeReport = computeReport({ files: diskFiles, cfg: CFG, icons: nodeIcons }).report;
nodeReport.icons = nodeIcons.map();

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
    if (onlyX.length) out.push(`${path}: 只在浏览器 ${onlyX.slice(0, 5).join(',')}`);
    if (onlyY.length) out.push(`${path}: 只在 Node ${onlyY.slice(0, 5).join(',')}`);
    for (const k of kx) if (k in y) deepDiff(x[k], y[k], `${path}.${k}`, out);
    return;
  }
  /*
   * 截断长值：report 里有整段 tip（几十行中文），原样打出来会把终端和前 30 条 diff
   * 一起淹没 —— 实测过一次，输出被一条 tip 撑到几万字符，真正的结论反而看不见了。
   */
  const brief = (v) => {
    const t = JSON.stringify(v);
    return t != null && t.length > 80 ? `${t.slice(0, 77)}...` : t;
  };
  out.push(`${path}: ${brief(x)} vs ${brief(y)}`);
}

const diffsNormalized = [];
{
  // 两侧都删掉 generatedAt 再比：一个是构建时刻，一个是本次运行
  const strip = (r) => { const c = JSON.parse(JSON.stringify(r)); delete c.generatedAt; return c; };
  deepDiff(strip(browserReport), strip(nodeReport), '', diffsNormalized);
}
ok('归一化 generatedAt 后逐字段相同', diffsNormalized.length === 0,
  diffsNormalized.slice(0, 3).join('；'));

/*
 * 图标两端必须**完全相同**（这一版比上一版更强：上一版允许浏览器用相对路径，
 * 现在两端是同一套 sha1 + 同一份 base64 内嵌）。
 */
ok('icons 键集完全一致（浏览器 vs Node）', sortedKeys(browserReport?.icons ?? {}) === sortedKeys(nodeReport?.icons ?? {}),
  `浏览器 ${Object.keys(browserReport?.icons ?? {}).length} / Node ${Object.keys(nodeReport?.icons ?? {}).length}`);
ok('icons 的值也完全一致（都是内嵌 dataURL）',
  JSON.stringify(browserReport?.icons ?? {}) === JSON.stringify(nodeReport?.icons ?? {}));
const badIcon = Object.entries(browserReport?.icons ?? {})
  .filter(([, v]) => typeof v !== 'string' || !/^data:image\/png;base64,/.test(v));
ok('每个 icon 值都是内嵌 dataURL', badIcon.length === 0, badIcon.slice(0, 3).map(([k]) => k).join(','));

const generatedAt = browserReport?.generatedAt;
ok('generatedAt 是个 ISO 时间戳', typeof generatedAt === 'string' && !Number.isNaN(Date.parse(generatedAt)), String(generatedAt));

// ---------------------------------------------------------------- B. 渲染

console.log('');
console.log('B. 渲染');
const state = JSON.parse(await ev(COUNTS));
for (const [k, v] of Object.entries(state)) {
  if (k === 'docH' || k === 'chartBox' || k === 'chartSvgBox') continue;
  ok(`${k} 非空（${v}）`, v > 0);
}
ok('#chart 容器有实际尺寸（不是 0×0）',
  (state.chartBox?.w ?? 0) > 600 && (state.chartBox?.h ?? 0) > 200, JSON.stringify(state.chartBox));
ok('#chart svg 已铺满容器（不是 0×0 空画布）',
  (state.chartSvgBox?.w ?? 0) > 600 && (state.chartSvgBox?.h ?? 0) > 200, JSON.stringify(state.chartSvgBox));
ok('主图 svg 与容器尺寸一致',
  state.chartSvgBox?.w === state.chartBox?.w && state.chartSvgBox?.h === state.chartBox?.h,
  `${JSON.stringify(state.chartSvgBox)} vs ${JSON.stringify(state.chartBox)}`);

/*
 * 详情两栏必须都有行。KPI 有数字但详情空白，是「口径算出来了、渲染挂了一半」的典型症状，
 * 光看 KPI 完全发现不了。
 */
ok('抽卡详情左栏有行', state.detailRows > 0);
ok('代理人汇总右栏有行', state.charRows > 0);

// ---------------------------------------------------------------- C. console

console.log('');
console.log('C. console');
ok('0 个 error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

console.log('');
console.log(fail === 0 ? `结果：通过 ${pass} / 失败 0` : `结果：通过 ${pass} / 失败 ${fail}`);
ws.close();
chrome.kill();
process.exit(fail === 0 ? 0 : 1);
