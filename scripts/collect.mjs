#!/usr/bin/env node
/**
 * zzz-stats 采集器
 *
 * 把 SKILL.md 里「打开页面 → 扫码 → 取数 → 落盘」这一段固化下来。
 * 浏览器驱动是可替换的（见 scripts/drivers.mjs）：
 *
 *   - 有 Playwright  → 用它驱动**本机 Chrome**（channel:'chrome'，不需要 Playwright 下载浏览器）
 *   - 没有 Playwright → 用零依赖的 CDP 直连，仍然只要求本机有 Chrome
 *   - 也可以直接连一个已经开着的 Chrome
 *
 * 用法：
 *   node scripts/collect.mjs                 # 自动挑驱动（默认）
 *   node scripts/collect.mjs --driver cdp    # 强制零依赖方案
 *   node scripts/collect.mjs --driver playwright
 *   node scripts/collect.mjs --cdp http://127.0.0.1:9222   # 连已有 Chrome（登录态可复用）
 *   node scripts/collect.mjs --headed        # 显示浏览器窗口，方便自己扫码
 *
 * 扫码阶段会把二维码存成 data/_verify/login-qr.png 并打印路径；扫完按回车继续。
 * 不读取 cookie、不保存请求头，只取三个接口的响应体。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openDriver } from './drivers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
/*
 * 读命令行参数。两种写法都支持：
 *   --login sms    （空格分隔）
 *   --login=sms    （等号）
 * 早先只认空格形式，传 --login=sms 会被静默忽略、
 * 悄悄走回默认扫码流程 —— 这类「参数没报错但没生效」最难查。
 */
const argOf = (f, d) => {
  const eq = args.find((a) => a.startsWith(`--${f}=`));
  if (eq) return eq.slice(f.length + 3) || d;
  const i = args.indexOf(`--${f}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const PAGE = 'https://act.mihoyo.com/zzz/event/gacha-record/index.html';
const API = 'https://act-api-takumi.mihoyo.com/event/nap_gacha_record/api/zzz';
const REGION = argOf('region', 'prod_gf_cn');
const DATA_DIR = resolve(ROOT, argOf('data', 'data'));
const VERIFY_DIR = join(DATA_DIR, '_verify');
const CFG = JSON.parse(readFileSync(join(ROOT, 'config/report.json'), 'utf8'));
const CHANNELS = CFG.channels;
const MAX_VERS = 10;

const log = (...a) => console.log('[zzz]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * 交互提问。
 *
 * 只在「用户自己在本机终端里手动跑」时才走这条路 —— 那是个合法场景，
 * 但**不是默认场景**。agent 代跑时用户根本不碰终端，
 * 所以固定输入必须能通过参数/文件送进来，不能指望 stdin。
 */
async function ask(question) {
  if (!stdin.isTTY) {
    throw new Error(
      `需要交互输入（${question}），但当前不是终端环境。\n` +
      '→ agent 代跑时请用 --phone=... 传手机号、--code-file=... 传验证码。'
    );
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`${question} … `);
  rl.close();
  return answer;
}

// 仅在有 TTY、且用户本机手动跑时才会走到（agent 代跑的分支会直接抛错）
const pause = (msg = '按回车继续') => ask(msg);

/*
 * 等用户给一个值（手机号/验证码），**不依赖终端**。
 *
 * 为什么是文件：
 *   agent 拿到用户输入后没法往一个正在跑的进程的 stdin 里打字，
 *   但可以写文件。进程轮询文件 = 一条稳定的输入通道。
 *
 * 读完立刻删除，验证码不在磁盘上留底；
 * 值不合法时不删、不退出，继续等下一个 —— 用户输错一次不该让整个流程作废。
 */
async function readInputFile(file, { label, timeoutMs, validate, log, sleep }) {
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

// ------------------------------------------------------------ 页面状态探针

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

// ---------------------------------------------------------------- 扫码登录

/**
 * @param {import('./drivers.mjs').CdpDriver | any} drv 驱动实例（接口见 drivers.mjs）
 */
/**
 * 判断默认登录方式。
 * 默认扫码：不用输手机号、不用等短信，体验最短。
 * 只有当调用方明确要求、或环境变量指定时才走短信。
 */
function detectLoginMode() {
  return 'qr';
}

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
async function smsLogin(drv, frame, { ask, log, sleep, LOGGED_IN }) {
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
  const phoneArg = argOf('phone', null) || argOf('phone', process.env.ZZZ_PHONE);
  let phone = phoneArg;
  if (!phone) {
    const phoneFile = argOf('phone-file', null);
    if (phoneFile) {
      phone = await readInputFile(resolve(ROOT, phoneFile), {
        label: '手机号', timeoutMs: 5 * 60 * 1000, log, sleep,
        validate: (v) => /^\d{11}$/.test(v),
      });
    } else if (stdin.isTTY) {
      phone = (await ask('请输入手机号（11 位，仅用于填入官方登录框）')).trim();
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
   * 默认文件路径固定成 <data>/_verify/sms-code.txt，
   * 这样 agent 不用额外协商路径，按约定写就行。
   */
  const codeFile = resolve(ROOT, argOf('code-file', join(VERIFY_DIR, 'sms-code.txt')));
  let code = argOf('code', null) || argOf('code', process.env.ZZZ_SMS_CODE);
  if (!code) {
    if (stdin.isTTY) {
      code = (await ask('请输入收到的验证码（通常 60 秒内有效）')).trim();
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
      return;
    }
    await sleep(1500);
  }
  throw new Error('短信登录后仍未检测到登录态。可能是验证码错误，或需要完成滑块验证。');
}

async function loginFlow(drv, opts = {}) {
  const mode = String(opts.mode || process.env.ZZZ_LOGIN_MODE || detectLoginMode()).toLowerCase();
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
    if (!stdin.isTTY) {
      throw new Error(
        '登录框（跨域 iframe）没出现。请在浏览器窗口里手动点「登录」，然后重跑一次脚本' +
        '（登录态会留在 profile 里，第二次会直接跳过登录）。'
      );
    }
    log('⚠️  登录框（跨域 iframe）没出现。');
    log('    请在浏览器里手动点「登录」并扫码，完成后回到这里按回车。');
    await pause();
    return;
  }
  log('已进入登录 frame');

  /*
   * 分流点。
   * 登录框默认就停在短信登录页（#/login/captcha），所以走短信不需要切 tab。
   */
  if (mode === 'sms') {
    await smsLogin(drv, frame, { ask, log, sleep, LOGGED_IN });
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

  const saveQr = (q) => {
    mkdirSync(VERIFY_DIR, { recursive: true });
    const file = join(VERIFY_DIR, 'login-qr.png');
    writeFileSync(file, Buffer.from(q.src.split(',')[1], 'base64'));
    return file;
  };

  const QR_TTL_MS = 120_000;   // 官方二维码约 2 分钟失效
  let qr = await grabQr();
  let issuedAt = Date.now();

  if (qr?.src) {
    const file = saveQr(qr);
    const expires = new Date(issuedAt + QR_TTL_MS);
    log(`二维码已保存（${qr.w}×${qr.h}）：${file}`);
    log(`截取时间 ${new Date(issuedAt).toLocaleTimeString('zh-CN', { hour12: false })}，` +
        `约 ${expires.toLocaleTimeString('zh-CN', { hour12: false })} 失效（2 分钟）`);
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
  const MAX_QR_REFRESH = 3;
  const REFRESH_MIN_GAP_MS = 5000;
  const REFRESH_SIGNAL = join(VERIFY_DIR, 'qr-refresh');
  let refreshCount = 0;
  let lastRefreshAt = 0;

  /*
   * 扫码阶段必须「自动轮询登录态 + 非阻塞监听键盘」。
   *
   * 之前这里是 `await ask(...)` 先阻塞等人按回车，按完才去轮询登录——
   * 用户扫完码什么都不发生，得自己回来敲回车，体验是坏的。
   * 现在改成：主循环每 3 秒查一次登录态，命中立刻继续；
   * stdin 用 raw 模式旁听，按 r 才刷新二维码（同样受 3 次上限约束）。
   */
  /*
   * 扫码等待策略，按「当前会话能不能挂着等」分两档：
   *
   *   A 档（默认）：宿主支持后台任务 —— 调用方可以把本进程挂起来等，
   *                检测到登录就自己往下走，用户扫完什么都不用做。
   *   B 档：宿主只能一次性执行 —— 本进程等不到用户扫码就会退出，
   *                所以要明确告诉用户「扫完回来说一声」，由调用方再跑一次续上。
   *
   * 判定顺序：
   *   1. --wait=a|b 或 ZZZ_WAIT_MODE=a|b（调用方知道自己有没有后台能力，优先听它的）
   *   2. 默认 a（交互终端下本来就是挂着等，非交互由调用方决定）
   *
   * B 档能续上的前提是 profile 持久化：扫码产生的 cookie 留在 profile 里，
   * 第二次运行时直接就是登录态。
   */
  const waitMode = (argOf('wait', '') || process.env.ZZZ_WAIT_MODE || 'a').toLowerCase() === 'b' ? 'b' : 'a';

  log(`正在等待扫码…（二维码过期最多换 ${MAX_QR_REFRESH} 次）`);
  if (waitMode === 'b') {
    log('');
    log('扫码完成后，回到对话里说一声「好了」—— 我会接着把数据取下来。');
    log('（当前宿主只能一次性执行，没法在这里挂着等）');
    log('');
  } else {
    log('扫码后会自动继续，不需要任何操作。');
  }
  if (stdinRaw) {
    log('（本终端里按 r 可以换一张二维码）');
  } else {
    log(`（二维码过期时，agent 写入 ${REFRESH_SIGNAL} 即可换一张）`);
  }

  // 心跳里附带的页面快照：出问题时能直接看出「扫码前后页面到底有没有变化」
  const snapshot = `(() => {
    const t = document.body ? document.body.innerText : '';
    return { len: t.length, head: t.replace(/\\s+/g, ' ').slice(0, 60) };
  })()`;

  let ok = null;
  let tick = 0;
  let warnedExpired = false;
  /*
   * 等待扫码。
   * 两条时间线要分开看：
   *   - 二维码有效期 QR_TTL_MS（120s）：过了就明确报「已过期」，提示怎么换
   *   - 整体等待上限 MAX_WAIT_MS（10min）：用户去忙别的事时不要几分钟就放弃，
   *     但也不能无限等，否则脚本永远挂着
   */
  const MAX_WAIT_MS = 10 * 60 * 1000;
  const deadline = Date.now() + MAX_WAIT_MS;

  /*
   * 刷新信号的两种来法，同一套上限约束：
   *   - 有 TTY：按 r（用户本机手动跑）
   *   - 无 TTY：agent 写一个信号文件（用户说「过期了/换一张」时）
   * 两条路都只影响「换图」，绝不影响轮询登录态那部分。
   */
  let wantRefresh = false;
  const onKey = (buf) => {
    if (buf.toString().toLowerCase() === 'r') wantRefresh = true;
  };
  const stdinRaw = Boolean(stdin.isTTY);
  if (stdinRaw) {
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onKey);
  }

  try {
    while (Date.now() < deadline) {
      ok = await drv.evaluate(LOGGED_IN);
      if (ok === 'logged-in') break;

      // 无终端时：靠信号文件触发换图
      if (!stdinRaw && existsSync(REFRESH_SIGNAL)) {
        try { rmSync(REFRESH_SIGNAL); } catch {}
        wantRefresh = true;
      }

      // 二维码本身的有效期，与整体等待上限无关
      const qrAge = Date.now() - issuedAt;
      if (!warnedExpired && qrAge >= QR_TTL_MS) {
        warnedExpired = true;
        log('');
        log('⚠️  二维码已过期（截取于 ' +
          new Date(issuedAt).toLocaleTimeString('zh-CN', { hour12: false }) +
          `，已过 ${Math.round(qrAge / 1000)} 秒）`);
        log('    需要换一张才能继续：在运行脚本的终端里按一下 r，' +
          '或由 agent 写入 ' + REFRESH_SIGNAL + '。');
        log('    （不会自动刷新——避免没人看着时反复请求登录接口）');
        log('');
      }

      // 每 15 秒报一次心跳：让用户看得出脚本还活着、还在等
      tick += 1;
      if (tick % 5 === 0) {
        const leftMin = Math.ceil((deadline - Date.now()) / 60000);
        const snap = await drv.evaluate(snapshot);
        const info = snap ? `页面 ${snap.len} 字：「${snap.head}」` : '页面读不到';
        log(warnedExpired
          ? `仍在等待…（二维码已过期，需换一张；最多再等 ${leftMin} 分钟）｜${info}`
          : `仍在等待扫码…（二维码还剩约 ${Math.max(0, Math.round((QR_TTL_MS - qrAge) / 1000))} 秒有效）｜${info}`);
      }

      if (wantRefresh) {
        wantRefresh = false;
        if (refreshCount >= MAX_QR_REFRESH) {
          log(`已重取 ${refreshCount} 次，达到上限，不再自动换图。`);
        } else if (lastRefreshAt && Date.now() - lastRefreshAt < REFRESH_MIN_GAP_MS) {
          log(`刷新太快了，请等 ${Math.ceil((REFRESH_MIN_GAP_MS - (Date.now() - lastRefreshAt)) / 1000)} 秒后再试。`);
        } else {
          lastRefreshAt = Date.now();
          refreshCount += 1;
          const hit = await refreshQr();
          qr = await grabQr();
          const left = MAX_QR_REFRESH - refreshCount;
          if (qr?.src) {
            const file = saveQr(qr);
            log(hit === 'no-expired-node'
              ? `二维码尚未过期，仍是同一张（${file}）。剩余 ${left} 次。`
              : `已换新二维码（${hit}）：${file}。剩余 ${left} 次。`);
          } else {
            log(`刷新后没读到二维码（${hit}）。剩余 ${left} 次。`);
          }
        }
      }
      await sleep(3000);
    }
  } finally {
    if (stdinRaw) {
      stdin.off('data', onKey);
      stdin.setRawMode?.(false);
      stdin.pause();
    }
  }

  if (!ok) {
    log('');
    log('二维码已失效或等待超时。');
    log('→ 直接重跑一次采集脚本即可生成新二维码（旧进程不会占用登录态）。');
    throw new Error('等待登录超时');
  }
  log('登录成功 ✓');
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
async function fetchJson(drv, path, extra = '') {
  const url = `${API}${path}?uid=${encodeURIComponent(globalThis.__uid)}&region=${encodeURIComponent(REGION)}${extra ? '&' + extra : ''}`;
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

function sortVersionsDesc(list) {
  return [...list].sort((a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    return pb[0] - pa[0] || (pb[1] ?? 0) - (pa[1] ?? 0);
  });
}

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

async function collectAll(drv) {
  const index = await fetchJson(drv, '/index');
  const byEnum = new Map((index.data.type_stats ?? []).map((t) => [t.gacha_type, t]));

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 1));
  const summary = {};

  for (const ch of CHANNELS) {
    const stat = byEnum.get(ch.enum);

    await sleep(350);
    let cur;
    try {
      cur = await fetchJson(drv, '/cur_pool_stat', `gacha_type=${ch.id}`);
    } catch (e) {
      log(`⚠️  ${ch.label} cur_pool_stat 失败：${e.message}`);
      cur = { retcode: 0, data: { list: [] } };
    }
    writeFileSync(join(DATA_DIR, `cur_pool_stat_${ch.id}.json`), JSON.stringify(cur, null, 1));

    // 历史卡池：必须用本频道自己的 has_data_vers，且单次最多 10 个
    const vers = sortVersionsDesc(stat?.has_data_vers ?? []);
    const pools = [];
    for (const slice of chunk(vers, MAX_VERS)) {
      await sleep(350);
      try {
        const hist = await fetchJson(drv, '/hist_pool_stat', `gacha_type=${ch.id}&vers=${slice.join(',')}`);
        pools.push(...(hist.data?.list ?? []));
      } catch (e) {
        if (e.retcode === -400005) throw new Error(`${ch.label}: vers 分片仍报参数错误（${slice.join(',')}）`);
        throw e;
      }
    }
    const seen = new Set();
    const merged = pools.filter((p) => {
      const key = `${p.gacha_type}|${p.version}|${p.start_ts}|${p.end_ts}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    writeFileSync(
      join(DATA_DIR, `hist_pool_stat_${ch.id}.json`),
      JSON.stringify({ retcode: 0, message: 'OK', data: { cur_ver: index.data.cur_ver, list: merged } }, null, 1),
    );

    const countGold = (list) => list.reduce((s, p) => s + (p.cur_records?.length ?? 0), 0);
    const golds = countGold(merged) + countGold(cur.data?.list ?? []);
    summary[ch.id] = { label: ch.label, pulls: Number(stat?.total_count ?? 0), sCount: Number(stat?.s_count ?? 0), golds };
    log(`${ch.label}: ${summary[ch.id].pulls} 抽 / 官方 S ${summary[ch.id].sCount} / 取到金 ${golds} / 版本 ${vers.length}`);
  }

  return { index, summary };
}

// ------------------------------------------------------------------ 主流程

async function main() {
  const headless = !has('headed');
  const drv = await openDriver({
    cdpUrl: argOf('cdp', null),
    driver: argOf('driver', null),
    port: Number(argOf('port', '9222')),
    profile: resolve(ROOT, argOf('profile', '.chrome-profile')),
    headless,
    log,
  });
  log(`驱动：${drv.kind}（${drv.version ?? '未知版本'}）`);

  try {
    await drv.open(PAGE);
    await loginFlow(drv, { mode: argOf('login', process.env.ZZZ_LOGIN_MODE || 'qr') });

    const uid = await readUid(drv);
    if (!uid) throw new Error('拿不到 UID。确认账号已绑定《绝区零》角色。');
    globalThis.__uid = uid;
    log('UID', uid, 'region', REGION);

    const { index, summary } = await collectAll(drv);

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

    const versions = (index.data.type_stats ?? []).flatMap((t) => t.has_data_vers ?? []);
    const uniq = sortVersionsDesc([...new Set(versions)]);
    const meta = {
      schema: 'zzz-stats/v1',
      server: 'cn',
      uid,
      region: REGION,
      nickname: typeof nickname === 'string' && nickname.length && !nickname.includes('\n') ? nickname : null,
      fetched_at: new Date().toISOString(),
      versions: uniq.length ? `${uniq[uniq.length - 1]} → ${uniq[0]}` : null,
      source: API,
      channels: summary,
      total_gacha_count: Number(index.data.total_gacha_count ?? 0),
      total_s_count: Number(index.data.total_s_count ?? 0),
      total_counts_exclude_bangboo: true,
    };
    writeFileSync(join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

    // 完整性：金抽数 + 垫抽 == 官方总抽（6/6 频道实测成立）
    let bad = 0;
    for (const ch of CHANNELS) {
      const stat = (index.data.type_stats ?? []).find((t) => t.gacha_type === ch.enum);
      if (!stat) continue;
      const read = (f) => {
        const p = join(DATA_DIR, f);
        return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { data: { list: [] } };
      };
      const all = [...(read(`hist_pool_stat_${ch.id}.json`).data.list ?? []), ...(read(`cur_pool_stat_${ch.id}.json`).data.list ?? [])];
      const pulls = all.reduce((s, p) => s + (p.cur_records ?? []).reduce((x, r) => x + Number(r.count || 0), 0), 0);
      const total = pulls + Number(stat.next_s_cur_times ?? 0);
      if (total !== Number(stat.total_count)) {
        bad += 1;
        log(`⚠️  ${ch.label} 校验失败：金抽数 ${pulls} + 垫抽 ${stat.next_s_cur_times} = ${total} ≠ 官方 ${stat.total_count}`);
      }
    }
    if (bad === 0) log('✅ 6/6 频道完整性校验通过');

    log(`已写入 ${DATA_DIR}`);
    log('下一步：node scripts/build-report.mjs');
  } finally {
    await drv.close?.();
  }
}

main().catch((e) => {
  console.error('[zzz] 失败：', e.message);
  process.exit(1);
});
