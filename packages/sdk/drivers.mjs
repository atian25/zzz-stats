/**
 * 浏览器驱动适配层
 *
 * 两套实现，接口完全一致，`collect.mjs` 的业务流程只认接口不认实现：
 *
 *   cdp         —— 只用 Node 内置模块直讲 Chrome DevTools Protocol。零依赖，兜底方案。
 *   playwright  —— 环境里已经装了 Playwright 就直接用（更好维护：等待、frame、超时都是现成的）。
 *
 * 两者都优先驱动**用户本机的 Chrome**，不要求下载额外浏览器：
 *   - cdp 通过 --remote-debugging-port 起本机 Chrome
 *   - playwright 用 channel: 'chrome'（找不到再退回它自带的 chromium）
 *
 * 驱动接口（业务侧只用到这 6 个）：
 *   open(url)            打开页面
 *   evaluate(expr)       在主页面上下文执行 JS，支持返回 Promise
 *   waitFor(expr, ms)    轮询直到表达式为真
 *   loginFrame()         拿到跨域登录 iframe 的句柄（拿不到返回 null）
 *   evaluateInFrame(f, e) 在指定 frame 里执行 JS
 *   close()              收尾
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * 登录 iframe 的 host 判定。
 *
 * 国服登录框在 user.mihoyo.com，国际服在 hoyolab 的账号域（user / passport）。
 * 过去这里写死 mihoyo，国际服会一直等不到 frame、误报「登录框没出现」。
 * 两个域都认，另外留一个环境变量口子，官方再换域时不用改代码。
 */
export const LOGIN_FRAME_RE = (() => {
  const custom = process.env.ZZZ_LOGIN_FRAME_RE;
  if (custom) {
    try { return new RegExp(custom); } catch { /* 写错就退回默认 */ }
  }
  return /user\.mihoyo\.com|(user|passport|account)\.hoyolab\.com/;
})();

// ---------------------------------------------------------------- 公共：找 Chrome

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => {
    try { return existsSync(p); } catch { return false; }
  }) ?? null;
}

/** 额外启动参数：受限沙箱里 Chrome 自带 sandbox 常起不来。 */
export function chromeArgs() {
  return process.env.ZZZ_CHROME_ARGS ? process.env.ZZZ_CHROME_ARGS.split(' ').filter(Boolean) : [];
}

// ---------------------------------------------------------------- CDP 驱动

class CdpDriver {
  constructor() {
    this.kind = 'cdp';
    this.#id = 1;
    this.#pending = new Map();
    this.#sessionId = null;
  }

  #ws;
  #id;
  #pending;
  #sessionId;

  static async connect(port) {
    const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const d = new CdpDriver();
    d.#ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      d.#ws.addEventListener('open', () => res(), { once: true });
      d.#ws.addEventListener('error', rej, { once: true });
    });
    d.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      if (msg.id && d.#pending.has(msg.id)) {
        const { res, rej } = d.#pending.get(msg.id);
        d.#pending.delete(msg.id);
        msg.error ? rej(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`)) : res(msg.result);
      }
    });
    d.version = info.Browser;
    return d;
  }

  #send(method, params = {}, sessionId = this.#sessionId) {
    return new Promise((res, rej) => {
      const id = this.#id++;
      this.#pending.set(id, { res, rej });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async open(url) {
    const { targetInfos } = await this.#send('Target.getTargets');
    const existing = targetInfos.find((t) => t.type === 'page' && t.url.startsWith('http'));
    const targetId = existing?.targetId ?? (await this.#send('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await this.#send('Target.attachToTarget', { targetId, flatten: true });
    this.#sessionId = sessionId;
    await this.#send('Page.enable');
    await this.#send('Runtime.enable');
    await this.#send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    }).catch(() => {});
    await this.#send('Target.activateTarget', { targetId }).catch(() => {});
    await this.#send('Page.navigate', { url });
  }

  async evaluate(expression, contextId) {
    const r = await this.#send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId ? { contextId } : {}),
    });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text };
    return r.result?.value;
  }

  async waitFor(expression, timeoutMs = 30000, every = 400) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await this.evaluate(expression);
      if (v && v !== false && !(v && v.__error)) return v;
      await sleep(every);
    }
    return null;
  }

  async #frames() {
    const tree = await this.#send('Page.getFrameTree');
    const out = [];
    (function walk(n) {
      out.push(n.frame);
      (n.childFrames || []).forEach(walk);
    })(tree.frameTree);
    return out;
  }

  /**
   * 等跨域登录 frame 出现。
   * 必须轮询：外层 iframe 挂上 ≠ 登录 frame 已经建好执行上下文，
   * 只查一次会偶发拿不到（Playwright 的 frames() 同理）。
   */
  async loginFrame() {
    for (let i = 0; i < 40; i += 1) {
      const f = (await this.#frames()).find((x) => LOGIN_FRAME_RE.test(x.url));
      if (f) {
        try {
          const { executionContextId } = await this.#send('Page.createIsolatedWorld', {
            frameId: f.id,
            worldName: 'zzz-collect',
          });
          return { __cdpContext: executionContextId, url: f.url };
        } catch {
          // frame 刚建好又导航了，下一轮再试
        }
      }
      await sleep(500);
    }
    return null;
  }

  async evaluateInFrame(frame, expression) {
    return this.evaluate(expression, frame.__cdpContext);
  }

  async close() {
    try { this.#ws.close(); } catch {}
  }
}

/** 起一个带 CDP 端口的本机 Chrome（已在跑就直接连）。 */
async function launchCdp({ port, profile, bin, log }) {
  try {
    return await CdpDriver.connect(port);
  } catch {}

  log(`启动本机 Chrome：${bin}`);
  const child = spawn(bin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...chromeArgs(),
    'about:blank',
  ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr?.on('data', (b) => { stderr += b.toString(); });
  child.unref();

  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    try {
      return await CdpDriver.connect(port);
    } catch {}
  }
  const hint = stderr.trim().split('\n').slice(-3).join('\n');
  throw new Error(
    `Chrome 没在端口 ${port} 起来。\n` +
    `  1) profile 被另一个 Chrome 占用 → 换 --profile 或先关掉\n` +
    `  2) 受限沙箱 → 设 ZZZ_CHROME_ARGS='--no-sandbox --headless=new'\n` +
    `  3) 改用已开着的 Chrome：--cdp http://127.0.0.1:9222\n` +
    (hint ? `Chrome 输出：\n${hint}` : ''),
  );
}

// ----------------------------------------------------------- Playwright 驱动

class PlaywrightDriver {
  constructor(browser, page, context = null) {
    this.kind = 'playwright';
    this.browser = browser;
    this.page = page;
    // 持久化上下文：关闭时要关 context，否则 profile 不会被正确落盘
    this.context = context;
    this.version = browser ? browser.version() : 'persistent';
  }

  async open(url) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }

  async evaluate(expression) {
    // Playwright 接受字符串表达式；Promise 会自动 await
    try {
      return await this.page.evaluate(expression);
    } catch (e) {
      return { __error: e.message };
    }
  }

  async waitFor(expression, timeoutMs = 30000, every = 400) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await this.evaluate(expression);
      if (v && v !== false && !(v && v.__error)) return v;
      await sleep(every);
    }
    return null;
  }

  async loginFrame() {
    for (let i = 0; i < 40; i += 1) {
      const f = this.page.frames().find((x) => LOGIN_FRAME_RE.test(x.url()));
      if (f) return f;
      await sleep(500);
    }
    return null;
  }

  async evaluateInFrame(frame, expression) {
    try {
      return await frame.evaluate(expression);
    } catch (e) {
      return { __error: e.message };
    }
  }

  async close() {
    try {
      if (this.context) await this.context.close();
      else await this.browser.close();
    } catch {}
  }
}

/**
 * 尝试用 Playwright 起浏览器。
 * 用 channel:'chrome' 驱动本机 Chrome —— 这样不需要 Playwright 下载自带浏览器，
 * 用户装了 Chrome 就能用。找不到 Chrome 才退回 Playwright 自带的 chromium。
 */
async function launchPlaywright({ headless, log, modulePath, profile, chromium: injectedChromium }) {
  const mod = injectedChromium ? null : await import(modulePath);
  const chromium = injectedChromium ?? mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error('Playwright 模块里没有 chromium');

  const args = chromeArgs();
  const base = { headless, args };
  /*
   * 传了 profile 就用持久化上下文。
   * 否则每次都是全新临时 profile —— 登录态存不住，
   * 「先扫码、再单独跑一次取数」这种分两次执行的降级路线就没法用。
   */
  if (profile) {
    const ctx = await chromium.launchPersistentContext(profile, {
      channel: findChrome() ? 'chrome' : undefined,
      viewport: { width: 1440, height: 900 },
      ...base,
    });
    log(`Playwright 就绪（持久化 profile：${profile}）`);
    // 持久化上下文自带页面；没有就新建一个
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    return new PlaywrightDriver(ctx.browser(), page, ctx);
  }

  let browser = null;
  if (findChrome()) {
    try {
      browser = await chromium.launch({ channel: 'chrome', ...base });
      log('Playwright 就绪（驱动本机 Chrome）');
    } catch (e) {
      log(`Playwright 走 channel:chrome 失败，改用自带 chromium：${e.message.split('\n')[0]}`);
    }
  }
  if (!browser) {
    browser = await chromium.launch(base);
    log('Playwright 就绪（使用自带 chromium）');
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  return new PlaywrightDriver(browser, page);
}

/** 正常模块解析或调用方显式指定模块；不搜索宿主 profile。 */
async function resolvePlaywright(modulePath) {
  const explicit = modulePath ?? process.env.ZZZ_PLAYWRIGHT_PATH;
  if (explicit) return import.meta.resolve(explicit);
  for (const name of ['playwright', 'playwright-core']) {
    try { return import.meta.resolve(name); } catch {}
  }
  return null;
}

// ------------------------------------------------------------------ 统一入口

/**
 * 按优先级挑一个驱动：
 *   1) --cdp <url>     用户已开着的 Chrome
 *   2) --driver <name> 强制指定 cdp / playwright
 *   3) 默认：有 Playwright 就用它（更稳），否则用零依赖的 cdp（起本机 Chrome）
 *
 * @returns {Promise<CdpDriver|PlaywrightDriver>}
 */
export async function openDriver({ cdpUrl, driver, port, profile, chromium, playwrightModule, headless = true, log = console.log }) {
  const want = driver ?? (cdpUrl ? 'cdp' : (chromium || playwrightModule ? 'playwright' : null));

  if (want === 'cdp' || cdpUrl) {
    if (cdpUrl) {
      const d = await CdpDriver.connect(new URL(cdpUrl).port || 9222);
      log(`已连接现有 Chrome（CDP ${cdpUrl}）`);
      return d;
    }
    const bin = findChrome();
    if (!bin) throw new Error('本机没找到 Chrome/Chromium。用 CHROME_PATH 指定路径。');
    return launchCdp({ port, profile, bin, log });
  }

  if (want === 'playwright' || want === null) {
    const pw = chromium ? null : await resolvePlaywright(playwrightModule);
    if (chromium || pw) {
      try {
        return await launchPlaywright({ headless, log, modulePath: pw, profile, chromium });
      } catch (e) {
        if (want === 'playwright') throw e;
        log(`Playwright 启动失败，退回零依赖 CDP：${e.message.split('\n')[0]}`);
      }
    } else if (want === 'playwright') {
      throw new Error('没找到 Playwright。用 --driver cdp，或先装 playwright。');
    }
  }

  const bin = findChrome();
  if (!bin) throw new Error('本机没找到 Chrome/Chromium。用 CHROME_PATH 指定路径。');
  return launchCdp({ port, profile, bin, log });
}
