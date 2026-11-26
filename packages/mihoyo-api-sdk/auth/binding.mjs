import { PROFILES, signedHeaders } from '../common/ds.mjs';
import { assert, SdkError } from '../common/errors.mjs';
import { requestJson } from '../common/http.mjs';

const ROOT = 'https://api-takumi.miyoushe.com/binding/api';
function cookie(credential) {
  const { stoken, mid, aid } = credential ?? {};
  assert(typeof stoken === 'string' && stoken.startsWith('v2_') && stoken.length > 3 &&
    typeof mid === 'string' && mid.length > 0 && /^\d+$/.test(String(aid ?? '')) &&
    !/[;\r\n]/.test(stoken + mid), '需要有效 SToken/mid/aid');
  return `stoken=${stoken}; mid=${mid}; stuid=${aid}; account_id=${aid}`;
}

/** 一次返回全部游戏角色，保留上游每条角色的原样字段；不默认选择第一条。 */
export async function getRoles({ credential, signal, dependencies = {} } = {}) {
  const data = await requestJson(`${ROOT}/getUserGameRolesByStoken`, {
    method: 'GET', headers: { Cookie: cookie(credential),
      ...signedHeaders(PROFILES.roles, { now: dependencies.now, random: dependencies.random }) },
  }, { ...dependencies, signal });
  if (!Array.isArray(data?.list)) throw new SdkError('INVALID_RESPONSE', '角色响应缺少 list');
  return data.list;
}

/**
 * 游戏适配器提供 gameBiz/gameUid/region，不从账号 aid 猜游戏 UID。
 * client_type 必须为5；2/4已实测失败。签名型 DS 使用 LK2，不沿用查角色的 K2。
 * @returns {Promise<string>} authkey（敏感凭据，不可写日志或公开报表）
 */
export async function generateAuthKey({ credential, gameBiz, gameUid, region,
  signal, dependencies = {} } = {}) {
  assert(typeof gameBiz === 'string' && /^[a-z0-9_]+$/.test(gameBiz), 'gameBiz 无效');
  assert(typeof region === 'string' && /^[a-z0-9_]+$/.test(region), 'region 无效');
  assert(/^\d+$/.test(String(gameUid ?? '')) && Number.isSafeInteger(Number(gameUid)) && Number(gameUid) > 0, 'gameUid 必须是安全正整数');
  const body = JSON.stringify({ auth_appid: 'webview_gacha', game_biz: gameBiz,
    game_uid: Number(gameUid), region });
  const data = await requestJson(`${ROOT}/genAuthKey`, { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', Cookie: cookie(credential),
      ...signedHeaders(PROFILES.authkey, { body, now: dependencies.now, random: dependencies.random }) },
  }, { ...dependencies, signal });
  if (typeof data?.authkey !== 'string' || !data.authkey) throw new SdkError('INVALID_RESPONSE', '授权响应缺少 authkey');
  return data.authkey;
}
