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
 * 扫码阶段的临时凭据文件固定落在 <WORK_DIR>/output/ 下（login-qr.png / sms-code.txt / qr-refresh），
 * 登录成功那一刻就删除。采集完成的数据落在 <WORK_DIR>/output/<账号名>/data/。
 * 账号目录名取页面上的昵称（拿不到就退回 UID），一个账号一个目录，重跑覆盖。
 * 不读取 cookie、不保存请求头，只取三个接口的响应体。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openDriver } from './drivers.mjs';
import { wantsHelp, printHelp, WORK_DIR_NOTE } from './cli-help.mjs';
import { purgeAndLog } from './verify-cleanup.mjs';
import { createRefreshInput, createQrClock, waitForLogin, refreshChannelHint, REFRESH_SIGNAL_FILE } from './qr-wait.mjs';
import { startImageServer, stopImageServer, qrUrl, IMAGE_SERVER_FILE } from './image-server.mjs';
import { outputRoot, resolveAccountName, accountDataDir } from './datasets.mjs';

/*
 * --help 必须在**解析参数之后、任何副作用之前**处理。
 * 这个脚本早期不认 --help，误跑一次就直接进采集流程（要扫码登录）——
 * 那种「只想看用法，结果弹出一个登录二维码」是最坏的误触。
 */
if (wantsHelp()) {
  printHelp('collect', {
    summary: '采集《绝区零》调频数据，落成 output/<账号名>/data/*.json',
    options: [
      { flag: '--data <dir>', desc: '数据集目录，默认按昵称自动落到 output/<账号名>/data（拿不到昵称则用 UID）' },
      { flag: '--cwd <dir>', desc: '用户工作目录，默认当前目录；output/ 与 .chrome-profile/ 相对它算' },
      { flag: '--driver <name>', desc: 'playwright / cdp，默认自动挑（有 Playwright 用它，否则零依赖 CDP）' },
      { flag: '--cdp <url>', desc: '连一个已经开着的 Chrome，例如 http://127.0.0.1:9222（登录态可复用）' },
      { flag: '--port <n>', desc: 'CDP 端口，默认 9222' },
      { flag: '--profile <dir>', desc: '隔离 Chrome profile 目录，默认 .chrome-profile' },
      { flag: '--headed', desc: '显示浏览器窗口，方便自己扫码' },
      { flag: '--login <mode>', desc: 'qr / sms，默认 qr' },
      { flag: '--phone <n>', desc: '短信登录的手机号（也可用 ZZZ_PHONE）' },
      { flag: '--phone-file <f>', desc: '从文件读手机号' },
      { flag: '--code <n>', desc: '短信验证码（也可用 ZZZ_SMS_CODE）' },
      { flag: '--code-file <f>', desc: '从文件读验证码，读完即删' },
      { flag: '--keep-verify', desc: '排障用：保留 output/ 下的二维码与验证码文件，默认登录成功后立即删除' },
      { flag: '--wait <mode>', desc: '等待方式 a / b，默认 a（也可用 ZZZ_WAIT_MODE）' },
      { flag: '--region <r>', desc: '区服，默认 prod_gf_cn；国际服走 prod_gf_jp/us/eu/sg 等' },
      { flag: '--api <url>', desc: '硬覆盖接口基址（官方换域名时用）' },
      { flag: '--page <url>', desc: '硬覆盖页面地址' },
      { flag: '--help, -h', desc: '打印本帮助后退出，不启动浏览器' },
    ],
    notes: [
      WORK_DIR_NOTE,
      '不读取、不保存 cookie 与请求头，只取三个接口的响应体。',
    ],
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
/*
 * 两个根目录，跟 build-report.mjs 一致：
 *   SKILL_DIR：skill 本体，只读（`config/report.json` 从这里读）
 *   WORK_DIR：用户工作目录，`--cwd` 优先，否则 `process.cwd()`
 * `output/`、`.chrome-profile/` 都落到 WORK_DIR，不写进 skill 目录。
 */
const SKILL_DIR = resolve(HERE, '..');
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

/*
 * 用户工作目录：`--cwd` 优先，否则当前目录。
 * 采集落盘位置（`output/`）和隔离 Chrome profile（`.chrome-profile/`）都相对它算，
 * **不是**相对 skill 目录 —— 否则 skill 升级会覆盖用户数据，
 * 而且 `.gitignore` 的根锚定规则也管不到塞进 skill 目录里的那份。
 */
const WORK_DIR = resolve(argOf('cwd', process.cwd()));

/*
 * 区服 → 官方页面与接口基址。
 *
 * 过去这里把国服地址写死，`--region` 只改 query 参数不改域名 ——
 * 国际服账号会带着 prod_gf_us 去请求 act.mihoyo.com，必然是登录态不认、retcode 报错。
 * 现在按 region 选整套基址：国服走 mihoyo.com，国际服走 hoyolab.com（见 SKILL.md §2 对照表）。
 *
 * 也可以直接 `--api <url> --page <url>` 硬覆盖，方便官方换域名时不用改代码。
 */
const ENDPOINTS = {
  cn: {
    page: 'https://act.mihoyo.com/zzz/event/gacha-record/index.html',
    api: 'https://act-api-takumi.mihoyo.com/event/nap_gacha_record/api/zzz',
  },
  os: {
    page: 'https://act.hoyolab.com/zzz/event/gacha-record/index.html',
    api: 'https://sg-act-public-api.hoyolab.com/event/nap_gacha_record/api/zzz',
  },
};
const REGION = argOf('region', 'prod_gf_cn');
/** 国服的 region 全是 prod_gf_cn；其余（jp/us/eu/sg/hk/tw…）都算国际服。 */
const IS_CN = /^prod_gf_cn$/i.test(REGION);
const EP = IS_CN ? ENDPOINTS.cn : ENDPOINTS.os;
const PAGE = argOf('page', EP.page);
const API = argOf('api', EP.api);
/*
 * 产物目录：`output/<账号名>/data/`，一个账号一个目录，用户拿走 `output/<账号名>/`
 * 这一个目录就能直接部署（数据 + report.html 在一起）。
 *
 * **账号名要等采集完才知道**（昵称只能从页面文本读，接口不返回），而二维码在登录前就得落盘。
 * 所以这里不在启动时定 DATA_DIR，而是：
 *   1. 扫码/登录阶段只用 `output/` 根下的固定名凭据文件（跟账号无关）
 *   2. 采集结果**先放内存**，拿到昵称后才建目录、一次写盘
 *
 * 为什么不用「先写临时目录、拿到昵称再整体 mv」：
 *   中途失败时临时目录要额外清理，而 mv 失败或跨设备复制还会留下半个目录。
 *   内存里攒着写，最坏情况是「进程挂了、一个文件都没写」——这比半个目录好收拾得多。
 *
 * `--data` 显式指定时照旧直写那个目录（开发本仓库时用 --data fixtures/tianzhu 之外的场景）。
 * 采集是「覆盖写」——同一个目录跑第二次会用新数据覆盖旧文件。
 */
const EXPLICIT_DATA = argOf('data', null);
/** `--data` 给了就按它算；没给就等昵称出来再定。 */
const EXPLICIT_DATA_DIR = EXPLICIT_DATA ? resolve(WORK_DIR, EXPLICIT_DATA) : null;
/** `output/` 根：凭据临时文件放这里，账号目录也在这一层。 */
const OUTPUT_DIR = outputRoot(WORK_DIR);
/*
 * 默认清理 `output/` 下的临时凭据文件（二维码 / 验证码中转 / 换图信号，三个固定名）。
 * 登录成功即清一次，main 的 finally 再兜一次——见 scripts/verify-cleanup.mjs 里的说明。
 * `--keep-verify` 只给排障用：确认「二维码到底存成什么样」时需要留下证据。
 */
const KEEP_VERIFY = has('keep-verify') || /^--keep-verify=(true|1|yes)?$/i.test(args.find((a) => a.startsWith('--keep-verify=')) ?? '');
const CFG = JSON.parse(readFileSync(join(SKILL_DIR, 'config/report.json'), 'utf8'));
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

// ------------------------------------------------------------ 二维码图片服务

/*
 * 服务本体在 image-server.mjs —— 单独成文件是为了能在不启动浏览器的情况下测
 * 「白名单只服务 login-qr.png」「`?t=` 破缓存」这两条硬要求。
 * 这里只负责「起、停」两个时机，见 main 的开头与 finally。
 */

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
      phone = await readInputFile(resolve(WORK_DIR, phoneFile), {
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
   * 默认文件路径固定成 output/sms-code.txt，
   * 这样 agent 不用额外协商路径，按约定写就行。
   * 放 output/ 根而不是账号目录：账号名此刻还不知道（昵称要等采集完），
   * 而验证码在登录过程中就要用。登录成功即删，见 verify-cleanup.mjs。
   */
  const codeFile = resolve(WORK_DIR, argOf('code-file', join(OUTPUT_DIR, 'sms-code.txt')));
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
      // 短信路线没有二维码，但 sms-code.txt 里是明文验证码，同样不能留在盘上
      purgeAndLog({ dir: OUTPUT_DIR, keep: KEEP_VERIFY, log, when: '登录成功' });
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
  const saveQr = (q) => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const file = join(OUTPUT_DIR, IMAGE_SERVER_FILE);
    const bytes = Buffer.from(q.src.split(',')[1], 'base64');
    writeFileSync(file, bytes);

    /*
     * 图片 URL：给对方一个能直接放进 <image src> 的地址。
     * 服务没起来（比如用户本机手动跑、只要文件路径）就退回 null，
     * 调用方据此降级到「给路径」。
     */
    const url = qrUrl(IMAGE_SERVER_FILE);
    return { png: file, url };
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
  const MAX_QR_REFRESH = 3;
  const REFRESH_MIN_GAP_MS = 5000;
  const REFRESH_SIGNAL = join(OUTPUT_DIR, REFRESH_SIGNAL_FILE);
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
  const waitMode = (argOf('wait', '') || process.env.ZZZ_WAIT_MODE || 'a').toLowerCase() === 'b' ? 'b' : 'a';

  /*
   * 有没有终端只影响**提示文案**，不影响刷新通道的判断。
   *
   * 早先它同时决定了「听不听按键」和「查不查信号文件」，于是两条通道变成二选一，
   * agent 代跑时（进程有 TTY、但 agent 没法发按键）写信号文件完全没人读。
   * 现在两条通道并行生效，判断逻辑在 waitForLogin() 里，且**不接受 stdinRaw**。
   */
  const stdinRaw = Boolean(stdin.isTTY);

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
  if (stdinRaw) {
    // raw 模式关掉了终端行编辑，每个按键都会进 data；isRefreshKey 只认单个 r/R
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
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
    if (stdinRaw) {
      // 必须 off：不摘监听器的话，后面采集阶段敲的每个键都还在往这个回调里送
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
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
  purgeAndLog({ dir: OUTPUT_DIR, keep: KEEP_VERIFY, log, when: '登录成功' });
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

/*
 * 取数：全部**先放内存**，不写盘。
 *
 * 为什么：账号目录名是昵称，而昵称要等采集完才从页面读得到。
 * 先写盘就得先猜一个目录名（uid？临时名？），拿到了再改名或搬目录——
 * 中途失败留下半个目录，后面还得区分「这份半成品是谁的」。内存里攒着最省事：
 * 最坏情况是进程挂了、一个文件都没写，用户重跑一次就行。
 *
 * 返回的 `files` 是「文件名 → 内容」，落盘由 writeCollected 统一做。
 */
async function collectAll(drv) {
  const index = await fetchJson(drv, '/index');
  const byEnum = new Map((index.data.type_stats ?? []).map((t) => [t.gacha_type, t]));

  const files = new Map();
  files.set('index.json', index);
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
    files.set(`cur_pool_stat_${ch.id}.json`, cur);

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
    files.set(`hist_pool_stat_${ch.id}.json`, {
      retcode: 0,
      message: 'OK',
      data: { cur_ver: index.data.cur_ver, list: merged },
    });

    const countGold = (list) => list.reduce((s, p) => s + (p.cur_records?.length ?? 0), 0);
    const golds = countGold(merged) + countGold(cur.data?.list ?? []);
    summary[ch.id] = { label: ch.label, pulls: Number(stat?.total_count ?? 0), sCount: Number(stat?.s_count ?? 0), golds };
    log(`${ch.label}: ${summary[ch.id].pulls} 抽 / 官方 S ${summary[ch.id].sCount} / 取到金 ${golds} / 版本 ${vers.length}`);
  }

  return { index, summary, files };
}

// ------------------------------------------------------------------ 主流程

async function main() {
  const headless = !has('headed');
  const drv = await openDriver({
    cdpUrl: argOf('cdp', null),
    driver: argOf('driver', null),
    port: Number(argOf('port', '9222')),
    profile: resolve(WORK_DIR, argOf('profile', '.chrome-profile')),
    headless,
    log,
  });
  log(`驱动：${drv.kind}（${drv.version ?? '未知版本'}）`);

  try {
    await drv.open(PAGE);

    /*
     * 起一个只读图片服务，让二维码能以 URL 形式给出去（约 10 tokens），
     * 而不是把 7k 字符的 SVG 塞进回答（约 2100 tokens）。
     * 失败不影响主流程 —— saveQr 会退回「只给文件路径」。
     */
    try {
      await startImageServer(OUTPUT_DIR, log);
    } catch (e) {
      log(`⚠️  图片服务没起来（${e.message.split('\n')[0]}），二维码只给文件路径。`);
    }

    await loginFlow(drv, { mode: argOf('login', process.env.ZZZ_LOGIN_MODE || 'qr') });

    const uid = await readUid(drv);
    if (!uid) throw new Error('拿不到 UID。确认账号已绑定《绝区零》角色。');
    globalThis.__uid = uid;
    log('UID', uid, 'region', REGION, '接口', API);

    const { index, summary, files } = await collectAll(drv);

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

    const versions = (index.data.type_stats ?? []).flatMap((t) => t.has_data_vers ?? []);
    const uniq = sortVersionsDesc([...new Set(versions)]);
    const meta = {
      schema: 'zzz-stats/v1',
      server: IS_CN ? 'cn' : 'os',
      uid,
      region: REGION,
      nickname: safeNickname,
      fetched_at: new Date().toISOString(),
      versions: uniq.length ? `${uniq[uniq.length - 1]} → ${uniq[0]}` : null,
      source: API,
      channels: summary,
      total_gacha_count: Number(index.data.total_gacha_count ?? 0),
      total_s_count: Number(index.data.total_s_count ?? 0),
      total_counts_exclude_bangboo: true,
    };

    /*
     * 目录名与落盘。
     *
     * 默认：`output/<昵称>/data/`，昵称拿不到就退回 UID（安全化规则见 datasets.mjs）。
     * `--data` 显式给了就直写那个目录——那条路是给「我想自己指定位置」的场景，
     * 名字由用户负责，不再套账号名。
     *
     * 同账号重跑就是覆盖写同一个目录：不报错，也不生成 `xxx-2`。
     * 目录里的旧文件不预先清空——采集每次都会写齐 6 个频道的全部文件，
     * 而多删一次就多一次「删错用户文件」的机会。
     */
    let dataDir = EXPLICIT_DATA_DIR;
    let accountName = null;
    if (!dataDir) {
      const resolved = resolveAccountName(safeNickname, uid);
      accountName = resolved.name;
      dataDir = accountDataDir(WORK_DIR, accountName);
      if (resolved.source !== 'nickname') {
        log(`⚠️  昵称拿不到${safeNickname ? '或不能用作目录名' : ''}，目录名退回 ${resolved.source === 'uid' ? 'UID' : '固定名'}`);
      }
      log(`账号目录：${accountName}（取自${resolved.source === 'nickname' ? '昵称' : ' UID'}）`);
    }
    mkdirSync(dataDir, { recursive: true });
    for (const [name, value] of files) {
      writeFileSync(join(dataDir, name), JSON.stringify(value, null, 1));
    }
    writeFileSync(join(dataDir, 'meta.json'), JSON.stringify(meta, null, 2));

    // 完整性：金抽数 + 垫抽 == 官方总抽（6/6 频道实测成立）
    let bad = 0;
    for (const ch of CHANNELS) {
      const stat = (index.data.type_stats ?? []).find((t) => t.gacha_type === ch.enum);
      if (!stat) continue;
      const read = (f) => {
        const p = join(dataDir, f);
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

    /*
     * 收尾要说清楚。
     * 进程跑完就退出，终端静止 —— 用户（和 agent）都容易误判成「卡住了/没识别」。
     * 所以最后必须有一段总结，把「已经做完了什么」讲明白。
     */
    const totPulls = Object.values(summary).reduce((s, v) => s + v.pulls, 0);
    log('');
    log('──────────────── 完成 ────────────────');
    log(`UID ${uid} · 6 个频道 · 合计 ${totPulls} 抽（不含邦布）`);
    log(`数据已落盘：${dataDir}`);
    if (accountName) {
      log(`账号目录：${relative(WORK_DIR, dirname(dataDir))}/（拿走这一个目录即可部署：data/ + report.html）`);
    }
    log('下一步：node skills/zzz-stats/scripts/build-report.mjs --data ' + (accountName ? `output/${accountName}/data` : relative(WORK_DIR, dataDir)) + '   → 生成报表');
    log('✅ 采集结束，进程即将退出。');
  } finally {
    await drv.close?.();
    // 图片服务只在采集期间需要，取完立刻收掉，不留监听端口
    stopImageServer();
    /*
     * 兜底清理：登录失败、采集中途抛错都不能把二维码留在盘上。
     * （Ctrl-C / kill 不经过这里——async main 的 finally 在 SIGINT 下根本不执行，
     *   实测过；那两条路由文件末尾的信号处理负责，见那里的说明。）
     * 成功路径在 loginFlow 里已经删过一次，这次通常是 0 个（幂等，不会再报一行）。
     * 必须排在 stopImageServer 之后 —— 先把出口关掉再删文件，顺序反了中间会有一段
     * 「服务还开着、文件已经被删」的空窗。
     */
    purgeAndLog({ dir: OUTPUT_DIR, keep: KEEP_VERIFY, log, when: '收尾' });
  }
}

/*
 * Ctrl-C / kill 不会跑 async main 的 finally。
 *
 * 实测过（`node` 里 async main + finally：SIGINT 后 finally 根本不执行），
 * 所以不能指望 finally 兜住「用户中途按 Ctrl-C」这条路——
 * 而那恰恰是最容易留下二维码的操作（用户扫不动、等不及、直接掐掉）。
 *
 * 这里显式挂信号处理：**只用同步 API**（rmSync 等），不在信号回调里 await。
 * 信号回调里再去等异步操作，进程可能在它跑完之前就退出了。
 * 删完再 `process.exit(130)`（SIGINT 的常规退出码）。
 */
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(sig, () => {
    try {
      stopImageServer();
      purgeAndLog({ dir: OUTPUT_DIR, keep: KEEP_VERIFY, log, when: `收到 ${sig}` });
    } catch { /* 退出路径上不要再抛 */ }
    process.exit(code);
  });
}

main().catch((e) => {
  console.error('[zzz] 失败：', e.message);
  process.exit(1);
});
