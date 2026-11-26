import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SdkError, assert, abortable, checkAbort } from '../common/errors.mjs';
import { notify, requestJson } from '../common/http.mjs';
import { encodeQrDataUrl } from '../common/qr.mjs';

const ROOT = 'https://passport-api.mihoyo.com/account/ma-cn-passport/web';
const COOKIE_NAMES = ['cookie_token_v2', 'ltoken_v2', 'account_id_v2', 'account_mid_v2'];
const TTL = 120000; // 本地过期估计；服务端 Expired 同样触发重新申请。

function confirmedCookie(response) {
  // 同一次 Confirmed 响应读取；绝不再查一次票据来补取。tokens 空数组不是错误。
  const headers = response.headers;
  const lines = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie()
    : (headers?.get?.('set-cookie') ?? '').split(/,(?=\s*[^;,\s]+=)/);
  const found = new Map();
  for (const line of lines) {
    const pair = line.split(';')[0].trim(), split = pair.indexOf('=');
    if (split < 1) continue;
    const key = pair.slice(0, split), value = pair.slice(split + 1);
    if (COOKIE_NAMES.includes(key) && value && !/[\r\n;]/.test(value)) found.set(key, value);
  }
  if (!COOKIE_NAMES.every(name => found.has(name))) throw new SdkError('INVALID_RESPONSE', 'Confirmed 响应缺少必需登录 Cookie');
  return COOKIE_NAMES.map(name => `${name}=${found.get(name)}`).join('; ');
}

/** 国服 web 扫码 → 四项 Cookie → 游戏角色。只在内存保存，不打印或落盘。
 * maxWaitMs 默认10分钟，为整体等待预算；每张码约2分钟，过期自动更新。
 * 返回会话可直接传 zzz.collect(session)，会话不持有回调或依赖。
 */
export async function loginZzzWeb({ onQr, onProgress, signal, pollMs = 2000,
  maxWaitMs = 600000, deviceId = randomUUID(), role: requested, selectRole,
  dependencies = {} } = {}) {
  assert(typeof onQr === 'function', '必须提供 onQr');
  assert(Number.isFinite(pollMs) && pollMs > 0 && Number.isFinite(maxWaitMs) && maxWaitMs > 0, '等待参数必须是正数');
  assert(typeof deviceId === 'string' && /^[0-9a-f-]{36}$/i.test(deviceId), 'deviceId 必须是 UUID');
  const now = dependencies.now ?? Date.now, fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? (ms => delay(ms, undefined, { signal }));
  assert([now, fetchImpl, sleep, dependencies.encodeQr ?? encodeQrDataUrl].every(fn => typeof fn === 'function'), '依赖必须是函数');
  const headers = { 'Content-Type': 'application/json', 'x-rpc-app_id': 'cieb8o6xs1kw',
    'x-rpc-client_type': '4', 'x-rpc-game_biz': 'nap_cn', 'x-rpc-sdk_version': '2.57.0',
    'x-rpc-device_id': deviceId, Origin: 'https://user.mihoyo.com', Referer: 'https://user.mihoyo.com/' };
  const deadline = now() + maxWaitMs;
  const progress = status => notify(onProgress, { stage: 'login', status }, signal);
  async function post(path, body) {
    try {
      const response = await abortable(() => fetchImpl(`${ROOT}/${path}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal,
      }), signal);
      if (!response.ok) throw new SdkError('HTTP_ERROR', 'web 登录 HTTP 请求失败');
      let json;
      try { json = await abortable(() => response.json(), signal); }
      catch (error) {
        if (error instanceof SdkError) throw error;
        throw new SdkError('INVALID_RESPONSE', 'web 登录响应不是 JSON');
      }
      if (!Number.isInteger(json?.retcode)) throw new SdkError('INVALID_RESPONSE', 'web 登录缺少 retcode');
      if (json.retcode !== 0) throw new SdkError('UPSTREAM_ERROR', 'web 登录业务请求失败', { retcode: json.retcode });
      return { response, data: json.data };
    } catch (error) {
      checkAbort(signal);
      if (error instanceof SdkError) throw error;
      throw new SdkError('NETWORK_ERROR', 'web 登录网络请求失败');
    }
  }
  await progress('started');
  while (now() < deadline) {
    checkAbort(signal);
    const { data: issued } = await post('createQRLogin', {});
    if (!issued?.ticket || typeof issued.ticket !== 'string' || typeof issued.url !== 'string' || !issued.url) {
      throw new SdkError('INVALID_RESPONSE', '二维码响应缺少 ticket/url');
    }
    const expires = now() + TTL;
    const dataUrl = await abortable(() => (dependencies.encodeQr ?? encodeQrDataUrl)(issued.url), signal);
    await notify(onQr, { dataUrl }, signal);
    await notify(onProgress, { stage: 'login', status: 'qr-issued', ttlMs: TTL }, signal);
    while (now() < deadline) {
      checkAbort(signal);
      if (now() >= expires) { await progress('expired'); break; }
      const { response, data } = await post('queryQRLoginStatus', { ticket: issued.ticket });
      if (data?.status === 'Confirmed') {
        const cookie = confirmedCookie(response);
        const rolesData = await requestJson('https://api-takumi.miyoushe.com/binding/api/getUserGameRolesByCookie', {
          method: 'GET', headers: { Cookie: cookie },
        }, { fetch: fetchImpl, signal });
        if (!Array.isArray(rolesData?.list)) throw new SdkError('INVALID_RESPONSE', '角色响应缺少 list');
        const roles = rolesData.list.filter(role => role.game_biz === 'nap_cn' && role.region === 'prod_gf_cn');
        if (!roles.length) throw new SdkError('ROLE_NOT_FOUND', '账号没有绝区零国服角色');
        let chosen;
        if (requested) chosen = roles.find(r => String(r.game_uid) === String(requested.game_uid) && r.region === requested.region);
        else if (roles.length === 1) chosen = roles[0];
        else if (selectRole) {
          const selected = await notify(selectRole, roles, signal);
          chosen = roles.find(r => String(r.game_uid) === String(selected?.game_uid) && r.region === selected?.region);
        } else throw new SdkError('ROLE_SELECTION_REQUIRED', '存在多个角色，请选择');
        if (!chosen || !/^\d+$/.test(String(chosen.game_uid))) throw new SdkError('INVALID_RESPONSE', '没有选中有效游戏角色');
        await progress('confirmed');
        return { cookie, gameUid: String(chosen.game_uid), region: chosen.region, nickname: chosen.nickname ?? null };
      }
      if (data?.status === 'Expired') { await progress('expired'); break; }
      if (!['Created', 'Scanned'].includes(data?.status)) throw new SdkError('INVALID_RESPONSE', '未知 web 扫码状态');
      await progress(data.status === 'Scanned' ? 'scanned' : 'waiting');
      await abortable(() => sleep(Math.min(pollMs, Math.max(0, deadline - now()), Math.max(0, expires - now()))), signal);
    }
  }
  throw new SdkError('LOGIN_TIMEOUT', 'web 扫码整体等待超时');
}
