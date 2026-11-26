import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PROFILES, signedHeaders } from '../common/ds.mjs';
import { SdkError, assert, checkAbort, abortable } from '../common/errors.mjs';
import { requestJson, notify } from '../common/http.mjs';
import { encodeQrDataUrl } from '../common/qr.mjs';

const PASSPORT = 'https://passport-api.mihoyo.com/account/ma-cn-passport/app';
const VERSION = '2.119.0';

/** Confirmed 的凭据在 data.tokens 数组，不在 data.token.token。 */
export function parseSToken(data) {
  const token = Array.isArray(data?.tokens) && data.tokens.find(item => item?.token_type === 1);
  const stoken = token?.token, mid = data?.user_info?.mid, aid = data?.user_info?.aid;
  if (typeof stoken !== 'string' || !stoken.startsWith('v2_') || stoken.length <= 3 ||
      typeof mid !== 'string' || !mid || !/^\d+$/.test(String(aid ?? ''))) {
    throw new SdkError('INVALID_RESPONSE', 'Confirmed 响应缺少有效 SToken/mid/aid');
  }
  return Object.freeze({ stoken, mid, aid: String(aid) });
}

function appHeaders(body, deviceId, deviceFp, dependencies) {
  return {
    'Content-Type': 'application/json',
    'user-agent': `Mozilla/5.0 miHoYoBBS/${VERSION} Capture/2.2.0`,
    'x-rpc-app_version': VERSION, 'x-rpc-sdk_version': VERSION,
    'x-rpc-account_version': VERSION, 'x-rpc-app_id': 'bll8iq97cem8',
    'x-rpc-game_biz': 'bbs_cn', 'x-rpc-device_id': deviceId,
    'x-rpc-device_fp': deviceFp,
    ...signedHeaders(PROFILES.passport, { body, now: dependencies.now, random: dependencies.random }),
  };
}

/**
 * App 扫码 → SToken。国服接口；不启动浏览器、不保存凭据或二维码。
 * web/createQRLogin 只发 ltoken，不能用于 genAuthKey；不能将 ltoken 当 stoken。
 * deviceFp 来源未给出，要求调用方提供真实设备指纹，不伪造兜底值。
 * @param {{deviceFp:string, deviceId?:string, onQr:Function, onProgress?:Function,
 * signal?:AbortSignal, pollMs?:number, maxWaitMs?:number, dependencies?:object}} options
 */
export async function loginByAppQr({ deviceFp, deviceId = randomUUID(), onQr, onProgress,
  signal, pollMs = 2000, maxWaitMs = 120000, dependencies = {} } = {}) {
  assert(typeof deviceFp === 'string' && deviceFp.length > 0, '必须提供 deviceFp');
  assert(typeof deviceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId), 'deviceId 必须是 UUID');
  assert(typeof onQr === 'function', '必须提供 onQr');
  assert(Number.isFinite(pollMs) && pollMs > 0 && Number.isFinite(maxWaitMs) && maxWaitMs > 0, '等待参数必须是正数');
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? (ms => delay(ms, undefined, { signal }));
  const deadline = now() + maxWaitMs;
  const post = (path, value) => {
    const body = JSON.stringify(value);
    return requestJson(`${PASSPORT}/${path}`, { method: 'POST', body,
      headers: appHeaders(body, deviceId, deviceFp, dependencies) }, { ...dependencies, signal });
  };
  await notify(onProgress, { stage: 'login', status: 'started' }, signal);
  const issued = await post('createQRLogin', {});
  if (typeof issued?.ticket !== 'string' || !issued.ticket || typeof issued?.url !== 'string' || !issued.url) {
    throw new SdkError('INVALID_RESPONSE', '二维码响应缺少 ticket/url');
  }
  const dataUrl = await abortable(() => (dependencies.encodeQr ?? encodeQrDataUrl)(issued.url), signal);
  await notify(onQr, { dataUrl }, signal);
  await notify(onProgress, { stage: 'login', status: 'qr-issued' }, signal);
  while (now() < deadline) {
    checkAbort(signal);
    const data = await post('queryQRLoginStatus', { ticket: issued.ticket });
    if (data?.status === 'Confirmed') {
      const credential = parseSToken(data);
      await notify(onProgress, { stage: 'login', status: 'confirmed' }, signal);
      return credential;
    }
    if (data?.status === 'Expired') throw new SdkError('QR_EXPIRED', '二维码已过期');
    if (!['Created', 'Scanned'].includes(data?.status)) throw new SdkError('INVALID_RESPONSE', '未知扫码状态');
    await notify(onProgress, { stage: 'login', status: data.status === 'Scanned' ? 'scanned' : 'waiting' }, signal);
    await abortable(() => wait(Math.min(pollMs, Math.max(0, deadline - now()))), signal);
  }
  throw new SdkError('LOGIN_TIMEOUT', '扫码等待超时');
}
