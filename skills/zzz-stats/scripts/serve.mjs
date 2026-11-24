#!/usr/bin/env node
/**
 * zzz-stats 本地 Web 服务 —— 在浏览器里走完「扫码 → 取数 → 出报表」。
 *
 *   node skills/zzz-stats/scripts/serve.mjs            # 默认 0.0.0.0:3000
 *   node skills/zzz-stats/scripts/serve.mjs --port 8080 --cwd /tmp/x
 *
 * 打开 http://127.0.0.1:3000/（手机用局域网 IP），点「开始」→ 页面里出二维码 →
 * 米游社 App 扫码确认 → SSE 推进度 → 取完数自动构建 → 跳到 /report 看报表。
 *
 * ## 为什么是单文件、只用 node 内置 http
 *
 * 这条链路是「让用户亲手体验一次」，不是产品化的服务端：装依赖、拆路由文件、
 * 引入框架都要额外的安装步骤和版本漂移风险，而这里需要的东西（静态页、几条路由、
 * SSE）用 `node:http` 全都在内置模块里。前端 HTML 也整个内联在本文件里，
 * 不产生静态资源目录 —— 拷走一个文件就能跑。
 *
 * ## 只用纯 Node 那条路，**服务里不降级**
 *
 * `--transport browser` 那条路要开 Chrome、要人扫码、还要 stdin 和图片服务，
 * 放进来只会让「为什么突然弹出一个浏览器」变成服务端行为。所以这里固定
 * `transport: 'node'`，失败就把**真实错误**原样显示在页面上（不是只打控制台）。
 *
 * 降级策略本来就只在 CLI（`scripts/collect.mjs`）里，SDK 不做这件事
 * （见 `lib/index.mjs` 文件头）。服务端要不要降级是另一个决定，这里的选择是「不」。
 *
 * ## 凭据不进日志
 *
 * 二维码 ticket、Cookie 头、set-cookie 的内容**一律不进控制台、不进 SSE**。
 * 页面上只出现一张二维码图片（base64 data URL），它就是登录码本身 ——
 * 显示在用户自己的屏幕上是他要的，写进日志则是另一回事。
 * `redact()` 是最后一道闸：即使 SDK 以后的日志里带了 cookie/token，也会被替换掉。
 *
 * ## 0.0.0.0 的含义
 *
 * 监听 0.0.0.0 是为了让手机能用局域网 IP 打开（用户常在手机上用）。代价是
 * **同一局域网内谁都能打开这个页面并发起一次登录流程**。启动横幅里会打一行提醒，
 * 用完关掉即可；别在公共 WiFi 下长期开着。
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { collectData } from '../lib/collect.mjs';
import { buildReport } from '../lib/build.mjs';
import { outputRoot, resolveAccountName, accountDataDir } from './datasets.mjs';

// ---------------------------------------------------------------- 参数

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3) || fallback;
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`zzz-stats 本地 Web 服务：扫码 → 取数 → 出报表

用法：node skills/zzz-stats/scripts/serve.mjs [选项]

  --port <n>   端口，默认 3000
  --host <h>   监听地址，默认 0.0.0.0（手机要走局域网 IP 就保持默认）
  --cwd <dir>  用户工作目录，默认当前目录；output/ 相对它算
  --help, -h   打印本帮助后退出

用纯 Node 路径取数，失败时把真实错误显示在页面上，不做浏览器降级。
产物落在 output/<账号名>/{data/,report.html}，与采集 CLI 一致。`);
  process.exit(0);
}

const PORT = Number(argOf('port', '3000'));
const HOST = argOf('host', '0.0.0.0');
const WORK_DIR = resolve(argOf('cwd', process.cwd()));

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`端口不合法：${argOf('port', '')}`);
  process.exit(1);
}

const state = {
  workDir: WORK_DIR,
  /** 本次进程里最后一次成功构建的产物绝对路径。`/report` 只认它，不扫目录。 */
  latestReportPath: null,
  latestAccountName: null,
};

// ---------------------------------------------------------------- 运行状态与 SSE

/** 最近若干次运行，供断线重连重放。上限很小：一次运行只有几十条事件。 */
const RUNS = new Map();
const MAX_RUNS = 8;
let currentRun = null;
let runSeq = 0;

/**
 * 抹掉可能的凭据。
 *
 * SDK 现在的日志里没有 cookie/ticket，但这条链路一旦有人改 SDK、把请求头打进
 * 日志，凭据就会顺着 SSE 和终端漏出去。所以这里不赌「上游不会打」，
 * 而是把已知的 cookie 名、ticket、二维码 data URL 直接替换掉。
 *
 * @param {unknown} raw
 * @returns {string}
 */
function redact(raw) {
  return String(raw ?? '')
    .replace(/\b(cookie_token_v2|ltoken_v2|account_id_v2|account_mid_v2|ltuid_v2|ltmid_v2|account_id|ltuid|uni_web_token)=[^;\s"']+/gi, '$1=<已隐藏>')
    .replace(/\b(ticket|stoken|token)=[A-Za-z0-9._~+/=-]{12,}/g, '$1=<已隐藏>')
    .replace(/data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/=]+/g, '<二维码图片>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/**
 * 一条 SSE 事件帧。
 *
 * `id:` 让浏览器的 EventSource 在断线重连时带上 Last-Event-ID；
 * data 里也放一份 seq，客户端据此去重 —— 重连会把缓冲区从头重放，
 * 不去重就会看到重复的进度行。
 */
function frame(ev) {
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify({ ...ev.data, seq: ev.seq })}\n\n`;
}

function emit(run, type, data = {}) {
  const ev = { seq: ++run.seq, type, data };
  run.events.push(ev);
  for (const res of run.clients) {
    try {
      res.write(frame(ev));
    } catch {
      run.clients.delete(res);
    }
  }
}

/** 标记一次运行结束：发终止事件，然后关掉所有流。 */
function finishRun(run) {
  if (run.finished) return;
  run.finished = true;
  for (const res of run.clients) {
    try {
      res.end();
    } catch { /* 对端已断开 */ }
  }
  run.clients.clear();
}

function cancelRun(run, reason) {
  if (!run || run.finished || run.cancelled) return;
  run.cancelled = reason;
  /*
   * abort 会让 SDK 里正在进行的 fetch 立刻抛 AbortError，登录轮询随之退出。
   * 这是「用户点了重新出码」时唯一正确的做法：旧的那张码继续轮询下去，
   * 一旦有人扫了它，就会在后台静默登录成功并开始取数 —— 用户完全不知道。
   */
  try {
    run.ac.abort();
  } catch { /* 已中止 */ }
}

/** 新开一次运行，并把还在跑的旧运行取消掉。 */
function startRun() {
  if (currentRun && !currentRun.finished) cancelRun(currentRun, '被新的扫码请求替换');

  runSeq += 1;
  const run = {
    id: `${Date.now().toString(36)}-${runSeq.toString(36)}`,
    seq: 0,
    events: [],
    clients: new Set(),
    finished: false,
    cancelled: null,
    ac: new AbortController(),
    startedAt: Date.now(),
    uid: null,
    nickname: null,
    accountName: null,
    reportPath: null,
  };
  currentRun = run;
  RUNS.set(run.id, run);
  for (const [id, r] of RUNS) {
    if (RUNS.size <= MAX_RUNS) break;
    if (r.finished) RUNS.delete(id);
  }

  // 不 await：HTTP 立刻返回 runId，进度走 SSE。错误在 execute() 内部收口。
  void execute(run);
  return run;
}

/**
 * 一次完整流程：登录 → 取数 → 落盘 → 构建 → 产物就位。
 *
 * 阶段名是用户点名要的五个：申请二维码 / 已登录并查到角色 / 开始取数 /
 * 采集完成 / 构建报表。SDK 的 `onProgress` 只有 login/collect/done 三个，
 * 「已登录并查到角色」没有独立事件 —— 但拿到 `collect` 那一刻登录**必然已经完成**
 * （SDK 是顺序 await 的），所以在那时补一条，不靠解析日志文本。
 */
async function execute(run) {
  const stage = (label, tone) => emit(run, 'stage', { label, tone, elapsed: Date.now() - run.startedAt });
  const log = (msg) => {
    const text = redact(msg);
    if (!text) return;
    console.log('[zzz]', text);
    emit(run, 'log', { text });
  };

  try {
    stage('申请二维码');
    /*
     * 只有这一处调 SDK。`transport` 固定 node：服务里不做浏览器降级，
     * 失败就把真实错误给用户（页面上有、控制台里也有）。
     */
    const result = await collectData({
      transport: 'node',
      log,
      fetchImpl: (url, init) => fetch(url, { ...(init ?? {}), signal: run.ac.signal }),
      onQr: async (qr) => {
        emit(run, 'qr', { dataUrl: qr.dataUrl, ttlMs: 120000 });
        stage('二维码已生成，等待扫码');
      },
      onProgress: (ev) => {
        if (ev.stage === 'collect') {
          /*
           * SDK 走到 `collect` 时登录**已经完成**（`loginByQrNode()` 是 await 过的），
           * 所以这里补一条「已登录并查到角色」。UID 还拿不到 —— `collectData()`
           * 要等整件事做完才返回它，而 `onProgress` 不带这些字段；
           * 不去改 SDK 接口，等 `account` 事件（紧接着就有）再把昵称/UID 补到页面上。
           */
          stage('已登录并查到角色', 'ok');
          stage('开始取数');
        } else if (ev.stage === 'done') {
          stage('采集完成', 'ok');
        }
      },
    });

    const { uid, nickname, files, meta } = result;
    run.uid = String(uid);
    run.nickname = nickname ?? null;
    const resolved = resolveAccountName(nickname, uid);
    run.accountName = resolved.name;
    emit(run, 'account', { uid: run.uid, nickname: run.nickname, accountName: resolved.name });

    stage('构建报表');
    const reportPath = writeEverything({ files, meta, accountName: resolved.name, log });
    run.reportPath = reportPath;
    state.latestReportPath = reportPath;
    state.latestAccountName = resolved.name;

    emit(run, 'done', { url: '/report', reportPath, accountName: resolved.name });
    stage('完成', 'ok');
  } catch (e) {
    /*
     * 被新请求顶掉的运行不算失败：它本来就不该有结果。
     * 单独发一个 cancelled，让还连着的那一页知道「你这次不用等了」，
     * 而不是看到一个吓人的 AbortError。
     */
    if (run.cancelled || e?.name === 'AbortError' || e?.code === 'ABORT_ERR') {
      emit(run, 'cancelled', { reason: run.cancelled ?? '已取消' });
      stage('已取消', 'muted');
      return;
    }
    const message = redact(e?.message ?? String(e)) || '未知错误';
    console.error('[zzz] 失败：', message);
    emit(run, 'error', { message });
    stage('失败', 'bad');
  } finally {
    finishRun(run);
  }
}

/**
 * 落盘 + 构建。**顺序沿用采集/构建两个 CLI**：先按 `output/<账号名>/data/`
 * 的形状写原始响应，再构建产物 —— 这样服务跑过一次之后，
 * 用户仍可以拿 `build-report.mjs --data output/<账号名>/data` 重出报表。
 *
 * @returns {string} report.html 的绝对路径
 */
function writeEverything({ files, meta, accountName, log }) {
  const dataDir = accountDataDir(WORK_DIR, accountName);
  mkdirSync(dataDir, { recursive: true });
  for (const [name, value] of files) {
    if (name === 'meta.json') continue;
    // 缩进与 `scripts/collect.mjs` 一致：1 空格（体积小，diff 也还能读）
    writeFileSync(join(dataDir, name), JSON.stringify(value, null, 1));
  }
  writeFileSync(join(dataDir, 'meta.json'), JSON.stringify(meta, null, 2));

  /*
   * buildReport 认的是「文件名 → 内容」的映射，缺 meta.json 就拿不到昵称/采集时间。
   * 这里额外把键序对齐 CLI 读盘时的顺序（index → meta → 各频道），
   * 因为产物里内嵌的就是 `JSON.stringify(files)`：键序不同，同样数据的报文就不一样了。
   */
  const ordered = new Map();
  if (files.has('index.json')) ordered.set('index.json', files.get('index.json'));
  ordered.set('meta.json', meta);
  for (const [k, v] of files) {
    if (k === 'index.json' || k === 'meta.json') continue;
    ordered.set(k, v);
  }

  const built = buildReport({
    files: ordered,
    // 图标缺失是设计好的降级（退到占位图），但要让终端里看得到
    logWarn: (m) => console.log('[zzz]', redact(m)),
  });
  if (built.fatal.length) {
    throw new Error(`构建失败（${built.fatal.length} 个致命问题）：\n${built.fatal.join('\n')}`);
  }

  const outFile = join(outputRoot(WORK_DIR), accountName, 'report.html');
  mkdirSync(dirname(outFile), { recursive: true });
  /*
   * 和 build-report.mjs 一样：**校验通过之后才写产物**。
   * 顺序反过来的话，exit 1 也已经在盘上留下一份坏 HTML 了。
   */
  writeFileSync(outFile, built.html);
  log(`报表 → ${outFile}（${(Buffer.byteLength(built.html) / 1024 / 1024).toFixed(2)} MB）`);
  return outFile;
}

// ---------------------------------------------------------------- HTTP

const HOME_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>绝区零 调频数据 · 本地采集</title>
<style>
:root { color-scheme: light dark; --ink:#1b1b1f; --muted:#6b6b76; --line:#e3e3e8; --card:#fff; --bg:#f6f6f8; --accent:#3f5bd9; --ok:#178a4c; --bad:#c0392b; --warn:#a06a00; }
@media (prefers-color-scheme: dark) {
  :root { --ink:#e9e9ee; --muted:#9a9aa6; --line:#2c2c33; --card:#17171b; --bg:#0f0f12; --accent:#7d93ff; --ok:#3ecf82; --bad:#ff7b6b; --warn:#e6b34d; }
}
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--ink);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
main { max-width: 560px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .01em; }
.sub { margin: 0 0 20px; color: var(--muted); font-size: 13px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px; }
#qrwrap { text-align: center; }
#qr { width: 260px; height: 260px; image-rendering: pixelated; border-radius: 10px; background: #fff; padding: 6px; border: 1px solid var(--line); }
#qrtip { margin-top: 10px; font-size: 13px; color: var(--muted); }
.stages { list-style: none; margin: 0; padding: 0; }
.stages li { position: relative; padding: 6px 0 6px 22px; font-size: 14px; }
.stages li::before { content: ""; position: absolute; left: 4px; top: 13px; width: 7px; height: 7px; border-radius: 50%; background: var(--line); }
.stages li.ok::before { background: var(--ok); }
.stages li.bad::before { background: var(--bad); }
.stages li.warn::before { background: var(--warn); }
.stages li.muted { color: var(--muted); }
.stages li .t { color: var(--muted); font-size: 12px; margin-left: 8px; font-variant-numeric: tabular-nums; }
.stages li.log { padding: 2px 0 2px 22px; color: var(--muted); font-size: 12.5px; }
.stages li.log::before { width: 4px; height: 4px; top: 10px; left: 5px; opacity: .6; }
#err { margin: 14px 0 0; padding: 12px 14px; border-radius: 10px; background: color-mix(in srgb, var(--bad) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--bad) 35%, transparent); color: var(--ink); font-size: 13.5px; white-space: pre-wrap; word-break: break-word; }
#err b { color: var(--bad); }
.row { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
button { font: inherit; padding: 10px 18px; border-radius: 10px; cursor: pointer; border: 1px solid transparent; }
button.primary { background: var(--accent); color: #fff; font-weight: 600; }
button.ghost { background: transparent; border-color: var(--line); color: var(--ink); }
button:disabled { opacity: .55; cursor: default; }
#hint { margin: 14px 0 0; color: var(--muted); font-size: 12.5px; }
a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>绝区零 调频数据</h1>
  <p class="sub">扫码 → 取数 → 出报表。全程在你的机器上，数据不经过第三方。</p>
  <section class="card">
    <div id="qrwrap" hidden>
      <img id="qr" alt="米游社登录二维码" width="260" height="260">
      <div id="qrtip"></div>
    </div>
    <ol id="stages" class="stages"></ol>
    <div id="err" hidden></div>
    <div class="row">
      <button id="start" class="primary">开始</button>
      <button id="reissue" class="ghost" hidden>重新出码</button>
    </div>
    <p id="hint">点「开始」后用米游社 App 扫码。二维码约 2 分钟失效，过期点「重新出码」。</p>
  </section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var startBtn = $('start'), reissueBtn = $('reissue'), qrWrap = $('qrwrap'), qrImg = $('qr'), qrTip = $('qrtip');
  var stageList = $('stages'), errBox = $('err'), hint = $('hint');

  var es = null, lastSeq = 0, expireAt = 0, tick = null, terminal = false;

  function clearStageList() { while (stageList.firstChild) stageList.removeChild(stageList.firstChild); }
  function stopTick() { if (tick) { clearInterval(tick); tick = null; } }
  function closeEs() { if (es) { es.close(); es = null; } stopTick(); }

  function addLine(text, cls, elapsedMs) {
    var li = document.createElement('li');
    if (cls) li.className = cls;
    li.appendChild(document.createTextNode(text));
    if (typeof elapsedMs === 'number' && elapsedMs >= 0) {
      var t = document.createElement('span');
      t.className = 't';
      t.textContent = (elapsedMs / 1000).toFixed(1) + 's';
      li.appendChild(t);
    }
    stageList.appendChild(li);
    stageList.scrollTop = stageList.scrollHeight;
  }

  function showError(message) {
    errBox.hidden = false;
    errBox.textContent = '';
    var b = document.createElement('b');
    b.textContent = '失败：';
    errBox.appendChild(b);
    errBox.appendChild(document.createTextNode(message));
  }

  function setBusy(busy) {
    startBtn.disabled = busy;
    if (busy) {
      startBtn.textContent = '进行中…';
    } else {
      startBtn.textContent = stageList.childElementCount ? '再来一次' : '开始';
      startBtn.disabled = false;
    }
    reissueBtn.hidden = !busy;
    hint.hidden = busy;
  }

  function resetView() {
    clearStageList();
    errBox.hidden = true;
    errBox.textContent = '';
    qrWrap.hidden = true;
    qrImg.removeAttribute('src');
    qrTip.textContent = '';
    lastSeq = 0;
    terminal = false;
    expireAt = 0;
    stopTick();
  }

  function startCountdown(ttlMs) {
    expireAt = Date.now() + ttlMs;
    stopTick();
    var render = function () {
      var left = Math.max(0, Math.round((expireAt - Date.now()) / 1000));
      qrTip.textContent = left > 0
        ? '二维码有效期剩余 ' + left + ' 秒'
        : '二维码可能已失效，点「重新出码」换一张';
    };
    render();
    tick = setInterval(render, 1000);
  }

  function on(type, fn) {
    if (!es) return;
    es.addEventListener(type, function (ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data.seq && data.seq <= lastSeq) return;
      if (data.seq) lastSeq = data.seq;
      fn(data);
    });
  }

  function openStream(runId) {
    closeEs();
    es = new EventSource('/api/events?runId=' + encodeURIComponent(runId));

    on('stage', function (d) { addLine(d.label, d.tone, d.elapsed); });
    on('log', function (d) { addLine(d.text, 'log'); });
    on('account', function (d) {
      var who = d.nickname ? d.nickname + '（UID ' + d.uid + '）' : 'UID ' + d.uid;
      addLine('账号：' + who);
    });
    on('qr', function (d) {
      qrImg.src = d.dataUrl;
      qrWrap.hidden = false;
      startCountdown(d.ttlMs || 120000);
    });
    on('done', function (d) {
      terminal = true;
      closeEs();
      addLine('报表已生成，正在打开…', 'ok');
      window.location.assign(d.url || '/report');
    });
    on('error', function (d) {
      terminal = true;
      closeEs();
      showError(d.message || '未知错误');
      setBusy(false);
    });
    on('cancelled', function (d) {
      terminal = true;
      closeEs();
      addLine('这次运行已结束：' + (d.reason || '已取消'), 'muted');
      setBusy(false);
    });
    /*
     * 断线（服务重启、网络抖动）时 EventSource 自己会重连并带上 Last-Event-ID；
     * 服务端从头重放，客户端靠 seq 去重。这里只更新一下提示，不当失败处理。
     */
    es.addEventListener('error', function () {
      if (terminal) return;
      hint.hidden = false;
      hint.textContent = '连接中断，正在重连…（进度不会丢）';
    });
  }

  function start() {
    resetView();
    setBusy(true);
    addLine('正在启动采集…');
    fetch('/api/start', { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw new Error('启动失败：HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) { openStream(j.runId); })
      .catch(function (e) {
        showError(e && e.message ? e.message : String(e));
        setBusy(false);
      });
  }

  startBtn.addEventListener('click', start);
  reissueBtn.addEventListener('click', start);

  /*
   * 页面刷新后如果服务里还有一次运行（或刚跑完），自动接回去 ——
   * 刷新一下就把二维码弄丢、还得重新点一次，是没有必要的摩擦。
   */
  fetch('/api/state')
    .then(function (r) { return r.json(); })
    .then(function (s) {
      if (!s || !s.runId) return;
      if (s.finished) {
        startBtn.textContent = '再来一次';
        addLine('上一次运行已结束，点「再来一次」可以再跑一遍。', 'muted');
        if (s.hasReport) {
          var li = document.createElement('li');
          li.className = 'log';
          var a = document.createElement('a');
          a.href = '/report';
          a.textContent = '打开上一次生成的报表 →';
          li.appendChild(a);
          stageList.appendChild(li);
        }
        return;
      }
      setBusy(true);
      addLine('已接上正在进行的运行…');
      openStream(s.runId);
    })
    .catch(function () { /* 状态接口不可用不影响手动开始 */ });
})();
</script>
</body>
</html>`;

const NOT_READY_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>还没有报表</title>
<style>body{margin:0;padding:48px 20px;background:#f6f6f8;color:#1b1b1f;font:15px/1.6 -apple-system,"PingFang SC",sans-serif}
@media (prefers-color-scheme:dark){body{background:#0f0f12;color:#e9e9ee}a{color:#7d93ff}}
main{max-width:520px;margin:0 auto}h1{font-size:18px;margin:0 0 12px}p{color:#6b6b76;margin:0 0 16px}</style>
</head><body><main>
<h1>还没有生成报表</h1>
<p>这个进程里还没跑完过一次采集。回到首页点「开始」，扫码确认后会自动跳到这里。</p>
<p><a href="/">← 回首页</a></p>
</main></body></html>`;

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, code, obj) {
  sendText(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function sendHtml(res, html, code = 200) {
  sendText(res, code, html, 'text/html; charset=utf-8');
}

/** 把一条运行的事件流接给浏览器；已结束的运行重放完就关。 */
function subscribe(req, res, run) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 反代/中间层不要缓冲，否则进度会攒成一坨最后一起到
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  for (const ev of run.events) res.write(frame(ev));
  if (run.finished) {
    res.end();
    return;
  }
  run.clients.add(res);
  // 心跳：SSE 长时间没字节流，有些移动网络/中间层会主动断
  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(hb);
      run.clients.delete(res);
    }
  }, 15000);
  req.on('close', () => {
    clearInterval(hb);
    run.clients.delete(res);
  });
}

function serveReport(res) {
  const file = state.latestReportPath;
  if (!file || !existsSync(file)) {
    sendHtml(res, NOT_READY_HTML, 404);
    return;
  }
  const stat = statSync(file);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    sendText(res, 400, '400 请求地址不合法\n');
    return;
  }
  const path = url.pathname;
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && (path === '/' || path === '/index.html')) return sendHtml(res, HOME_HTML);
    if (method === 'GET' && path === '/healthz') return sendText(res, 200, 'ok\n');
    // 浏览器会自己来要这个；204 让控制台/网络面板保持干净
    if (path === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (method === 'POST' && path === '/api/start') {
      const run = startRun();
      return sendJson(res, 200, { runId: run.id });
    }
    if (method === 'GET' && path === '/api/state') {
      return sendJson(res, 200, {
        runId: currentRun ? currentRun.id : null,
        finished: currentRun ? currentRun.finished : true,
        accountName: state.latestAccountName,
        hasReport: Boolean(state.latestReportPath),
      });
    }
    if (method === 'GET' && path === '/api/events') {
      const run = RUNS.get(String(url.searchParams.get('runId') || ''));
      if (!run) return sendText(res, 404, '404 没有这次运行（可能服务重启过），回首页重新开始\n');
      return subscribe(req, res, run);
    }
    if (method === 'GET' && (path === '/report' || path === '/report.html')) return serveReport(res);
    return sendText(res, 404, '404 没有这个页面\n');
  } catch (e) {
    console.error('[zzz] 请求处理失败：', e?.message ?? e);
    if (!res.headersSent) sendText(res, 500, `500 服务内部错误：${e?.message ?? e}\n`);
    else res.end();
  }
});

// ---------------------------------------------------------------- 启动

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) out.push(nic.address);
    }
  }
  return out;
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。换一个：--port 3001（或先把占用的进程停掉）`);
  } else if (e.code === 'EACCES') {
    console.error(`没有权限监听 ${HOST}:${PORT}。1024 以下的端口需要 root，换一个 3000 以上的。`);
  } else {
    console.error('[zzz] 服务启动失败：', e.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const lines = [
    '',
    '绝区零 调频数据 · 本地服务',
    `  本机    http://127.0.0.1:${PORT}/`,
  ];
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const ip of lanAddresses()) lines.push(`  局域网  http://${ip}:${PORT}/   ← 手机用这个`);
  }
  lines.push(
    `  产物目录 ${join(WORK_DIR, 'output')}`,
    '',
    '  取数路径：纯 Node（不降级）。扫码要真人，页面会等你。',
    HostNote(HOST),
    '',
  );
  console.log(lines.join('\n'));
});

/** 监听公网地址时的提醒 —— 这个页面能让局域网里任何人发起一次登录流程。 */
function HostNote(host) {
  if (host !== '0.0.0.0' && host !== '::') return '  只监听本机地址。';
  return '  ⚠️  已监听 0.0.0.0：同一局域网内的人也能打开这个页面并发起登录，用完记得关。';
}

for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => {
    if (currentRun && !currentRun.finished) cancelRun(currentRun, `收到 ${sig}`);
    server.close();
    process.exit(code);
  });
}
