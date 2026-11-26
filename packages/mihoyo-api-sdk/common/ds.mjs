import { createHash, randomInt } from 'node:crypto';
import { assert } from './errors.mjs';

export const APP_VERSION = '2.119.0';
export const APP_UA = `Mozilla/5.0 miHoYoBBS/${APP_VERSION} Capture/2.2.0`;
const APP_HEADERS = Object.freeze({
  'x-rpc-app_version': APP_VERSION,
  'x-rpc-app_id': 'bll8iq97cem8',
  'x-rpc-game_biz': 'bbs_cn',
  'user-agent': APP_UA,
});
// 查角色缺 app_version 已实测返回 -10001，不能只带 Cookie + DS。
// 公共 App 标识可以共享，但 salt、isSign、client_type 必须按接口选取。
export const PROFILES = Object.freeze({
  passport: Object.freeze({ salt: 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs', isSign: false, clientType: '3' }),
  roles: Object.freeze({ salt: '24cf11fb14a84f0683e7cadf7c788ba2', isSign: true, clientType: '2' }),
  authkey: Object.freeze({ salt: '8fb73233f73e200aa1f818b5705d4442', isSign: true, clientType: '5' }),
});

/** body/query 必须与实际发送的字节一致；签名型不包含 b/q。 */
export function createDs({ salt, isSign, body = '', query = '', now = Date.now, random } = {}) {
  assert(typeof salt === 'string' && salt.length > 0 && typeof isSign === 'boolean', 'DS 需要 salt 与 isSign');
  assert(typeof body === 'string' && typeof query === 'string', 'DS body/query 必须是字符串');
  const t = Math.floor(now() / 1000);
  // 签名型使用六位随机字母数字；类型2使用六位随机整数。允许注入以验证固定向量。
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const r = String(random ? random() : isSign
    ? Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('')
    : randomInt(100000, 200001));
  assert(Number.isSafeInteger(t) && t >= 0 && /^[a-zA-Z0-9]+$/.test(r), 'DS 时间或随机值无效');
  const source = `salt=${salt}&t=${t}&r=${r}` + (isSign ? '' : `&b=${body}&q=${query}`);
  return `${t},${r},${createHash('md5').update(source).digest('hex')}`;
}

export function signedHeaders(profile, options = {}) {
  assert(profile && typeof profile.clientType === 'string', '需要接口签名配置');
  return { ...APP_HEADERS, 'x-rpc-client_type': profile.clientType, DS: createDs({ ...profile, ...options }) };
}
