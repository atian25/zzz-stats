import { placeholder } from './adapter.mjs';
import { loginZzzWeb } from '../auth/zzz-web.mjs';
import { SdkError, assert, abortable, checkAbort } from '../common/errors.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const CHANNELS = Object.freeze([
  ['2', 'GACHA_TYPE_CHARACTER_UP'], ['102', 'GACHA_TYPE_CHARACTER_RETURN'],
  ['3', 'GACHA_TYPE_WEAPON_UP'], ['103', 'GACHA_TYPE_WEAPON_RETURN'],
  ['1', 'GACHA_TYPE_PERMANENT'], ['5', 'GACHA_TYPE_BANGBOO'],
].map(([id, enumName]) => Object.freeze({ id, enum: enumName })));

function versionsDesc(versions) {
  return [...versions].sort((a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    return pb[0] - pa[0] || (pb[1] ?? 0) - (pa[1] ?? 0);
  });
}

/** 返回官方聚合响应对象，键名不带 .json；不生成 meta 或报表统计。
 * @param {{cookie:string, gameUid:string, region?:string, channels?:string[],
 * signal?:AbortSignal, dependencies?:{fetch?:Function,sleep?:Function}}} options
 */
async function collect({ cookie, gameUid, region = 'prod_gf_cn', channels = CHANNELS.map(ch => ch.id),
  signal, dependencies = {} } = {}) {
  assert(typeof cookie === 'string' && cookie.length > 0 && !/[\r\n]/.test(cookie), '需要有效 Cookie');
  assert(typeof gameUid === 'string' && /^\d+$/.test(gameUid), 'gameUid 必须是数字字符串');
  assert(['prod_gf_cn', 'prod_gf_jp', 'prod_gf_us', 'prod_gf_eu', 'prod_gf_sg'].includes(region), '不支持的 region');
  assert(Array.isArray(channels) && channels.length > 0 && new Set(channels).size === channels.length &&
    channels.every(id => CHANNELS.some(ch => ch.id === id)), 'channels 必须是受支持且不重复的频道 ID');
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? (ms => delay(ms, undefined, { signal }));
  assert(typeof fetchImpl === 'function' && typeof sleep === 'function', 'fetch/sleep 必须是函数');
  const base = region === 'prod_gf_cn' ? zzz.endpoints.cn : zzz.endpoints.os;
  let requested = false;
  async function request(path, query = {}) {
    checkAbort(signal);
    if (requested) await abortable(() => sleep(350), signal);
    requested = true;
    const params = new URLSearchParams({ uid: gameUid, region, ...query });
    try {
      const response = await abortable(() => fetchImpl(`${base}${path}?${params}`, {
        method: 'GET', headers: { Cookie: cookie, Referer: zzz.referer }, signal,
      }), signal);
      if (!response.ok) throw new SdkError('HTTP_ERROR', 'act HTTP 请求失败', { stage: 'collect' });
      let json;
      try { json = await abortable(() => response.json(), signal); }
      catch (error) {
        if (error instanceof SdkError) throw error;
        throw new SdkError('INVALID_RESPONSE', 'act 响应不是 JSON', { stage: 'collect' });
      }
      if (!json || !Number.isInteger(json.retcode)) throw new SdkError('INVALID_RESPONSE', 'act 响应缺少 retcode');
      if (json.retcode !== 0) throw new SdkError(json.retcode === -100 ? 'AUTH_EXPIRED' : 'UPSTREAM_ERROR',
        'act 业务请求失败', { stage: 'collect', retcode: json.retcode });
      if (!json.data || typeof json.data !== 'object') throw new SdkError('INVALID_RESPONSE', 'act 响应缺少 data');
      return json;
    } catch (error) {
      checkAbort(signal);
      if (error instanceof SdkError) throw error;
      // 底层错误可能带 Cookie/URL，不转存 message 或 cause。
      throw new SdkError('NETWORK_ERROR', 'act 网络请求失败', { stage: 'collect' });
    }
  }
  const index = await request('/index');
  if (!Array.isArray(index.data.type_stats)) throw new SdkError('INVALID_RESPONSE', 'index 缺少 type_stats');
  const byEnum = new Map(index.data.type_stats.map(stat => [stat.gacha_type, stat]));
  const result = { index };
  for (const id of channels) {
    checkAbort(signal);
    const ch = CHANNELS.find(value => value.id === id);
    let cur;
    try {
      cur = await request('/cur_pool_stat', { gacha_type: id });
      if (!Array.isArray(cur.data.list)) throw new SdkError('INVALID_RESPONSE', 'cur 响应缺少 list');
    } catch {
      checkAbort(signal); // 取消不能被单频道容错吞掉。
      cur = { retcode: 0, data: { list: [] } };
    }
    result[`cur_pool_stat_${id}`] = cur;
    const source = byEnum.get(ch.enum)?.has_data_vers ?? [];
    if (!Array.isArray(source)) throw new SdkError('INVALID_RESPONSE', 'has_data_vers 必须是数组');
    const versions = versionsDesc(source), pools = [];
    for (let start = 0; start < versions.length; start += 10) {
      const hist = await request('/hist_pool_stat', { gacha_type: id, vers: versions.slice(start, start + 10).join(',') });
      if (!Array.isArray(hist.data.list)) throw new SdkError('INVALID_RESPONSE', 'hist 响应缺少 list');
      pools.push(...hist.data.list);
    }
    const seen = new Set();
    const list = pools.filter(pool => {
      const key = `${pool.gacha_type}|${pool.version}|${pool.start_ts}|${pool.end_ts}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    result[`hist_pool_stat_${id}`] = { retcode: 0, message: 'OK', data: { cur_ver: index.data.cur_ver, list } };
  }
  return result;
}

// 绝区零保留 web 扫码 + Cookie，采集走 act 官方聚合接口。
// authkey 日志存在结构性数据缺失，不能用它替代聚合接口导致报表掉功能。
// 不导入、不改动旧 zzz-stats-sdk；web 登录与采集均独立实现。
export const zzz = Object.freeze({
  ...placeholder({
    game: 'zzz', channels: ['2', '102', '3', '103', '1', '5'],
    endpoint: 'https://act-api-takumi.mihoyo.com/event/nap_gacha_record/api/zzz',
    verification: 'web + Cookie + act 路线已有外部验证；新包 web 扫码登录仅假网络验收',
  }),
  collect,
  loginMethod: 'web',
  protocol: 'act-aggregate',
  endpoints: Object.freeze({
    cn: 'https://act-api-takumi.mihoyo.com/event/nap_gacha_record/api/zzz',
    os: 'https://sg-act-public-api.hoyolab.com/event/nap_gacha_record/api/zzz',
  }),
  // act 缺此 Referer 会回 -100，不能误判为 Cookie 自身失效。
  referer: 'https://act.mihoyo.com/zzz/event/gacha-record/index.html',
  login: loginZzzWeb,
});
