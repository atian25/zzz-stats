#!/usr/bin/env node
/**
 * zzz-stats 采集器 —— **命令行外壳**。
 *
 * 真正的采集逻辑在 `lib/collect.mjs`（编排）、`lib/login-node.mjs`（纯 Node 扫码）、
 * `lib/login-browser.mjs`（浏览器登录 + 页内取数）。本文件只做外壳该做的事：
 *
 *   解析参数 → 建目录 → 调 SDK → 落盘 → 打日志 → 清理凭据 → 退出码
 *
 * ## 为什么拆开
 *
 * 改前这个文件 1027 行，把「采集算法」和「命令行」混在一起：想从服务里复用
 * 采集逻辑就只能整份复制，两份必然漂移。现在 SDK 不写盘也不退出，
 * 服务可以自己存数据库、自己决定日志格式；CLI 保持改前的一切行为不变。
 *
 * ## 两条取数路径与降级
 *
 *   --transport node      纯 Node：passport 扫码 → Cookie → act 接口直连（默认）
 *   --transport browser   浏览器：官方页面扫码 + 页内 fetch（改前的老路）
 *
 * 默认 node。node 失败（国际服、或 passport 的私有 header 变了）**自动降到 browser**，
 * 并在日志里明确打一行说明为什么降级 —— 静默换路是最难查的一类问题：
 * 用户以为走的是纯 Node，实际开了个浏览器弹出来。
 *
 * 用法：
 *   node scripts/collect.mjs                        # 自动：先纯 Node，失败降级浏览器
 *   node scripts/collect.mjs --transport browser    # 强制走浏览器
 *   node scripts/collect.mjs --transport node       # 强制纯 Node，失败直接报错不降级
 *   node scripts/collect.mjs --headed               # 浏览器路径下显示窗口
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin } from 'node:process';
import { wantsHelp, printHelp, WORK_DIR_NOTE } from './cli-help.mjs';
import { purgeAndLog } from './verify-cleanup.mjs';
import { startImageServer, stopImageServer, qrUrl, IMAGE_SERVER_FILE } from './image-server.mjs';
import { outputRoot, resolveAccountName, accountDataDir } from './datasets.mjs';
import { collectData } from '../../../packages/sdk/index.mjs';

if (wantsHelp()) {
  printHelp('collect', {
    summary: '采集《绝区零》调频数据，落成 output/<账号名>/data/*.json',
    options: [
      { flag: '--transport <t>', desc: 'node / browser。不传＝先 node、失败降级 browser；显式指定则失败不降级' },
      { flag: '--data <dir>', desc: '数据集目录，默认按昵称自动落到 output/<账号名>/data（拿不到昵称则用 UID）' },
      { flag: '--cwd <dir>', desc: '用户工作目录，默认当前目录；output/ 与 .chrome-profile/ 相对它算' },
      { flag: '--driver <name>', desc: '浏览器路径的驱动：playwright / cdp，默认自动挑' },
      { flag: '--cdp <url>', desc: '连一个已经开着的 Chrome，例如 http://127.0.0.1:9222（登录态可复用）' },
      { flag: '--port <n>', desc: 'CDP 端口，默认 9222' },
      { flag: '--profile <dir>', desc: '隔离 Chrome profile 目录，默认 .chrome-profile' },
      { flag: '--headed', desc: '显示浏览器窗口，方便自己扫码' },
      { flag: '--login <mode>', desc: 'qr / sms，默认 qr（仅浏览器路径）' },
      { flag: '--phone <n>', desc: '短信登录的手机号（也可用 ZZZ_PHONE）' },
      { flag: '--phone-file <f>', desc: '从文件读手机号' },
      { flag: '--code <n>', desc: '短信验证码（也可用 ZZZ_SMS_CODE）' },
      { flag: '--code-file <f>', desc: '从文件读验证码，读完即删' },
      { flag: '--keep-verify', desc: '排障用：保留 output/ 下的二维码与验证码文件' },
      { flag: '--wait <mode>', desc: '等待方式 a / b，默认 a（也可用 ZZZ_WAIT_MODE）' },
      { flag: '--region <r>', desc: '区服，默认 prod_gf_cn；国际服走 prod_gf_jp/us/eu/sg 等' },
      { flag: '--api <url>', desc: '硬覆盖接口基址（官方换域名时用）' },
      { flag: '--page <url>', desc: '硬覆盖页面地址' },
      { flag: '--help, -h', desc: '打印本帮助后退出，不启动浏览器' },
    ],
    notes: [
      WORK_DIR_NOTE,
      '不读取、不保存 cookie 与请求头，只取三个接口的响应体。',
      '纯 Node 那条路只做国服；不传 --transport 时失败会降级到浏览器路径，显式指定则不降级。',
    ],
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, '..');
/*
 * 采集层在 `packages/sdk/`，与 skill 目录已分离，所以它需要的两样东西
 * 必须由这里显式给齐（SDK 不猜自己在哪）：
 *
 *   cfg            `config/report.json` 的解析结果（采集层只用得到 channels）
 *   qrVendorPath   二维码编码器的 vendor 路径
 *
 * 这两条路径是**外壳**的布局知识，留在外壳里是对的。
 */
const CFG_PATH = join(SKILL_DIR, 'config/report.json');
const QR_VENDOR_PATH = join(SKILL_DIR, 'assets/vendor/qrcode/core/qrcode.js');
/** 配置读一次就够：下面 `cfg` 与「完整性校验」用的是同一份。 */
const CFG = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const argOf = (f, d) => {
  const eq = args.find((a) => a.startsWith(`--${f}=`));
  if (eq) return eq.slice(f.length + 3) || d;
  const i = args.indexOf(`--${f}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const WORK_DIR = resolve(argOf('cwd', process.cwd()));

/*
 * 区服 → 官方页面与接口基址。
 * 与改前一致：国服走 mihoyo.com，国际服走 hoyolab.com。`--api/--page` 可硬覆盖。
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
const IS_CN = /^prod_gf_cn$/i.test(REGION);
const EP = IS_CN ? ENDPOINTS.cn : ENDPOINTS.os;
const PAGE = argOf('page', EP.page);
const API = argOf('api', EP.api);

const EXPLICIT_DATA = argOf('data', null);
const EXPLICIT_DATA_DIR = EXPLICIT_DATA ? resolve(WORK_DIR, EXPLICIT_DATA) : null;
const OUTPUT_DIR = outputRoot(WORK_DIR);
const KEEP_VERIFY = has('keep-verify') || /^--keep-verify=(true|1|yes)?$/i.test(args.find((a) => a.startsWith('--keep-verify=')) ?? '');

const log = (...a) => console.log('[zzz]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 凭据清理：先收几条参数，SDK 只负责「什么时候清」，清什么由这里定。 */
const purge = ({ when }) => purgeAndLog({ dir: OUTPUT_DIR, keep: KEEP_VERIFY, log, when });

/** 二维码落盘（固定名 `output/login-qr.png`，覆盖写；靠 URL 的 `?t=` 破缓存）。 */
function saveQrFile(dataUrl) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = join(OUTPUT_DIR, IMAGE_SERVER_FILE);
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  writeFileSync(file, bytes);
  return file;
}

/**
 * 跑一条 transport。
 *
 * 两条路只在「登录 + 取数怎么发生」上不同，落盘/校验/日志全都共用。
 * 所以这里把共同参数备好，交给 SDK，拿回 Map。
 */
async function runTransport(kind) {
  return await collectData({
    transport: kind,
    region: REGION,
    api: API,
    cfg: CFG,
    qrVendorPath: QR_VENDOR_PATH,
    log,
    sleep,
    onQr: async (qr) => {
      /*
       * 纯 Node 那条路给的是 dataUrl（我们自己编的）；浏览器路径给的是页面里那张图的 dataUrl。
       * 两者都落同一个固定文件名，日志里都给同一个地址格式 —— 调用方（agent/用户）
       * 不需要知道这次走的是哪条路才能扫到码。
       */
      if (kind === 'node') {
        const file = saveQrFile(qr.dataUrl);
        const url = qrUrl(IMAGE_SERVER_FILE);
        const expires = new Date(Date.now() + 120_000);
        log(`二维码已保存：${file}`);
        log(`截取时间 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}，` +
            `约 ${expires.toLocaleTimeString('zh-CN', { hour12: false })} 失效（2 分钟）`);
        if (url) log(`二维码图片地址：${url}`);
        log('请用米游社 App 扫码，打开这张图扫即可。');
      }
    },
    browser: {
      pageUrl: PAGE,
      api: API,
      driver: {
        cdpUrl: argOf('cdp', null),
        driver: argOf('driver', null),
        port: Number(argOf('port', '9222')),
        profile: resolve(WORK_DIR, argOf('profile', '.chrome-profile')),
        headless: !has('headed'),
        waitMode: (argOf('wait', '') || process.env.ZZZ_WAIT_MODE || 'a').toLowerCase() === 'b' ? 'b' : 'a',
      },
      loginMode: argOf('login', process.env.ZZZ_LOGIN_MODE || 'qr'),
      saveQrFile,
      qrUrlFor: () => qrUrl(IMAGE_SERVER_FILE),
      outputDir: OUTPUT_DIR,
      purge,
      stdinStream: stdin,
      sms: {
        phone: argOf('phone', null),
        phoneFile: argOf('phone-file', null),
        code: argOf('code', null),
        codeFile: argOf('code-file', null),
      },
    },
  });
}

async function main() {
  /*
   * 起图片服务，让二维码能以 URL 形式给出去（约 10 tokens），
   * 而不是把 7k 字符的 SVG 塞进回答。失败不影响主流程 —— 日志退回给文件路径。
   */
  try {
    await startImageServer(OUTPUT_DIR, log);
  } catch (e) {
    log(`⚠️  图片服务没起来（${e.message.split('\n')[0]}），二维码只给文件路径。`);
  }

  try {
    /*
     * 降级策略**全部在这一层**，SDK 里没有任何「换一条路」的判断。
     * 理由：策略会随部署形态变（服务里可能只用浏览器、或 node 失败就整体报错），
     * 写进 SDK 就等于替所有调用方做了决定。
     *
     * 三种情形，判据是「用户有没有显式给 --transport」：
     *
     *   不传        → 先试 node，抛错就说明原因、再走 browser（默认策略）
     *   --transport node    → 只用 node，失败按现有方式报错退出（显式选择要能被信任）
     *   --transport browser → 只用 browser
     *
     * `argOf()` 的默认值会掩盖「有没有传」这件事，所以这里单独判断原始参数。
     */
    const explicit = argOf('transport', null);
    const requested = String(explicit ?? 'node').toLowerCase();
    if (requested !== 'node' && requested !== 'browser') {
      throw new Error(`--transport 只支持 node / browser，收到 ${requested}`);
    }

    let result;
    if (explicit === null) {
      // 没指定：默认 node，失败降级。
      log('取数路径：纯 Node（未指定 --transport，失败会降级到浏览器）');
      try {
        result = await runTransport('node');
      } catch (e) {
        /*
         * 降级。**必须打一行说明为什么** —— 静默换路会让用户以为走的是纯 Node，
         * 实际弹出一个浏览器要扫，完全无法理解。
         */
        log('');
        log(`⚠️  纯 Node 取数失败：${e.message.split('\n')[0]}`);
        log('→ 降级到浏览器路径（官方页面扫码 + 页内 fetch）。');
        log('  想只用纯 Node、失败即退出，请显式指定 --transport node。');
        log('');
        log('取数路径：浏览器（降级）');
        result = await runTransport('browser');
      }
    } else {
      log(`取数路径：${requested === 'node' ? '纯 Node' : '浏览器'}（--transport ${requested} 指定，失败不降级）`);
      result = await runTransport(requested);
    }

    const { uid, nickname, files, meta } = result;

    let dataDir = EXPLICIT_DATA_DIR;
    let accountName = null;
    if (!dataDir) {
      const resolved = resolveAccountName(nickname, uid);
      accountName = resolved.name;
      dataDir = accountDataDir(WORK_DIR, accountName);
      if (resolved.source !== 'nickname') {
        log(`⚠️  昵称拿不到${nickname ? '或不能用作目录名' : ''}，目录名退回 ${resolved.source === 'uid' ? 'UID' : '固定名'}`);
      }
      log(`账号目录：${accountName}（取自${resolved.source === 'nickname' ? '昵称' : ' UID'}）`);
    }
    mkdirSync(dataDir, { recursive: true });
    for (const [name, value] of files) {
      if (name === 'meta.json') continue;
      writeFileSync(join(dataDir, name), JSON.stringify(value, null, 1));
    }
    writeFileSync(join(dataDir, 'meta.json'), JSON.stringify(meta, null, 2));

    // 完整性：金抽数 + 垫抽 == 官方总抽（6/6 频道实测成立）
    const index = files.get('index.json');
    let bad = 0;
    for (const ch of CFG.channels) {
      const stat = (index.data.type_stats ?? []).find((t) => t.gacha_type === ch.enum);
      if (!stat) continue;
      const read = (f) => {
        const p = join(dataDir, f);
        return existsSync(p) ? JSON.parse(readFileSync(p)) : { data: { list: [] } };
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

    const summary = meta.channels ?? {};
    const totPulls = Object.values(summary).reduce((s, v) => s + (v.pulls ?? 0), 0);
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
    stopImageServer();
    purge({ when: '收尾' });
  }
}

for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(sig, () => {
    try {
      stopImageServer();
      purge({ when: `收到 ${sig}` });
    } catch { /* 退出路径上不要再抛 */ }
    process.exit(code);
  });
}

main().catch((e) => {
  console.error('[zzz] 失败：', e.message);
  process.exit(1);
});
