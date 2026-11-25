/** 官方页面适配：浏览器 QR/SMS 登录与页内取数。宿主展示、文件和任务策略不在这里。 */

import { openDriver } from './drivers.mjs';
import { SdkError, abortable, throwIfAborted, guardDriver } from './errors.mjs';
import { createQrClock, waitForLogin } from './qr-wait.mjs';
import { collectFiles, buildMeta, MAX_VERS } from './collect.mjs';

export { MAX_VERS };

/*
 * 登录判定的唯一口径。
 * 实测登录后正文是「UID:<数字>」——冒号紧贴数字，不是空格。
 * 早先写成 /UID\s*\d{6,}/ 要求数字紧跟空白，永远匹配不到，
 * 结果扫码成功、程序静默卡死。这里兼容半角/全角冒号与任意空白。
 * 另外「UP数量」是统计页才有的字样，作为兜底。
 */
const UID_RE_SRC = String.raw`/UID\s*[:：]?\s*\d{6,}/`;

/*
 * 登录判定表达式，扫码与短信两条路径共用。
 * 与 pageState 同一口径，避免两处写岔。
 */
const LOGGED_IN = `(() => {
  const t = document.body ? document.body.innerText : '';
  return ${UID_RE_SRC}.test(t) || t.indexOf('UP数量') >= 0 || t.indexOf('总调频次数') >= 0
    ? 'logged-in' : null;
})()`;

const pageState = `(() => {
  const root = document.querySelector('main.page');
  const text = document.body ? document.body.innerText : '';
  return {
    mounted: !!root,
    cls: root ? root.className : null,
    loggedOut: root ? (root.className || '').includes('logged-out') : null,
    hasUid: ${UID_RE_SRC}.test(text) || text.indexOf('UP数量') >= 0,
    textLen: text.length
  };
})()`;

/**
 * 短信验证码登录（给没装米游社的用户）。
 *
 * 输入通过 sms 值或 requestPhone / requestCode 回调提供。
 * 手机号和验证码由调用方取得 —— SDK 只负责填进官方表单，
 * 不代填、不猜、不落盘。
 *
 * 三条硬约束：
 *   1. 「获取验证码」只点一次，不自动重试（频繁请求会被风控）
 *   2. 验证码由用户自己输入，脚本不接触短信通道
 *   3. 页面区号写死 `+86`，所以只支持国内手机号
 */
export async function smsLogin(drv, frame, { log, sleep, LOGGED_IN, sms = {}, requestPhone, requestCode, signal, now = Date.now, progress = async () => {} }) {
  /*
   * 登录框是异步渲染的，刚进 frame 时表单往往还没进 DOM。
   * 这里轮询等它出现，而不是查一次就判失败 —— 早先那版会误报「页面结构变了」。
   */
  let form = null;
  for (let i = 0; i < 20; i += 1) {
    form = await drv.evaluateInFrame(frame, `(() => {
      const inputs = [...document.querySelectorAll('input')];
      const phone = inputs.find(i => (i.placeholder || '').indexOf('手机号') >= 0);
      const code = inputs.find(i => (i.placeholder || '').indexOf('验证码') >= 0);
      return {
        hasPhone: !!phone, hasCode: !!code,
        areaCode: (document.querySelector('.area-code') || {}).textContent || '',
      };
    })()`);
    if (form?.hasPhone && form?.hasCode) break;
    await sleep(500);
  }
  if (!form?.hasPhone || !form?.hasCode) throw new SdkError('BROWSER_PAGE_CHANGED', '没找到短信登录表单', { stage: 'login' });

  log('短信登录表单就绪');

  const fill = (which, value) => drv.evaluateInFrame(frame, `(() => {
    const inputs = [...document.querySelectorAll('input')];
    const el = inputs.find(i => (i.placeholder || '').indexOf(${JSON.stringify(which)}) >= 0);
    if (!el) return 'no-input';
    // Element UI 依赖原生 setter + input 事件才会更新内部状态
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);

  // 输入来源由调用方决定；SDK 只接收值或 requestPhone 回调。
  let phone = sms.phone ?? await requestPhone?.();
  phone = String(phone).trim();
  if (!/^\d{11}$/.test(phone)) {
    throw new SdkError('INVALID_ARGUMENT', '手机号需要 11 位数字', { stage: 'login' });
  }
  if (await fill('手机号', phone) !== 'ok') throw new SdkError('BROWSER_PAGE_CHANGED', '手机号输入框不可用', { stage: 'login' });
  log('手机号已填入');

  // 勾选协议（不勾会卡在校验上）
  await drv.evaluateInFrame(frame, `(() => {
    const cb = [...document.querySelectorAll('input')].find(i => i.type === 'checkbox');
    if (cb && !cb.checked) cb.click();
    return cb ? cb.checked : 'no-checkbox';
  })()`);

  // 只点一次，绝不自动重试
  const sent = await drv.evaluateInFrame(frame, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').indexOf('获取验证码') >= 0);
    if (!b) return 'no-button';
    if (b.disabled) return 'disabled';
    b.click();
    return 'clicked';
  })()`);
  if (sent !== 'clicked') throw new SdkError('BROWSER_PAGE_CHANGED', '发送验证码按钮不可用', { stage: 'login' });
  await progress('sms-sent');

  // 验证码的文件/终端等待在 CLI；不在 SDK 保存凭据中转文件。
  let code = sms.code ?? await requestCode?.();
  code = String(code).trim();
  if (!/^\d{4,8}$/.test(code)) throw new SdkError('INVALID_ARGUMENT', '验证码需要 4 到 8 位数字', { stage: 'login' });
  if (await fill('验证码', code) !== 'ok') throw new SdkError('BROWSER_PAGE_CHANGED', '验证码输入框不可用', { stage: 'login' });
  log('验证码已填入');

  const submitted = await drv.evaluateInFrame(frame, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '登录');
    if (!b) return 'no-button';
    if (b.disabled) return 'disabled';
    b.click();
    return 'clicked';
  })()`);
  if (submitted !== 'clicked') throw new SdkError('BROWSER_PAGE_CHANGED', '短信登录按钮不可用', { stage: 'login' });
  await progress('sms-submitted');

  const deadline = now() + 60000;
  while (now() < deadline) {
    if (await drv.evaluate(LOGGED_IN) === 'logged-in') {
      log('登录成功 ✓');
      await progress('confirmed');
      return;
    }
    await sleep(1500);
  }
  throw new SdkError('LOGIN_TIMEOUT', '短信提交后仍未检测到登录态', { stage: 'login' });
}

export async function loginFlow(drv, opts = {}) {
  const {
    // 登录方式：qr（默认）/ sms
    mode = 'qr',
    sms = {},
    // 二维码回调与抽象输入
    onQr = null,
    input = {},
    maxRefresh = 3,
    minGapMs = 5000,
    pollMs = 3000,
    maxWaitMs = 600000,
    signal, now = Date.now, progress = async () => {},
    /*
     * 日志。改前 `loginFlow` 是 `scripts/collect.mjs` 里的内部函数，直接用外层闭包的
     * 全局 `log`；拆成 lib 模块后那个闭包没了，**必须**从 opts 传进来。
     * 漏了它的症状是 `ReferenceError: log is not defined` —— 只在真正走到
     * 那几行时炸，所以构造函数/静态检查都发现不了。
     */
    log = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  // 等到「已挂载 且 状态明确」：mounted 但既没 logged-out 也没 UID，说明还在加载
  const ready = await drv.waitFor(`(() => {
    const s = ${pageState};
    return s.mounted && (s.loggedOut === true || s.hasUid) ? s : null;
  })()`, 40000);
  if (!ready) {
    throw new SdkError('BROWSER_PAGE_CHANGED', '页面没有进入确定登录状态', { stage: 'login' });
  }

  if (ready.hasUid) {
    await progress('confirmed');
    return;
  }

  /*
   * 登录方式：
   *   qr    —— 扫码（默认，需要米游社 App）
   *   sms   —— 短信验证码（给没装米游社的用户用的备选路线）
   *
   * 自动判断依据：让 agent 在交付二维码之前先问一句「扫码还是短信」，
   * 由调用方传 --login=sms；环境变量 ZZZ_LOGIN_MODE 也可以。
   */
  // 1) 点登录（按元素点，不用坐标——多数环境不支持坐标级输入）
  const clicked = await drv.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '登录');
    if (!b) return 'no-button';
    if (b.disabled) return 'disabled';
    b.click();
    return 'clicked';
  })()`);
  log('点击登录：', clicked);
  if (clicked === 'disabled') {
    await sleep(2500);
    await drv.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '登录');
      if (b && !b.disabled) { b.click(); return 'clicked'; }
      return 'still-disabled';
    })()`);
  }

  // 2) 等跨域登录 frame
  const frame = await drv.loginFrame();
  if (!frame) {
    if (!input.requestManualAction) {
      throw new SdkError('INPUT_REQUIRED', '登录 frame 不可用，需要人工操作回调', { stage: 'login' });
    }
    await progress('manual-action-required');
    await abortable(() => input.requestManualAction({ reason: 'login-frame-unavailable', signal }), signal);
    const deadline = now() + maxWaitMs;
    while (now() < deadline) {
      throwIfAborted(signal);
      if (await drv.evaluate(LOGGED_IN) === 'logged-in') {
        await progress('confirmed');
        return;
      }
      await sleep(pollMs);
    }
    throw new SdkError('LOGIN_TIMEOUT', '人工操作后仍未检测到登录态', { stage: 'login' });
  }
  log('已进入登录 frame');

  /*
   * 分流点。
   * 登录框默认就停在短信登录页（#/login/captcha），所以走短信不需要切 tab。
   */
  if (mode === 'sms') {
    if ((!sms.phone && !input.requestPhone) || (!sms.code && !input.requestCode)) {
      throw new SdkError('INPUT_REQUIRED', '短信登录需要手机号与验证码输入回调', { stage: 'login' });
    }
    await smsLogin(drv, frame, { log, sleep, LOGGED_IN, sms, signal, now, progress, ...input });
    return;
  }

  // 3) 默认是短信登录，切到扫码。图标不在 = 已经在扫码模式，不用点。
  for (let i = 0; i < 6; i += 1) {
    const hit = await drv.evaluateInFrame(frame, `(() => {
      const svg = document.querySelector('.qr-login-btn svg');
      const box = document.querySelector('.qr-login-btn');
      const target = svg || box;
      if (!target) return 'no-target';
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'clicked:' + target.tagName;
    })()`);
    await sleep(1200);

    /*
     * 用 hash 判断真实模式，不要靠图片尺寸猜。
     * 登录框默认在 #/login/captcha（短信登录），要切到 #/login/qr 才是扫码；
     * 短信页里也有一张 232×80 的图片，按尺寸判断会误报「已在扫码模式」，
     * 结果就是打印了二维码路径、用户却扫了一张不存在的码。
     */
    const mode = await drv.evaluateInFrame(frame, `(() => {
      const qr = [...document.images]
        .filter(i => (i.src || '').startsWith('data:image'))
        .map(i => ({ w: i.naturalWidth, h: i.naturalHeight }))
        .find(i => i.w >= 120 && i.h >= 120 && Math.abs(i.w - i.h) <= 8);
      return { hash: location.hash || '', hasQr: !!qr, qr };
    })()`);

    if (mode?.hasQr) { if (i === 0) log('已在扫码模式'); break; }
    if (i === 0) log('切换到扫码：', hit, `（当前 ${mode?.hash || 'hash 未知'}）`);

    /*
     * 首轮 no-target 不一定是真失败：登录框刚渲染时图标还没进 DOM。
     * 多等几轮再判定，最后一轮仍失败才报错 —— 否则偶发的慢渲染会被当成缺陷。
     */
    if (hit === 'no-target' && !mode?.hasQr && i >= 4) {
      throw new SdkError('BROWSER_PAGE_CHANGED', '未能切到扫码模式', { stage: 'login' });
    }
  }

  /*
   * 二维码是 data URL，直接读，不要截屏裁图。
   * 登录框里还有一张 60×60 的 logo data URL，必须按「够大 + 近似正方形」筛掉。
   */
  const readQr = `(() => {
    const imgs = [...document.images]
      .filter(i => (i.src || '').startsWith('data:image'))
      .map(i => ({ src: i.src, w: i.naturalWidth, h: i.naturalHeight }))
      .filter(i => i.w >= 120 && i.h >= 120 && Math.abs(i.w - i.h) <= 4);
    imgs.sort((a, b) => b.w * b.h - a.w * a.h);
    return imgs[0] || null;
  })()`;

  const grabQr = async () => {
    let q = null;
    for (let i = 0; i < 25 && !q; i += 1) {
      q = await drv.evaluateInFrame(frame, readQr);
      if (!q || q.__error) { q = null; await sleep(700); }
    }
    return q;
  };

  /** 登录框自己的「二维码已过期」按钮，点了会换一张新的。 */
  const refreshQr = async () => {
    const hit = await drv.evaluateInFrame(frame, `(() => {
      const el = document.querySelector('.qr-expired') || [...document.querySelectorAll('*')]
        .find(e => /二维码.*(过期|失效)|点击刷新|点击重新获取/.test(e.textContent || '') && e.children.length === 0);
      if (!el) return 'no-expired-node';
      el.click();
      return 'clicked';
    })()`);
    await sleep(2500);
    return hit;
  };

  const QR_TTL_MS = 120_000; // 官方二维码约两分钟失效，属于协议估计
  const clock = createQrClock({ ttlMs: QR_TTL_MS, now });
  const emitQr = async q => {
    await onQr?.({ dataUrl: q.src });
    clock.reissue();
    await progress('qr-issued', { ttlMs: QR_TTL_MS });
  };
  const qr = await grabQr();
  if (qr?.src) await emitQr(qr);
  else await progress('qr-unavailable');

  const unsubscribe = input.subscribeRefresh?.() ?? (() => {});

  let result;
  try {
    result = await waitForLogin({
      isLoggedIn: () => drv.evaluate(LOGGED_IN),
      refreshQr,
      grabQr,
      emitQr,
      clock,
      takeRefreshRequest: input.takeRefreshRequest,
      maxRefresh,
      minGapMs,
      pollMs, maxWaitMs, sleep, now, signal, progress,
    });
  } finally {
    unsubscribe();
  }

  if (!result.ok) throw new SdkError('LOGIN_TIMEOUT', '等待登录超时', { stage: 'login' });
  await progress('confirmed');
}

// ------------------------------------------------------------------ 取数

async function readUid(drv) {
  const uid = await drv.evaluate(`(() => {
    const t = document.body ? document.body.innerText : '';
    const m = t.match(/UID[\\s:：]*([0-9]{6,})/);
    return m ? m[1] : null;
  })()`);
  return typeof uid === 'string' && /^\d{6,}$/.test(uid) ? uid : null;
}

/** 页内 fetch：只有官方页面这个源被接口的 CORS 放行。 */
async function fetchJson(drv, api, region, uid, path, extra = '') {
  const url = `${api}${path}?uid=${encodeURIComponent(uid)}&region=${encodeURIComponent(region)}${extra ? '&' + extra : ''}`;
  const body = await drv.evaluate(`fetch(${JSON.stringify(url)}, { credentials: 'include' }).then(r => r.text())`);
  if (typeof body !== 'string') throw new SdkError('INVALID_RESPONSE', '页内 fetch 未返回文本', { stage: 'collect', endpoint: path });
  let json;
  try { json = JSON.parse(body); } catch (cause) { throw new SdkError('INVALID_RESPONSE', '页内 fetch 返回非 JSON', { stage: 'collect', endpoint: path, cause }); }
  if (!json || typeof json.retcode !== 'number' || !json.data && json.retcode === 0) throw new SdkError('INVALID_RESPONSE', '页内响应缺少必要字段', { stage: 'collect', endpoint: path });
  if (json.retcode !== 0) {
    throw new SdkError(json.retcode === -100 ? 'AUTH_EXPIRED' : 'UPSTREAM_ERROR',
      `${path}: 上游业务错误 ${json.retcode}`, { stage: 'collect', retcode: json.retcode, endpoint: path });
  }
  return json;
}

/**
 * 浏览器扫码登录：打开官方页面 → 等登录态 → 读 UID。**只做登录，不取数。**
 *
 * 与 `loginByQrNode()` 并列的另一条登录路径。区别只在「怎么登录」：
 * 这条路是官方页面自己发请求，签名/风控/CORS 全由官方前端处理。
 *
 * **不降级、不重试**：失败就抛。要不要换到纯 Node 是调用方的策略。
 *
 * @param {object} args
 * @param {object} [args.driver]  openDriver 参数（cdpUrl / driver / port / profile / headless）
 * @param {string} args.pageUrl   官方页面
 * @returns {Promise<{uid: string, nickname: string|null, drv: object}>}
 *        **`drv` 要由调用方关**（见 `closeBrowserSession`）；登录和取数分两次调用时，
 *        中间这个浏览器上下文必须留着，cookie 在它里面。
 */
export async function loginByQrBrowser({
  driver = {},
  pageUrl,
  region = 'prod_gf_cn',
  loginMode = 'qr',
  onQr = null,
  input = {},
  sms = {},
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs, maxWaitMs, maxRefresh, minGapMs, signal, now = Date.now, progress = async () => {},
} = {}) {
  const owned = typeof driver.open !== 'function';
  let drv;
  try { drv = owned ? await openDriver({ ...driver, driver: driver.kind, log, signal }) : driver; }
  catch (cause) { if (cause instanceof SdkError) throw cause; throw new SdkError('BROWSER_UNAVAILABLE', '浏览器不可用', { stage: 'driver', cause }); }
  log(`驱动：${drv.kind}（${drv.version ?? '未知版本'}）`);

  try {
    const active = guardDriver(drv, signal, 'login');
    await active.open(pageUrl);
    await loginFlow(active, {
      mode: loginMode,
      onQr,
        input,
        sms,
      log,
      sleep,
      pollMs, maxWaitMs, maxRefresh, minGapMs, signal, now, progress,
    });

    const uid = await readUid(active);
    if (!uid) throw new SdkError('ROLE_NOT_FOUND', '拿不到游戏 UID', { stage: 'login' });
    log('UID', uid, 'region', region);

    const nickname = await readNickname(active);
    throwIfAborted(signal);
    // 登录 signal 不绑定到长期会话；后续 collect 使用自己的 signal。
    if (owned) drv.signal = undefined;
    return { uid, nickname, drv, owned };
  } catch (e) {
    /*
     * 失败时才关浏览器：成功时 `drv` 要交给 `collectViaBrowser()` 继续用
     * （登录态在那个上下文里，关了就白扫一次码）。
     */
    if (owned) await drv.close?.();
    throw e;
  }
}

/** 从页面文本里找昵称。接口不返回昵称，只有页面有。 */
async function readNickname(drv) {
  const nickname = await drv.evaluate(`(() => {
    const t = (document.body ? document.body.innerText : '').split('\\n').map(s => s.trim()).filter(Boolean);
    const idx = t.findIndex(s => /^UID/.test(s) || /^\\d{6,}$/.test(s));
    for (let i = 0; i < Math.min(t.length, 25); i += 1) {
      if (i === idx) continue;
      if (/^[\\u4e00-\\u9fa5A-Za-z0-9·_-]{1,16}$/.test(t[i]) && !/^(登录|绝区零|调频|UID|国服|全部|当前|历史)/.test(t[i])) return t[i];
    }
    return null;
  })()`);
  return typeof nickname === 'string' && nickname.length && !nickname.includes('\n') ? nickname : null;
}

/**
 * 浏览器取数：在已登录的页面上下文里页内 fetch → 14 个键的 Map。
 *
 * 与 `collectViaNode()` 并列的另一条取数路径。**不降级**：失败就抛。
 *
 * 注意这里**不关 drv**：它可能是调用方传进来的、别处还要用的（比如取完数还要截图）。
 * 关闭走 `closeBrowserSession()`，由调用方决定时机。
 *
 * @param {object} args
 * @param {object} args.drv       `loginByQrBrowser()` 返回的 drv
 * @param {string} args.api       act 接口基址
 * @param {string} args.uid       游戏 UID
 * @param {Array}  args.channels  频道表
 * @returns {Promise<{files: Map<string, unknown>, summary: object, meta: object, index: object}>}
 */
export async function collectViaBrowser({
  drv,
  api,
  uid,
  region = 'prod_gf_cn',
  channels,
  nickname = null,
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchedAt = undefined,
  isCn = undefined,
  signal, progress = async () => {},
} = {}) {
  if (!drv) throw new SdkError('INVALID_ARGUMENT', 'collectViaBrowser 需要 drv');
  if (!uid) throw new SdkError('INVALID_ARGUMENT', 'collectViaBrowser 需要 uid');

  drv = guardDriver(drv, signal, 'collect');

  const transport = {
    kind: 'browser',
    fetchJson: (path, query = '') => fetchJson(drv, api, region, uid, path, query),
  };
  const { files, summary, index } = await collectFiles({ transport, channels, log, sleep, signal, progress });

  const safeNickname = nickname ?? await readNickname(drv);
  files.set('meta.json', buildMeta({
    index, uid, nickname: safeNickname, region, api, summary, fetchedAt,
    isCn: isCn ?? /^prod_gf_cn$/i.test(region),
  }));

  return { files, summary, meta: files.get('meta.json'), index };
}

/** 关掉 `loginByQrBrowser()` 开出来的浏览器上下文。**幂等**：没开着也不报错。 */
export async function closeBrowserSession(drv) {
  await drv?.close?.();
}
