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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openDriver } from './drivers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const argOf = (f, d) => {
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

async function ask(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`${question} … `);
  rl.close();
  return answer;
}

const pause = (msg = '按回车继续') => ask(msg);

// ------------------------------------------------------------ 页面状态探针

const pageState = `(() => {
  const root = document.querySelector('main.page');
  const text = document.body ? document.body.innerText : '';
  return {
    mounted: !!root,
    cls: root ? root.className : null,
    loggedOut: root ? (root.className || '').includes('logged-out') : null,
    hasUid: text.indexOf('UID') >= 0,
    textLen: text.length
  };
})()`;

// ---------------------------------------------------------------- 扫码登录

/**
 * @param {import('./drivers.mjs').CdpDriver | any} drv 驱动实例（接口见 drivers.mjs）
 */
async function loginFlow(drv) {
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
    log('⚠️  登录框（跨域 iframe）没出现。');
    log('    请在浏览器里手动点「登录」并扫码，完成后回到这里按回车。');
    await pause();
    return;
  }
  log('已进入登录 frame');

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
    const big = await drv.evaluateInFrame(frame, `(() => {
      return [...document.images].filter(i => (i.src || '').startsWith('data:image') && i.naturalWidth >= 120).length;
    })()`);
    if (big > 0) { if (i === 0) log('已在扫码模式'); break; }
    if (i === 0) log('切换到扫码：', hit);
    if (hit === 'no-target') break;
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
   *   1) 只由用户主动输入 r 触发，这里没有任何定时器/自动循环
   *   2) 全局最多重取 MAX_QR_REFRESH 次，两次之间至少隔 5 秒
   * 用户离开时脚本就停在 ask() 上等，不会在后台空转。
   */
  const MAX_QR_REFRESH = 3;
  const REFRESH_MIN_GAP_MS = 5000;
  let refreshCount = 0;
  let lastRefreshAt = 0;

  log(`扫完按回车继续；二维码过期了按 r 换一张（最多 ${MAX_QR_REFRESH} 次）。`);
  for (;;) {
    const answer = await ask('扫码完成后按回车（或输入 r 刷新二维码）');
    if (answer.trim().toLowerCase() !== 'r') break;

    if (refreshCount >= MAX_QR_REFRESH) {
      log(`已重取 ${refreshCount} 次，达到上限，不再自动换图。`);
      log('请检查网络或换浏览器重试；也可以重新跑一次脚本。');
      break;
    }
    const since = Date.now() - lastRefreshAt;
    if (lastRefreshAt && since < REFRESH_MIN_GAP_MS) {
      log(`刷新太快了，请等 ${Math.ceil((REFRESH_MIN_GAP_MS - since) / 1000)} 秒后再试。`);
      continue;
    }

    lastRefreshAt = Date.now();
    refreshCount += 1;
    const hit = await refreshQr();
    qr = await grabQr();
    issuedAt = Date.now();
    const left = MAX_QR_REFRESH - refreshCount;
    if (qr?.src) {
      const file = saveQr(qr);
      if (hit === 'no-expired-node') {
        // 还没到期时登录框没有「已过期」节点，点不动是正常的，拿到的还是同一张。
        log(`二维码尚未过期，仍是同一张（${file}）。等过期后再按 r 才会换新。剩余 ${left} 次。`);
      } else {
        log(`已换新二维码（${hit}）：${file}，2 分钟内有效。剩余 ${left} 次。`);
      }
    } else {
      log(`刷新后没读到二维码（${hit}）。请在浏览器里手动点刷新。剩余 ${left} 次。`);
      if (refreshCount >= 2) {
        log('连续刷新拿不到图，可能是登录态或风控问题，建议停下排查。');
      }
    }
  }

  // 4) 轮询登录态
  const ok = await drv.waitFor(`(() => {
    const t = document.body ? document.body.innerText : '';
    return /UID\\s*\\d{6,}/.test(t) || t.indexOf('总调频次数') >= 0 ? 'logged-in' : null;
  })()`, 150000, 3000);
  if (!ok) throw new Error('等待登录超时。重新跑一次会生成新二维码。');
  log('登录成功');
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
    await loginFlow(drv);

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
