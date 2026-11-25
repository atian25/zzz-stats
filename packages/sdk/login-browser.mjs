/**
 * 浏览器路径：登录（扫码 iframe / 短信）+ 页内取数。
 *
 * 这是改前 `scripts/collect.mjs` 的主体，原样搬过来，只把「命令行外壳」的依赖
 * 改成参数注入：`argOf()` / `OUTPUT_DIR` / `WORK_DIR` / `KEEP_VERIFY` / 全局 `stdin`
 * 都不再直接出现，由调用方（`scripts/collect.mjs` 或未来的服务）传进来。
 *
 * ## 为什么留着这条路
 *
 * 纯 Node 那条路（`lib/login-node.mjs`）只做国服、且依赖逆向来的私有 header。
 * 浏览器这条路是**官方页面自己发请求**，签名/CORS/风控全由官方前端处理，
 * 只要页面还能登录就还能用。所以它是默认降级目标：
 *
 *   默认 transport = node；node 失败（比如国际服、或 app_id 失效）→ 自动降到 browser，
 *   并在日志里明确打一行说明为什么降级（`lib/collect.mjs` 的调用方负责打）。
 *
 * ## 这段代码的特点
 *
 * 全是真实页面交互：点登录按钮、等跨域 iframe、切扫码 tab、读 data URL 二维码、
 * 轮询登录态、页内 fetch。**改动风险高**（官方改一次 DOM 就失效），
 * 所以这里的注释保留得比别处详细 —— 每一处「为什么这么写」都是踩过的坑。
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdout } from 'node:process';
import { openDriver } from './drivers.mjs';
import { createRefreshInput, createQrClock, waitForLogin, refreshChannelHint, REFRESH_SIGNAL_FILE } from './qr-wait.mjs';
import { collectFiles, buildMeta, MAX_VERS } from './collect.mjs';

export { MAX_VERS };

/*
 * 交互提问。
 *
 * 只在「用户自己在本机终端里手动跑」时才走这条路 —— 那是个合法场景，
 * 但**不是默认场景**。agent 代跑时用户根本不碰终端，
 * 所以固定输入必须能通过参数/文件送进来，不能指望 stdin。
 */
async function ask(question, stdinStream) {
  if (!stdinStream?.isTTY) {
    throw new Error(
      `需要交互输入（${question}），但当前不是终端环境。\n` +
      '→ agent 代跑时请用 --phone=... 传手机号、--code-file=... 传验证码。'
    );
  }
  const rl = createInterface({ input: stdinStream, output: stdout });
  const answer = await rl.question(`${question} … `);
  rl.close();
  return answer;
}

/** 等用户给一个值（手机号/验证码），**不依赖终端**。改前在 collect.mjs 里，原样搬来。 */
export async function readInputFile(file, { label, timeoutMs, validate, log, sleep }) {
  const deadline = Date.now() + timeoutMs;
  let complained = null;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      let raw = '';
      try { raw = readFileSync(file, 'utf8').trim(); } catch { /* 正在写，下一轮再读 */ }
      if (raw) {
        try { rmSync(file); } catch {}
        if (!validate || validate(raw)) return raw;
        if (complained !== raw) {
          complained = raw;
          log(`⚠️  ${label}格式不对（收到 ${raw.length} 位），已忽略，请重新写入。`);
        }
      }
    }
    await sleep(400);
  }
  throw new Error(
    `${label}等待超时（${Math.round(timeoutMs / 1000)} 秒）。` +
    `agent 应把用户给的值写入 ${file}。`
  );
}

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
 * 前提：必须在**真终端**里跑（stdin 是 TTY）。
 * 手机号和验证码都由用户在终端里输入 —— 脚本只负责填进官方表单，
 * 不代填、不猜、不落盘。
 *
 * 三条硬约束：
 *   1. 「获取验证码」只点一次，不自动重试（频繁请求会被风控）
 *   2. 验证码由用户自己输入，脚本不接触短信通道
 *   3. 页面区号写死 `+86`，所以只支持国内手机号
 */
async function smsLogin(drv, frame, { ask, log, sleep, LOGGED_IN, sms, purge, workDir, outputDir, stdinStream }) {
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
  if (!form?.hasPhone || !form?.hasCode) throw new Error('没找到短信登录表单（页面结构可能变了）。');

  log(`短信登录，区号 ${form.areaCode || '+86'}（页面写死，仅支持国内号码）`);

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

  /*
   * 手机号来源，优先级从高到低：
   *   1. --phone=<号码>      agent 已经问到了，直接传
   *   2. --phone-file=<路径>  号码写在文件里（对话里粘过的值可以先落文件）
   *   3. 终端提问            仅当用户自己在本机手动跑；agent 代跑时没有 TTY，会明确报错
   */
  const phoneArg = sms.phone ?? process.env.ZZZ_PHONE ?? null;
  let phone = phoneArg;
  if (!phone) {
    const phoneFile = sms.phoneFile ?? null;
    if (phoneFile) {
      phone = await readInputFile(resolve(workDir, phoneFile), {
        label: '手机号', timeoutMs: 5 * 60 * 1000, log, sleep,
        validate: (v) => /^\d{11}$/.test(v),
      });
    } else if (stdinStream?.isTTY) {
      phone = (await ask('请输入手机号（11 位，仅用于填入官方登录框）', stdinStream)).trim();
    } else {
      throw new Error(
        '需要手机号但没有来源。agent 代跑时请传 --phone=<11 位>（推荐），' +
        '或在对话里问到后写入文件再传 --phone-file=<路径>。'
      );
    }
  }
  phone = String(phone).trim();
  if (!/^\d{11}$/.test(phone)) {
    throw new Error(`手机号格式不对（需要 11 位数字，收到 ${phone.length} 位），已中止。`);
  }
  if (await fill('手机号', phone) !== 'ok') throw new Error('手机号填不进去。');
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
  log(sent === 'clicked' ? '已请求发送验证码（只请求一次，不会重复发）' : `发送验证码：${sent}`);

  /*
   * 验证码来源，优先级同手机号：
   *   1. --code=<验证码>
   *   2. --code-file=<路径>（默认就是它：短信到了才知道码，agent 写文件最顺手）
   *   3. 终端提问（用户本机手动跑）
   *
   * 默认文件路径固定成 output/sms-code.txt，
   * 这样 agent 不用额外协商路径，按约定写就行。
   * 放 output/ 根而不是账号目录：账号名此刻还不知道（昵称要等采集完），
   * 而验证码在登录过程中就要用。登录成功即删，见 verify-cleanup.mjs。
   */
  const codeFile = resolve(workDir, sms.codeFile ?? join(outputDir, 'sms-code.txt'));
  let code = sms.code ?? process.env.ZZZ_SMS_CODE ?? null;
  if (!code) {
    if (stdinStream?.isTTY) {
      code = (await ask('请输入收到的验证码（通常 60 秒内有效）', stdinStream)).trim();
    } else {
      mkdirSync(dirname(codeFile), { recursive: true });
      log(`等待验证码…（短信约 60 秒失效，收到请尽快写入 ${codeFile}）`);
      code = await readInputFile(codeFile, {
        label: '验证码', timeoutMs: 5 * 60 * 1000, log, sleep,
        validate: (v) => /^\d{4,8}$/.test(v),
      });
    }
  }
  code = String(code).trim();
  if (!/^\d{4,8}$/.test(code)) throw new Error('验证码格式不对，已中止。');
  if (await fill('验证码', code) !== 'ok') throw new Error('验证码填不进去。');
  log('验证码已填入');

  const submitted = await drv.evaluateInFrame(frame, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '登录');
    if (!b) return 'no-button';
    if (b.disabled) return 'disabled';
    b.click();
    return 'clicked';
  })()`);
  log(`提交登录：${submitted}`);

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await drv.evaluate(LOGGED_IN) === 'logged-in') {
      log('登录成功 ✓');
      // 短信路线没有二维码，但 sms-code.txt 里是明文验证码，同样不能留在盘上
      purge({ when: '登录成功' });
      return;
    }
    await sleep(1500);
  }
  throw new Error('短信登录后仍未检测到登录态。可能是验证码错误，或需要完成滑块验证。');
}

/**
 * 登录方式的默认值。
 *
 * 改前在 `scripts/collect.mjs` 里（一行 `return 'qr'`），拆 lib 时漏搬了 ——
 * 症状是浏览器路径一启动就 `ReferenceError: detectLoginMode is not defined`，
 * 而且只在**没传 --login** 时触发（传了就短路，不走到这里），最容易漏测。
 *
 * 保留成函数而不是内联常量：环境变量 `ZZZ_LOGIN_MODE` 存在时优先它，
 * 这里的返回值只是「两者都没有」时的兜底。
 */
function detectLoginMode() {
  return 'qr';
}

async function loginFlow(drv, opts = {}) {
  const {
    // 登录方式：qr（默认）/ sms
    mode: modeIn = null,
    // 扫码阶段的回调与落点（原先是 collect.mjs 里的 saveQr / 图片服务 / OUTPUT_DIR）
    onQr = null,
    saveQrFile,
    qrUrlFor = () => null,
    outputDir,
    refreshSignalFile,
    purge,
    waitMode = 'a',
    stdinRaw = false,
    stdinStream = null,
    // 二维码不落盘时的提示（服务的调用方可能只想把 dataUrl 发出去）
    persistQr = true,
    maxRefresh = 3,
    minGapMs = 5000,
    /*
     * 日志。改前 `loginFlow` 是 `scripts/collect.mjs` 里的内部函数，直接用外层闭包的
     * 全局 `log`；拆成 lib 模块后那个闭包没了，**必须**从 opts 传进来。
     * 漏了它的症状是 `ReferenceError: log is not defined` —— 只在真正走到
     * 那几行时炸，所以构造函数/静态检查都发现不了。
     */
    log = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  const mode = String(modeIn || process.env.ZZZ_LOGIN_MODE || detectLoginMode()).toLowerCase();
  // 等到「已挂载 且 状态明确」：mounted 但既没 logged-out 也没 UID，说明还在加载
  const ready = await drv.waitFor(`(() => {
    const s = ${pageState};
    return s.mounted && (s.loggedOut === true || s.hasUid) ? s : null;
  })()`, 40000);
  if (!ready) {
    const last = await drv.evaluate(pageState);
    throw new Error(`页面没有进入确定状态：${JSON.stringify(last)}（标签页被节流或网络不可达）`);
  }

  if (ready.hasUid) {
    log('已登录（登录态来自浏览器 profile）');
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
    /*
     * 登录框没起来。
     * 以前这里让人回车 —— 用户根本不在终端里，等于永久挂起。
     * 现在改成：有 TTY 才等其他，否则直接抛错让 agent 处理
     * （agent 可以说「请在浏览器窗口里手动点登录」再重跑）。
     */
    if (!stdinRaw) {
      throw new Error(
        '登录框（跨域 iframe）没出现。请在浏览器窗口里手动点「登录」，然后重跑一次脚本' +
        '（登录态会留在 profile 里，第二次会直接跳过登录）。'
      );
    }
    log('⚠️  登录框（跨域 iframe）没出现。');
    log('    请在浏览器里手动点「登录」并扫码，完成后回到这里按回车。');
    await ask('按回车继续', stdinStream);
    return;
  }
  log('已进入登录 frame');

  /*
   * 分流点。
   * 登录框默认就停在短信登录页（#/login/captcha），所以走短信不需要切 tab。
   */
  if (mode === 'sms') {
    await smsLogin(drv, frame, { ask, log, sleep, LOGGED_IN, sms, purge, workDir: outputDir, outputDir, stdinStream });
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
      throw new Error(
        `未能切到扫码模式（登录框停在 ${mode?.hash || '未知页面'}）。` +
        '请在浏览器里手动点左上角的扫码图标后再重试。'
      );
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

  /*
   * 存二维码：**固定文件名** `output/login-qr.png`，覆盖写。
   *
   * 早先用「带时间戳的唯一文件名」来躲缓存——覆盖同名文件时，浏览器、图片组件、
   * CDN 中间层都可能继续显示旧图，用户扫到的是一张已经作废的码（SKILL.md 记过这个坑）。
   * 现在改成**盘上固定名、URL 带 `?t=<毫秒>`**：新时间戳 = 新 URL，缓存自然失效，
   * 而清理时只需要认一个文件名，不用扫一堆历史截图。
   *
   * 返回值里的 `url` 每次都带新的 `?t=`，调用方必须用**最新那行**地址。
   */
  /*
   * 二维码交出去。
   *
   * **改前这里直接写盘**（`output/login-qr.png` + 图片服务 URL）。现在落盘由调用方
   * 通过 `saveQrFile` 注入：SDK 不写盘，服务里可能只想把 dataUrl 发回前端。
   * 返回 `{ png, url }` 的形状保持不变 —— waitForLogin() 的日志在用。
   */
  const saveQr = (q) => {
    if (!persistQr) {
      const saved = { png: null, url: null };
      onQr?.({ dataUrl: q.src, ...saved });
      return saved;
    }
    const saved = saveQrFile(q.src);
    const url = qrUrlFor();
    onQr?.({ dataUrl: q.src, file: saved, url });
    return { png: saved, url };
  };

  const QR_TTL_MS = 120_000;   // 官方二维码约 2 分钟失效
  const qr = await grabQr();   // 首次那张，用于打印路径/URL；换图后的保存由 waitForLogin 内部做
  /*
   * 计时器抽成对象（见 qr-wait.mjs）：`reissue()` 负责「换新码重置起点」。
   * 早先这里是裸的 `let issuedAt`，刷新后忘了重置 —— 新码一出来就被判过期。
   */
  const clock = createQrClock({ ttlMs: QR_TTL_MS });
  let issuedAt = clock.issuedAt;

  if (qr?.src) {
    const { png: file, url } = saveQr(qr);
    const expires = new Date(issuedAt + QR_TTL_MS);
    log(`二维码已保存（${qr.w}×${qr.h}）：${file}`);
    log(`截取时间 ${new Date(issuedAt).toLocaleTimeString('zh-CN', { hour12: false })}，` +
        `约 ${expires.toLocaleTimeString('zh-CN', { hour12: false })} 失效（2 分钟）`);
    // 给 agent 一行能直接塞进图片组件的地址；没有服务就给文件路径
    if (url) log(`二维码图片地址：${url}`);
    log('请用米游社 App 扫码，打开这张图扫即可。');
  } else {
    log('ℹ️  没读到二维码图片（可能画在 canvas 上）。请在浏览器窗口里直接扫码。');
  }

  /*
   * 扫码期间的刷新。
   *
   * 两条硬约束，都是为了不给对方的登录接口添麻烦：
   *   1) 只由用户主动要求时刷新（终端按 r 或 agent 写信号文件）；
   *      循环里查的是**登录态**（本地 DOM 读取），
   *      不是反复请求二维码——没有用户操作就绝不重取
   *   2) 全局最多重取 MAX_QR_REFRESH 次，两次之间至少隔 5 秒
   * 用户离开时循环只在读登录态，不会对着登录接口空转。
   */
  const MAX_QR_REFRESH = maxRefresh;
  const REFRESH_MIN_GAP_MS = minGapMs;
  const REFRESH_SIGNAL = refreshSignalFile;
  // 次数上限与最短间隔由 waitForLogin() 执行，这里只负责把参数传下去

  /*
   * 扫码阶段必须「自动轮询登录态 + 非阻塞监听键盘」。
   *
   * 之前这里是 `await ask(...)` 先阻塞等人按回车，按完才去轮询登录——
   * 用户扫完码什么都不发生，得自己回来敲回车，体验是坏的。
   * 现在改成：主循环每 3 秒查一次登录态，命中立刻继续；
   * 刷新由两条独立通道触发（按 r / 信号文件），同样受 3 次上限与 5 秒间隔约束。
   */
  /*
   * 扫码等待策略，按「当前会话能不能挂着等」分两档：
   *
   *   A 档（默认）：宿主支持后台任务 —— 调用方可以把本进程挂起来等，
   *                检测到登录就自己往下走，用户扫完什么都不用做。
   *   B 档：宿主只能一次性执行 —— 本进程等不到用户扫码就会退出，
   *                所以要明确告诉用户「扫完回我一句『已扫码』」，由调用方再跑一次续上。
   *
   * 判定顺序：
   *   1. --wait=a|b 或 ZZZ_WAIT_MODE=a|b（调用方知道自己有没有后台能力，优先听它的）
   *   2. 默认 a（交互终端下本来就是挂着等，非交互由调用方决定）
   *
   * B 档能续上的前提是 profile 持久化：扫码产生的 cookie 留在 profile 里，
   * 第二次运行时直接就是登录态。
   */
  // waitMode 由调用方给（改前是 --wait / ZZZ_WAIT_MODE 解析出来的）

  /*
   * 有没有终端只影响**提示文案**，不影响刷新通道的判断。
   *
   * 早先它同时决定了「听不听按键」和「查不查信号文件」，于是两条通道变成二选一，
   * agent 代跑时（进程有 TTY、但 agent 没法发按键）写信号文件完全没人读。
   * 现在两条通道并行生效，判断逻辑在 waitForLogin() 里，且**不接受 stdinRaw**。
   */
  // stdinRaw 由调用方给（改前是 Boolean(stdin.isTTY)）

  log(`正在等待扫码…（二维码过期最多换 ${MAX_QR_REFRESH} 次）`);
  if (waitMode === 'b') {
    log('');
    log('扫码完成后，回到对话里回复一句「已扫码」—— 我会接着把数据取下来。');
    log('（当前宿主只能一次性执行，没法在这里挂着等）');
    log('');
  } else {
    log('扫码后会自动继续，不需要任何操作。');
  }
  log(refreshChannelHint({ signalFile: REFRESH_SIGNAL, stdinRaw }));

  // 心跳里附带的页面快照：出问题时能直接看出「扫码前后页面到底有没有变化」
  const snapshot = `(() => {
    const t = document.body ? document.body.innerText : '';
    return { len: t.length, head: t.replace(/\\s+/g, ' ').slice(0, 60) };
  })()`;

  /*
   * 刷新通道的接线：只在这里碰 stdin。
   * 判断（哪条通道命中、要不要刷新、刷新限流、计时重置）全在 qr-wait.mjs 的
   * waitForLogin() 里 —— 那段必须能被用例**真实执行**地测，不能再靠肉眼。
   */
  const input = createRefreshInput();
  const onData = (buf) => input.press(buf);
  if (stdinRaw && stdinStream) {
    // raw 模式关掉了终端行编辑，每个按键都会进 data；isRefreshKey 只认单个 r/R
    stdinStream.setRawMode?.(true);
    stdinStream.resume();
    stdinStream.on('data', onData);
  }

  let result;
  try {
    result = await waitForLogin({
      isLoggedIn: () => drv.evaluate(LOGGED_IN),
      /*
       * 心跳只是「我还活着」的信号，不能因为一次取快照失败就报警或中断。
       * 两个坑都在这儿踩过：
       *   1) drv.evaluate 出错返回的是 {__error}，它**是 truthy**，
       *      直接读 snap.len 会得到 undefined，日志变成「页面 undefined 字」
       *   2) 页面导航瞬间执行上下文会被销毁，属于瞬时错误，重试一次就好
       */
      probe: async () => {
        let snap = await drv.evaluate(snapshot);
        if (!snap || snap.__error) {
          await sleep(600);
          snap = await drv.evaluate(snapshot);
        }
        return !snap || snap.__error || typeof snap.len !== 'number'
          ? `页面快照读不到（${snap?.__error ?? '空返回'}）`
          : `页面 ${snap.len} 字：「${snap.head}」`;
      },
      refreshQr,
      grabQr,
      saveQr,
      input,
      clock,
      log,
      signalFile: REFRESH_SIGNAL,
      stdinRaw,
      maxRefresh: MAX_QR_REFRESH,
      minGapMs: REFRESH_MIN_GAP_MS,
    });
  } finally {
    if (stdinRaw && stdinStream) {
      // 必须 off：不摘监听器的话，后面采集阶段敲的每个键都还在往这个回调里送
      stdinStream.off('data', onData);
      stdinStream.setRawMode?.(false);
      stdinStream.pause();
    }
  }

  if (!result.ok) {
    log('');
    log('二维码已失效或等待超时。');
    log('→ 直接重跑一次采集脚本即可生成新二维码（旧进程不会占用登录态）。');
    throw new Error('等待登录超时');
  }
  log('登录成功 ✓');
  /*
   * 扫码成功那一刻就清，**不要等整个采集跑完**。
   *
   * 登录一旦成功，这些二维码就已经作废了；但它们**仍然能被扫**（扫了只会提示失效），
   * 而后面还要跑 6 个频道的采集，没必要让废弃的登录码在盘上多躺几十秒。
   * 失败路径由 main 的 finally 兜底，这里删过也无所谓（幂等）。
   */
  purge({ when: '登录成功' });
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
  if (typeof body !== 'string') throw new Error(`页内 fetch 失败：${JSON.stringify(body)}`);
  const json = JSON.parse(body);
  if (json.retcode !== 0) {
    const err = new Error(`${path}: retcode=${json.retcode} ${json.message ?? ''}`);
    err.retcode = json.retcode;
    throw err;
  }
  return json;
}

/**
 * 浏览器路径的完整采集：开浏览器 → 登录 → 读 UID/昵称 → 取数 → meta。
 *
 * 改前这段在 `scripts/collect.mjs` 的 `main()` 里，与「建目录、写文件、打收尾日志」
 * 混在一起。现在只做采集本身：**不建目录、不写文件**，返回 Map。
 *
 * @param {object} args
 * @param {object} [args.driver]    openDriver 的参数（cdpUrl / driver / port / profile / headless）
 * @param {string} args.pageUrl     官方页面地址
 * @param {string} args.api         act 接口基址
 * @param {string} args.region
 * @param {Array}  args.channels
 * @param {string} [args.loginMode] qr / sms
 * @param {(qr: object) => void} [args.onQr]
 * @param {Function} [args.saveQrFile]  (dataUrl) => 落盘路径
 * @param {() => string|null} [args.qrUrlFor]
 * @param {string} [args.outputDir]  临时凭据目录（二维码 / 验证码）
 * @param {(o:{when:string}) => void} [args.purge]  清理凭据文件的回调
 * @param {NodeJS.ReadStream} [args.stdinStream]
 */
export async function collectWithBrowser({
  driver = {},
  pageUrl,
  api,
  region = 'prod_gf_cn',
  channels,
  loginMode = 'qr',
  onQr = null,
  saveQrFile = null,
  qrUrlFor = () => null,
  outputDir = null,
  purge = () => {},
  stdinStream = null,
  sms = {},
  onProgress = null,
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchedAt = undefined,
  isCn = undefined,
} = {}) {
  const drv = await openDriver({ ...driver, log });
  log(`驱动：${drv.kind}（${drv.version ?? '未知版本'}）`);

  try {
    await drv.open(pageUrl);
    await loginFlow(drv, {
      mode: loginMode,
      onQr,
      saveQrFile,
      qrUrlFor,
      outputDir,
      refreshSignalFile: outputDir ? join(outputDir, REFRESH_SIGNAL_FILE) : null,
      purge,
      waitMode: driver.waitMode ?? 'a',
      stdinRaw: Boolean(stdinStream?.isTTY),
      stdinStream,
      persistQr: Boolean(saveQrFile),
      sms,
      log,
      sleep,
    });

    const uid = await readUid(drv);
    if (!uid) throw new Error('拿不到 UID。确认账号已绑定《绝区零》角色。');
    log('UID', uid, 'region', region, '接口', api);

    /*
     * 取数部分与纯 Node 那条路**共用** `collectFiles()`：
     * 两条路只是「怎么发请求」不同，「先 index 再逐频道 cur/hist」的顺序必须只有一份。
     */
    const transport = {
      kind: 'browser',
      fetchJson: (path, query = '') => fetchJson(drv, api, region, uid, path, query),
    };
    const { files, summary, index } = await collectFiles({ transport, channels, log, sleep });

    // 昵称：接口不返回，只能从页面文本里找
    const nickname = await drv.evaluate(`(() => {
      const t = (document.body ? document.body.innerText : '').split('\\n').map(s => s.trim()).filter(Boolean);
      const idx = t.findIndex(s => /^UID/.test(s) || /^\\d{6,}$/.test(s));
      for (let i = 0; i < Math.min(t.length, 25); i += 1) {
        if (i === idx) continue;
        if (/^[\\u4e00-\\u9fa5A-Za-z0-9·_-]{1,16}$/.test(t[i]) && !/^(登录|绝区零|调频|UID|国服|全部|当前|历史)/.test(t[i])) return t[i];
      }
      return null;
    })()`);
    const safeNickname = typeof nickname === 'string' && nickname.length && !nickname.includes('\n') ? nickname : null;

    files.set('meta.json', buildMeta({
      index, uid, nickname: safeNickname, region, api, summary, fetchedAt,
      isCn: isCn ?? /^prod_gf_cn$/i.test(region),
    }));

    return { uid, nickname: safeNickname, files, summary };
  } finally {
    await drv.close?.();
  }
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
  saveQrFile = null,
  qrUrlFor = () => null,
  outputDir = null,
  purge = () => {},
  stdinStream = null,
  sms = {},
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const drv = await openDriver({ ...driver, log });
  log(`驱动：${drv.kind}（${drv.version ?? '未知版本'}）`);

  try {
    await drv.open(pageUrl);
    await loginFlow(drv, {
      mode: loginMode,
      onQr,
      saveQrFile,
      qrUrlFor,
      outputDir,
      refreshSignalFile: outputDir ? join(outputDir, REFRESH_SIGNAL_FILE) : null,
      purge,
      waitMode: driver.waitMode ?? 'a',
      stdinRaw: Boolean(stdinStream?.isTTY),
      stdinStream,
      persistQr: Boolean(saveQrFile),
      sms,
      log,
      sleep,
    });

    const uid = await readUid(drv);
    if (!uid) throw new Error('拿不到 UID。确认账号已绑定《绝区零》角色。');
    log('UID', uid, 'region', region);

    const nickname = await readNickname(drv);
    return { uid, nickname, drv };
  } catch (e) {
    /*
     * 失败时才关浏览器：成功时 `drv` 要交给 `collectViaBrowser()` 继续用
     * （登录态在那个上下文里，关了就白扫一次码）。
     */
    await drv.close?.();
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
} = {}) {
  if (!drv) throw new Error('collectViaBrowser 需要 drv（由 loginByQrBrowser 返回）');
  if (!uid) throw new Error('collectViaBrowser 需要 uid');

  log('UID', uid, 'region', region, '接口', api);

  const transport = {
    kind: 'browser',
    fetchJson: (path, query = '') => fetchJson(drv, api, region, uid, path, query),
  };
  const { files, summary, index } = await collectFiles({ transport, channels, log, sleep });

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
