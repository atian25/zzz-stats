import { setTimeout as delay } from 'node:timers/promises';
import { loginByAppQr } from '../auth/app.mjs';
import { getRoles, generateAuthKey } from '../auth/binding.mjs';
import { assert, SdkError, abortable, checkAbort } from '../common/errors.mjs';
import { notify } from '../common/http.mjs';

/** 共用授权/分页机制，不统一游戏数据、不做统计。 */
export function authkeyAdapter({ game, gameBiz, channels, endpoint, verification }) {
  return Object.freeze({
    game, gameBiz, channels: Object.freeze(channels), endpoint, verification,
    loginMethod: 'app', protocol: 'authkey-log',
    /** App 扫码后选本游戏角色并换 authkey；多角色不猜第一条。
     * @param {{role?:object,selectRole?:Function,deviceFp:string,onQr:Function}} options
     * @returns {Promise<{authkey:string,role:object}>} 含敏感 authkey，不用于公开输出。
     */
    async login({ role: requested, selectRole, ...options } = {}) {
      const credential = await loginByAppQr(options);
      const roles = (await getRoles({ credential, signal: options.signal, dependencies: options.dependencies }))
        .filter(role => role.game_biz === gameBiz);
      if (!roles.length) throw new SdkError('ROLE_NOT_FOUND', '账号没有该游戏角色');
      let chosen;
      if (requested) chosen = roles.find(role => String(role.game_uid) === String(requested.game_uid) && role.region === requested.region);
      else if (roles.length === 1) chosen = roles[0];
      else if (selectRole) {
        const selected = await notify(selectRole, roles, options.signal);
        chosen = roles.find(role => String(role.game_uid) === String(selected?.game_uid) && role.region === selected?.region);
      } else throw new SdkError('ROLE_SELECTION_REQUIRED', '存在多个游戏角色，请选择');
      if (!chosen) throw new SdkError('INVALID_ARGUMENT', '选择的角色不在当前账号游戏角色列表');
      const authkey = await generateAuthKey({ credential, gameBiz, gameUid: chosen.game_uid,
        region: chosen.region, signal: options.signal, dependencies: options.dependencies });
      return { authkey, role: chosen };
    },
    /** 返回频道 → 原样响应数组（含终止空页），不改写/合并上游 list。
     * @param {{authkey:string,role:object,channels?:string[],maxPages?:number,
     * intervalMs?:number,signal?:AbortSignal,dependencies?:object}} options
     */
    async collect({ authkey, role, channels: selected = channels, maxPages = 1000,
      intervalMs = 350, signal, dependencies = {} } = {}) {
      assert(typeof authkey === 'string' && authkey.length > 0, '需要 authkey');
      assert(role?.game_biz === gameBiz && /^\d+$/.test(String(role?.game_uid ?? '')) &&
        typeof role.region === 'string' && role.region.length > 0, '需要本游戏的有效角色');
      assert(Array.isArray(selected) && selected.length > 0 && new Set(selected).size === selected.length &&
        selected.every(id => channels.includes(id)), '频道必须受支持且唯一');
      assert(Number.isSafeInteger(maxPages) && maxPages > 0, 'maxPages 必须是正整数');
      assert(Number.isFinite(intervalMs) && intervalMs >= 0, 'intervalMs 必须是非负数');
      const fetchImpl = dependencies.fetch ?? globalThis.fetch;
      const sleep = dependencies.sleep ?? (ms => delay(ms, undefined, { signal }));
      assert(typeof fetchImpl === 'function' && typeof sleep === 'function', 'fetch/sleep 必须是函数');
      const result = {}; let requested = false;
      for (const id of selected) {
        const pages = []; result[id] = pages;
        let endId = '0', complete = false;
        const cursors = new Set(['0']);
        for (let page = 1; page <= maxPages; page++) {
          checkAbort(signal);
          if (requested) await abortable(() => sleep(intervalMs), signal);
          requested = true;
          const params = new URLSearchParams({ authkey_ver: '1', sign_type: '2', auth_appid: 'webview_gacha',
            init_type: id, lang: 'zh-cn', device_type: 'mobile', game_biz: gameBiz, region: role.region,
            uid: String(role.game_uid), gacha_type: id, page: String(page), size: '20', end_id: endId, authkey });
          let json;
          try {
            const response = await abortable(() => fetchImpl(`${endpoint}?${params}`, { method: 'GET', signal }), signal);
            if (!response.ok) throw new SdkError('HTTP_ERROR', '抽卡日志 HTTP 请求失败');
            try { json = await abortable(() => response.json(), signal); }
            catch (error) {
              if (error instanceof SdkError) throw error;
              throw new SdkError('INVALID_RESPONSE', '抽卡日志响应不是 JSON');
            }
          } catch (error) {
            checkAbort(signal);
            if (error instanceof SdkError) throw error;
            // URL 含 authkey，不能泄漏底层 message/cause。
            throw new SdkError('NETWORK_ERROR', '抽卡日志网络请求失败');
          }
          if (!Number.isInteger(json?.retcode)) throw new SdkError('INVALID_RESPONSE', '抽卡日志缺少 retcode');
          if (json.retcode !== 0) throw new SdkError('UPSTREAM_ERROR', '抽卡日志业务请求失败', { retcode: json.retcode });
          if (!Array.isArray(json.data?.list)) throw new SdkError('INVALID_RESPONSE', '抽卡日志缺少 list');
          pages.push(json);
          if (!json.data.list.length) { complete = true; break; }
          const next = json.data.list.at(-1)?.id;
          // id 必须保持字符串，不能 Number 化丢失精度。
          if (typeof next !== 'string' || !/^\d+$/.test(next)) throw new SdkError('INVALID_RESPONSE', '分页末条 id 必须是数字字符串');
          if (cursors.has(next)) throw new SdkError('PAGINATION_STALLED', '分页游标重复');
          cursors.add(next); endId = next;
        }
        if (!complete) throw new SdkError('PAGE_LIMIT_EXCEEDED', '分页达到上限，未完成采集');
      }
      return result;
    },
  });
}
