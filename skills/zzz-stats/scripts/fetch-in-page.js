/**
 * 页内取数脚本 —— 粘进任何「在页面里执行 JS」的工具即可用。
 *
 * 为什么单独做成一段：取数逻辑其实很简单（1 次汇总 + 6 次当前池 + 若干次历史分片），
 * 复杂的只有登录。所以只要你已经让用户登录好（用会话自带的浏览器工具、moli、Playwright、
 * 或人工扫码都行），就能用 2 个能力完成采集：
 *
 *   1) 打开官方页面（国服 act.mihoyo.com，国际服 act.hoyolab.com，见 SKILL.md §2）
 *   2) 把这个文件的内容作为表达式执行
 *      需要换区服时传参：`(${源码})({ region: 'prod_gf_us' })`
 *
 * 返回一个 JSON **字符串**（不要返回对象：有些工具会把大对象截断或转义坏）。
 * 拿到之后交给 `node scripts/save-in-page-json.mjs` 落盘，或直接喂给 build-report。
 *
 * 实测约束：
 *   - 必须在官方页面这个源里执行（act.mihoyo.com / act.hoyolab.com）：接口的 CORS 只放行它
 *   - 不能在 about:blank 或别的站点里执行，会被 CORS 拦
 *   - vers 单次最多 10 个，多了返回 -400005
 *   - 请求之间要停一下，别把对方接口打满
 */
(async (opts = {}) => {
  /*
   * 区服 → 接口基址。
   * 过去写死国服，国际服账号只能换一个文件版本 —— 现在按 REGION 自动选，
   * 也允许调用方通过 opts.base / opts.region 覆盖（如从页面地址里读出来的）。
   */
  const DEFAULT_BASE = 'https://act-api-takumi.mihoyo.com/event/nap_gacha_record/api/zzz';
  const OS_BASE = 'https://sg-act-public-api.hoyolab.com/event/nap_gacha_record/api/zzz';
  /*
   * region 三个来源，优先级从高到低：
   *   1) opts.region     —— agent 显式传 `({ region: 'prod_gf_us' })`
   *   2) window.__ZZZ_REGION —— 已经知道区服、但只能整段粘贴（不能改文件）时的口子
   *   3) prod_gf_cn      —— 国服默认值
   */
  const REGION = opts.region || (typeof window !== 'undefined' && window.__ZZZ_REGION) || 'prod_gf_cn';
  /*
   * 国际服的接口基址也可以从页面自己认出来：
   * 页面在 hoyolab 域下，就说明这是国际服，别把 region 发到 mihoyo 的接口上。
   */
  const PAGE_IS_OS = /(^|\.)hoyolab\.com$/.test(location.hostname);
  const BASE = opts.base || (REGION !== 'prod_gf_cn' || PAGE_IS_OS ? OS_BASE : DEFAULT_BASE);
  const MAX_VERS = 10;
  const ENUM = {
    2: 'GACHA_TYPE_CHARACTER_UP',
    3: 'GACHA_TYPE_WEAPON_UP',
    102: 'GACHA_TYPE_CHARACTER_RETURN',
    103: 'GACHA_TYPE_WEAPON_RETURN',
    1: 'GACHA_TYPE_PERMANENT',
    5: 'GACHA_TYPE_BANGBOO',
  };
  // 频道顺序固定：独家 / 音擎 / 独家重映 / 音擎回响 / 常驻 / 邦布
  const CHANNELS = [2, 3, 102, 103, 1, 5];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const chunk = (a, n) => {
    const out = [];
    for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
    return out;
  };
  const sortVersDesc = (list) =>
    [...list].sort((a, b) => {
      const pa = String(a).split('.').map(Number);
      const pb = String(b).split('.').map(Number);
      return pb[0] - pa[0] || (pb[1] ?? 0) - (pa[1] ?? 0);
    });

  const text = document.body ? document.body.innerText : '';
  const uidMatch = text.match(/UID[\s:：]*([0-9]{6,})/);
  if (!uidMatch) {
    return JSON.stringify({
      ok: false,
      error: 'NOT_LOGGED_IN',
      hint: '页面里没有 UID。先让用户扫码登录，再重跑这段脚本。',
    });
  }
  const uid = uidMatch[1];
  const qs = `uid=${encodeURIComponent(uid)}&region=${encodeURIComponent(REGION)}`;

  const get = async (path, extra = '') => {
    const url = `${BASE}${path}?${qs}${extra ? '&' + extra : ''}`;
    const res = await fetch(url, { credentials: 'include' });
    const json = await res.json();
    if (json.retcode !== 0) {
      const err = new Error(`${path}: retcode=${json.retcode} ${json.message ?? ''}`);
      err.retcode = json.retcode;
      throw err;
    }
    return json;
  };

  const out = {
    ok: true,
    schema: 'zzz-stats/v1',
    uid,
    region: REGION,
    fetchedAt: new Date().toISOString(),
    server: REGION === 'prod_gf_cn' ? 'cn' : 'os',
    pageHost: location.hostname,
    pageIsOverseas: PAGE_IS_OS,
    index: null,
    channels: {},
  };

  // 1) 汇总
  out.index = await get('/index');
  const stats = out.index.data.type_stats ?? [];

  // 2) 逐频道：当前池 + 历史分片
  for (const id of CHANNELS) {
    const stat = stats.find((t) => t.gacha_type === ENUM[id]);

    await sleep(350);
    const cur = await get('/cur_pool_stat', `gacha_type=${id}`).catch(() => ({
      retcode: 0,
      data: { list: [] },
    }));

    // 历史：必须用该频道自己的 has_data_vers，且单次最多 10 个
    const vers = sortVersDesc(stat?.has_data_vers ?? []);
    const pools = [];
    for (const slice of chunk(vers, MAX_VERS)) {
      await sleep(350);
      const hist = await get('/hist_pool_stat', `gacha_type=${id}&vers=${slice.join(',')}`);
      pools.push(...(hist.data?.list ?? []));
    }

    // 分片可能让同一个池子出现两次
    const seen = new Set();
    const merged = pools.filter((p) => {
      const key = `${p.gacha_type}|${p.version}|${p.start_ts}|${p.end_ts}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    out.channels[id] = {
      curPoolStat: cur,
      histPoolStat: {
        retcode: 0,
        message: 'OK',
        data: { cur_ver: out.index.data.cur_ver, list: merged },
      },
      versionCount: vers.length,
    };
  }

  return JSON.stringify(out);
})()
