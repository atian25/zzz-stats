#!/usr/bin/env node
/**
 * zzz-stats 本地 Web 服务 —— 在浏览器里走完「扫码 → 取数 → 出报表」。
 *
 *   node packages/server/serve.mjs            # 默认 0.0.0.0:3000
 *   node packages/server/serve.mjs --port 8080
 *
 * 打开页面 → 点「开始扫码」→ 页面上出现二维码 → 米游社 App 扫码确认
 * → SSE 实时推进度 → 取完数在内存里构建 → 自动跳到 /report?runId=… 看报表。
 *
 * ## 它是「多人同时用」的服务，不是单人玩具
 *
 * 每次点「开始扫码」创建一个**独立的 run**：自己的二维码、自己的 SSE 流、
 * 自己的进度、自己的报表。run 与 run 之间没有任何共享状态，也互相看不到对方的信息。
 *
 * 上一版是全局单例 `currentRun`，第二个人点开始会把第一个人的扫码顶掉
 * （`startRun()` 里 `cancelRun(前一个)`）—— 多人用会直接串台。这一版删除那个设计：
 *
 *   - 所有按 run 取数据的地方都必须带 runId：`/api/events?runId=`、`/report?runId=`
 *   - run 之间不共享任何可变状态；`RUNS` 只是「按 id 查表」，不参与流程判断
 *   - 有并发上限（`--max-runs`，默认 8），超了返回 503 + 明确文案，而不是把别人的顶掉
 *
 * ## 报表**不落盘**
 *
 * `collectData()` 拿到的 files 直接在内存里交给 `buildReport()`，HTML 存在该 run 上，
 * `/report?runId=` 从内存返回。理由：这个服务的产物是「当场看一次」，
 * 不是「归档到磁盘」；而且多人同时用时，落盘会让他们互相覆盖
 * （昵称可能相同，账号目录就是同一个）。
 *
 * 需要落盘归档时用两个 CLI（`collect.mjs` / `build-report.mjs`），那是另一套语义：
 * 一个账号一个目录、数据 + 报表放一起、可以拷走部署。
 *
 * run 结束（成功/失败/被回收）后内存里的 files 与 html 一起释放；
 * 结束的 run 只保留一小段时间与少量事件，供「刚跑完那一瞬间的刷新」重放。
 *
 * ## 前端与后端同目录
 *
 * `index.html` / `app.js` / `style.css` 就放在本文件旁边（`packages/server/`）——
 * 它们只服务这一个进程，不像报表模板那样要随 skill 分发，所以不塞进 `assets/`。
 *
 * 背景示例图用**仓库根**的 `docs/preview.png`（README 那张报表预览），
 * 由这里按 `/assets/preview.png` 提供。它在 skill 之外，**skill 单独安装时不存在**，
 * 所以启动时探一次：没有就回 204 并在横幅里说明，见 `HAS_PREVIEW`。
 *
 * ## 凭据不进日志
 *
 * 二维码 ticket、Cookie 头、set-cookie 的内容**一律不进控制台、不进 SSE**。
 * 页面上只出现一张二维码图片（base64 data URL）—— 它就是登录码本身，
 * 显示在用户自己的屏幕上才是目的。`redact()` 是最后一道闸。
 *
 * ## 0.0.0.0 的含义
 *
 * 监听 0.0.0.0 是为了让手机能用局域网 IP 打开。代价是**同一局域网内谁都能打开这个页面
 * 并发起一次登录流程**。启动横幅会打一行提醒。多人版上线后这一点更需要注意：
 * 现在是真的能同时跑多份，不是「开了个页面看看」。
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
/* 采集层在 packages/sdk；报表渲染器留在 skill 的 scripts —— 两个出口，别混 */
import { collectData } from '@atian25/zzz-stats-sdk';
import { buildReport } from '@atian25/zzz-stats-skill/report';

// ---------------------------------------------------------------- 参数

/* 配置与 renderer 通过包出口加载；前端资源仍与本服务同目录。
 * 预览图暂时从 checkout 读取，独立 server 资源分发在后续步骤处理。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/server/ → packages/ → 仓库根 */
const REPO_DIR = resolve(HERE, '..', '..');
/** 前端三个文件与后端同目录（一起搬过来的） */
const ASSET_DIR = HERE;

/*
 * 两边要的东西不一样，别混：
 *
 *   config/report.json  只供报表渲染器使用，SDK 内置采集频道表
 *   模板 / charts / core / icons / vendor
 *                       只有渲染器要。它**就在 skill 里**，照旧按自己的
 *                       `SKILL_DIR = resolve(HERE, '..')` 定位，服务不需要灌路径。
 */
const CFG = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@atian25/zzz-stats-skill/config')), 'utf8'));

/**
 * 介绍页背景图。
 *
 * 它在**仓库根**的 `docs/preview.png`，不在 skill 里 —— 所以 skill 被单独安装、
 * 或者本文件被拷到别处时，这张图根本不存在。早先直接 `join(REPO_DIR, 'docs/preview.png')`
 * 服务它，404 之后介绍页上半屏就是一块空白（而且前端没有任何提示）。
 *
 * 现在启动时探一次：
 *   - 有：正常服务 `/assets/preview.png`
 *   - 没有：路由回 204（前端 `.intro-bg` 的背景图加载失败 → 自然留白），
 *     并在启动横幅里打一行说明，而不是静默 404。
 */
const PREVIEW_FILE = join(REPO_DIR, 'docs/preview.png');
const HAS_PREVIEW = existsSync(PREVIEW_FILE);

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3) || fallback;
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`zzz-stats 本地 Web 服务：扫码 → 取数 → 出报表

用法：node packages/server/serve.mjs [选项]

  --port <n>      端口，默认 3000
  --host <h>      监听地址，默认 0.0.0.0（手机要走局域网 IP 就保持默认）
  --max-runs <n>  同时最多几个 run，默认 8。超了返回 503
  --ttl <分钟>    结束的 run 保留多久供刷新重放，默认 30
  --help, -h      打印本帮助后退出

多人同时用：每次点「开始扫码」是一个独立的 run，互不干扰。
报表构建在内存里完成，**不写磁盘**；要归档请用 collect.mjs + build-report.mjs。
用纯 Node 路径取数，失败时把真实错误显示在页面上，不做浏览器降级。`);
  process.exit(0);
}

const PORT = Number(argOf('port', '3000'));
const HOST = argOf('host', '0.0.0.0');
const MAX_RUNS = Number(argOf('max-runs', '8'));
const TTL_MIN = Number(argOf('ttl', '30'));

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`端口不合法：${argOf('port', '')}`);
  process.exit(1);
}
if (!Number.isInteger(MAX_RUNS) || MAX_RUNS <= 0) {
  console.error(`--max-runs 不合法：${argOf('max-runs', '')}`);
  process.exit(1);
}

const TTL_MS = Math.max(1, TTL_MIN) * 60 * 1000;

// ---------------------------------------------------------------- run 表

/**
 * 所有 run。
 *
 * **这里不参与任何流程判断**：不是「当前 run」，也没有「上一个 run」的概念。
 * 它只是 `id → run` 的查表，供 `/api/events?runId=` 与 `/report?runId=` 找自己那份。
 *
 * 多人同时用时，同一个人开两个标签页也会是两个 run —— 这是对的：
 * 他们各有各的二维码，互不干扰。
 */
const RUNS = new Map();

let runCounter = 0;

function makeRunId() {
  runCounter += 1;
  // 短、可读、单进程内唯一。不用随机数：重启后旧 runId 失效本来就想让人重新开始。
  return `r${runCounter.toString(36)}-${Date.now().toString(36)}`;
}

/** 活着的（还没结束的）run 数量。并发上限只看这个。 */
function liveRunCount() {
  let n = 0;
  for (const r of RUNS.values()) if (!r.finished) n += 1;
  return n;
}

/** 回收：结束超过 TTL 的、以及已经结束且没人连着看的，释放内存。 */
function reapRuns() {
  const now = Date.now();
  for (const [id, r] of RUNS) {
    if (!r.finished) continue;
    if (r.clients.size > 0) continue;          // 还有人在看事件流，先留着
    if (now - r.finishedAt < TTL_MS) continue; // 还在「刚跑完可刷新」的窗口里
    RUNS.delete(id);
  }
}

// ---------------------------------------------------------------- 脱敏

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

// ---------------------------------------------------------------- SSE

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
  run.finishedAt = Date.now();
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
   * 这是「同一个人点了重新开始」时唯一正确的做法：旧的那张码继续轮询下去，
   * 一旦有人扫了它，就会在后台静默登录成功并开始取数 —— 用户完全不知道。
   *
   * 注意：**只有同一个 run 的发起者自己点重来才会走到这里**，
   * 不同人的 run 之间永远不会互相 cancel。
   */
  try {
    run.ac.abort();
  } catch { /* 已中止 */ }
}

/** 新建一个 run 并开始执行。**不碰任何别的 run。** */
function startRun() {
  const run = {
    id: makeRunId(),
    seq: 0,
    events: [],
    clients: new Set(),
    finished: false,
    finishedAt: 0,
    cancelled: null,
    ac: new AbortController(),
    startedAt: Date.now(),
    uid: null,
    nickname: null,
    /** 构建好的报表 HTML。**只在内存里**，不写盘。 */
    html: null,
    /** 报表里的账号信息，供 /report 的标题与实际核对。 */
    reportTitle: '',
    error: null,
  };
  RUNS.set(run.id, run);

  // 不 await：HTTP 立刻返回 runId，进度走 SSE。错误在 execute() 内部收口。
  void execute(run);
  return run;
}

/**
 * 一次完整流程：登录 → 取数 → 构建报表（全在内存里）。
 *
 * 阶段名：申请二维码 / 已登录并查到角色 / 开始取数 / 采集完成 / 构建报表。
 * SDK 的 `onProgress` 只有 login/collect/done 三个，「已登录并查到角色」没有独立事件 ——
 * 但拿到 `collect` 那一刻登录**必然已经完成**（SDK 是顺序 await 的），
 * 所以在那时补一条，不靠解析日志文本。
 */
async function execute(run) {
  const stage = (label, tone) => emit(run, 'stage', { label, tone, elapsed: Date.now() - run.startedAt });
  const log = (msg) => {
    const text = redact(msg);
    if (!text) return;
    console.log(`[zzz ${run.id}]`, text);
    emit(run, 'log', { text });
  };

  try {
    stage('申请二维码');
    /*
     * 只有这一处调 SDK。`transport` 固定 node：服务里不做浏览器降级，
     * 失败就把真实错误给用户（页面上有、控制台里也有）。
     */
    let qrDataUrl;
    const result = await collectData({
      channel: 'node',
      // 采集频道由 SDK 内置；CFG 只供下方报表渲染。
      log,
      signal: run.ac.signal,
      login: {
        method: 'qr',
        onQr: async ({ dataUrl }) => {
          qrDataUrl = dataUrl; // 等 SDK 的 qr-issued 提供协议 TTL 再发送
        },
      },
      onProgress: (ev) => {
        if (ev.stage === 'login' && ev.status === 'qr-issued' && qrDataUrl) {
          emit(run, 'qr', { dataUrl: qrDataUrl, ttlMs: ev.ttlMs });
          qrDataUrl = undefined;
          stage('二维码已生成，等待扫码');
        } else if (ev.stage === 'login' && ev.status === 'scanned') {
          stage('已扫码，等待确认');
        } else if (ev.stage === 'collect' && ev.status === 'started') {
          stage('已登录并查到角色', 'ok');
          stage('开始取数');
        } else if (ev.stage === 'done') {
          stage('采集完成', 'ok');
        }
      },
    });

    run.uid = result.gameUid;
    run.nickname = result.nickname ?? null;
    emit(run, 'account', { uid: run.uid, nickname: run.nickname });

    stage('构建报表');
    /*
     * 内存直通：`collectData()` 的 files（Map）交给 `buildReport()`。
     *
     * **必须先把 meta 塞进 files**：`collectData()` 返回的 `files` 只有 13 个键，
     * **`meta.json` 不在里面** —— 它是单独一个 `meta` 字段（见 `packages/sdk/collect.mjs` 文件头：
     * 「产出 14 个键的 Map（不含 meta.json —— 那个要昵称，由外层补）」）。
     * 少了它，报表拿不到昵称/UID/采集时间：产物照样能构建、`fatal` 是空的，
     * 只是**页面上昵称和 UID 全是空的**。CLI 那边是写盘时手动补的，
     * 这里内存直通必须自己补同样这一步。
     *
     * 键序也对齐 CLI 读盘时的顺序（index → meta → 各频道）：产物里内嵌的就是
     * `JSON.stringify(files)`，键序不同，同样数据的报文就不一样了。
     *
     * **不落盘**：多人同时用时落盘会互相覆盖（同名昵称 → 同一个账号目录），
     * 而且这个服务的产物是「当场看一次」，不是归档。
     */
    const ordered = new Map();
    if (result.files.has('index.json')) ordered.set('index.json', result.files.get('index.json'));
    ordered.set('meta.json', result.meta);
    for (const [k, v] of result.files) {
      if (k === 'index.json' || k === 'meta.json') continue;
      ordered.set(k, v);
    }

    const built = buildReport({
      files: ordered,
      cfg: CFG,
      logWarn: (m) => console.log(`[zzz ${run.id}]`, redact(m)),
    });
    if (built.fatal.length) {
      throw new Error(`构建失败（${built.fatal.length} 个致命问题）：\n${built.fatal.join('\n')}`);
    }

    run.html = built.html;
    run.reportTitle = run.nickname ? `${run.nickname} · 调频数据` : '调频数据';
    const kb = (Buffer.byteLength(built.html) / 1024 / 1024).toFixed(2);
    log(`报表已构建（${kb} MB，仅内存）`);

    emit(run, 'done', {
      url: `/report?runId=${encodeURIComponent(run.id)}`,
      nickname: run.nickname,
      uid: run.uid,
    });
    stage('完成', 'ok');
  } catch (e) {
    /*
     * 被自己点「重新开始」顶掉的运行不算失败：它本来就不该有结果。
     * 单独发一个 cancelled，让还连着的那一页知道「你这次不用等了」，
     * 而不是看到一个吓人的 AbortError。
     */
    if (run.cancelled || e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || e?.code === 'ABORTED') {
      emit(run, 'cancelled', { reason: run.cancelled ?? '已取消' });
      stage('已取消', 'muted');
      return;
    }
    const message = redact(e?.message ?? String(e)) || '未知错误';
    run.error = message;
    console.error(`[zzz ${run.id}] 失败：`, message);
    emit(run, 'error', { message });
    stage('失败', 'bad');
  } finally {
    finishRun(run);
  }
}

// ---------------------------------------------------------------- 静态资源

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/**
 * 静态资源白名单：URL → 磁盘路径。
 *
 * 用**固定表**而不是「把 /assets/ 拼成路径」：后者一旦有人请求 `/assets/../sdk/build.mjs`
 * 就会把源码吐出去。表里的每一项都是明确要提供的文件，没有第二层推断。
 */
const ASSET_ROUTES = new Map([
  ['/assets/app.js', join(ASSET_DIR, 'app.js')],
  ['/assets/style.css', join(ASSET_DIR, 'style.css')],
  /*
   * 介绍页的背景示例图：就是 README 那张报表预览，不另存一份副本。
   * **只有它可能不存在**（它在仓库根的 docs/ 下，不在 skill 里），
   * 所以单独记一个标记，路由那里回 204 而不是 404 —— 见 HAS_PREVIEW 的注释。
   */
  ['/assets/preview.png', PREVIEW_FILE],
]);

function serveFile(res, file, { immutable = false } = {}) {
  if (!existsSync(file)) {
    sendText(res, 404, '404 资源不存在\n');
    return;
  }
  const stat = statSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    // 开发服务：每次都回源，避免改了 css/js 刷新看不到变化
    'Cache-Control': immutable ? 'public, max-age=86400' : 'no-cache',
  });
  const s = createReadStream(file);
  // 文件在 stat 与读之间被删掉时，流会报错；不接就是未捕获异常
  s.on('error', () => { try { res.destroy(); } catch { /* 已关 */ } });
  s.pipe(res);
}

// ---------------------------------------------------------------- HTTP 工具

function sendText(res, code, text, type = 'text/plain; charset=utf-8', extra = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(body);
}

function sendJson(res, code, obj, extra = {}) {
  sendText(res, code, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
}

function sendHtml(res, html, code = 200) {
  sendText(res, code, html, 'text/html; charset=utf-8');
}

/** 把一条 run 的事件流接给浏览器；已结束的 run 重放完就关。 */
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

/** 从内存返回某个 run 的报表。**不读磁盘、不写磁盘。** */
function serveReport(res, run) {
  if (!run) {
    sendHtml(res, pageMessage(
      '这次运行不存在或已过期',
      '报表只保留在服务进程的内存里，重启服务或超过保留时间就会消失。<br>回首页重新扫码即可。',
      404,
    ), 404);
    return;
  }
  if (run.html) {
    sendHtml(res, run.html);
    return;
  }
  if (run.error) {
    sendHtml(res, pageMessage('这次运行失败了', escapeHtml(run.error), 500), 500);
    return;
  }
  // 还在跑：给一个会自动刷新的等待页，而不是 404
  sendHtml(res, pageMessage('报表还在生成中', '这次运行还没有跑完，页面会自动刷新。', 202, true), 202);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 极简消息页：错误、未找到、等待中都用它，避免每个分支各写一份 HTML。 */
function pageMessage(title, bodyHtml, code, autoRefresh = false) {
  const refresh = autoRefresh
    ? `<meta http-equiv="refresh" content="2">
       <script>setTimeout(function(){location.reload()},2000)</script>`
    : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>${refresh}
<style>
:root{color-scheme:light dark}
body{margin:0;padding:56px 20px;background:#f5f5f7;color:#16161a;
  font:15px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
@media (prefers-color-scheme:dark){body{background:#0e0e12;color:#ececf2}a{color:#7d93ff}
  .card{background:#17171c;border-color:#2b2b34}}
main{max-width:560px;margin:0 auto}
.card{background:#fff;border:1px solid #e4e4ea;border-radius:14px;padding:24px}
h1{font-size:18px;margin:0 0 12px}
p{color:#5a5a66;margin:0 0 14px;white-space:pre-wrap;word-break:break-word}
@media (prefers-color-scheme:dark){p{color:#a0a0ae}}
a{color:#3d5ad4}
</style></head><body><main><div class="card">
<h1>${escapeHtml(title)}</h1>
<p>${bodyHtml}</p>
<p><a href="/">← 回首页</a></p>
</div></main></body></html>`;
}

// ---------------------------------------------------------------- 路由

function readHomeHtml() {
  // 每次读盘：改了同目录下的 index.html / app.js / style.css，刷新就能看到，不用重启
  return readFileSync(join(ASSET_DIR, 'index.html'), 'utf8');
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
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      return sendHtml(res, readHomeHtml());
    }

    if (method === 'GET' && ASSET_ROUTES.has(path)) {
      /*
       * 介绍页背景图在仓库根的 docs/ 下，**skill 被单独安装时它不存在**。
       * 这里回 204（无内容）而不是 404：
       *   - 前端 `.intro-bg` 的背景图请求失败 → 自然留白，页面照常可用；
       *   - 但网络面板里不出现一条红色 404，console 也不会打 error。
       * 启动横幅会说明「没有示例图」，所以不是静默。
       */
      if (path === '/assets/preview.png' && !HAS_PREVIEW) {
        res.writeHead(204);
        return res.end();
      }
      const file = ASSET_ROUTES.get(path);
      return serveFile(res, file, { immutable: path.endsWith('.png') });
    }

    if (method === 'GET' && path === '/healthz') {
      return sendJson(res, 200, { ok: true, live: liveRunCount(), max: MAX_RUNS });
    }

    // 浏览器自己来要这个；204 让网络面板保持干净
    if (path === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    if (method === 'POST' && path === '/api/start') {
      /*
       * 并发上限。**不踢掉别人的 run** —— 那正是上一版的 bug。
       * 满了就明确告诉这个人「现在几个人在用，稍后再试」。
       */
      if (liveRunCount() >= MAX_RUNS) {
        return sendJson(res, 503, {
          message: `服务当前已有 ${MAX_RUNS} 个采集在跑，达到上限。等其中一个跑完再试（每个约 1~2 分钟）。`,
          live: liveRunCount(),
          max: MAX_RUNS,
        }, { 'Retry-After': '20' });
      }
      reapRuns();
      const run = startRun();
      return sendJson(res, 200, { runId: run.id });
    }

    if (method === 'GET' && path === '/api/events') {
      const id = String(url.searchParams.get('runId') || '');
      const run = RUNS.get(id);
      if (!run) {
        return sendText(res, 404, '404 没有这次运行（可能已过期，或服务重启过）。回首页重新开始即可。\n');
      }
      return subscribe(req, res, run);
    }

    // 只保留「按 run 查状态」，**不提供「当前 run」** —— 那就又变回全局单例了
    if (method === 'GET' && path === '/api/state') {
      const id = String(url.searchParams.get('runId') || '');
      const run = RUNS.get(id);
      if (!run) return sendJson(res, 404, { message: '没有这次运行' });
      return sendJson(res, 200, {
        runId: run.id,
        finished: run.finished,
        hasReport: Boolean(run.html),
        error: run.error,
        uid: run.uid,
        nickname: run.nickname,
        stages: run.events.filter((e) => e.type === 'stage').map((e) => e.data.label),
      });
    }

    if (method === 'GET' && (path === '/report' || path === '/report.html')) {
      const id = String(url.searchParams.get('runId') || '');
      // 没有 runId 时不猜「最近一个」—— 那会让 A 看到 B 的报表
      if (!id) {
        return sendHtml(res, pageMessage(
          '缺少 runId',
          '报表是按每次运行单独保存的，不能靠「最近一次」推断。<br>回首页重新扫码，跑完会自动跳转过来。',
          400,
        ), 400);
      }
      return serveReport(res, RUNS.get(id));
    }

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
    '',
    `  多人同时用：每次点「开始扫码」是一个独立 run，同时最多 ${MAX_RUNS} 个（--max-runs 可调）`,
    '  报表只在内存里，不写磁盘；要归档请用 collect.mjs + build-report.mjs',
    '  取数路径：纯 Node（不降级）。扫码要真人，页面会等你。',
    HAS_PREVIEW
      ? '  介绍页示例图：docs/preview.png（仓库根）'
      : `  ⚠️  没有介绍页示例图（${PREVIEW_FILE} 不存在）：页面照常可用，上半屏留白。`,
    hostNote(HOST),
    '',
  );
  console.log(lines.join('\n'));
});

/** 监听公网地址时的提醒 —— 这个页面能让局域网里任何人发起一次登录流程。 */
function hostNote(host) {
  if (host !== '0.0.0.0' && host !== '::') return '  只监听本机地址。';
  return '  ⚠️  已监听 0.0.0.0：同一局域网内的人也能打开这个页面并发起登录，用完记得关。';
}

/* 定期回收结束的 run，释放内存里那份 2 MB 的 HTML。 */
const reapTimer = setInterval(reapRuns, 60 * 1000);
reapTimer.unref();

for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => {
    for (const r of RUNS.values()) if (!r.finished) cancelRun(r, `收到 ${sig}`);
    server.close();
    process.exit(code);
  });
}
