import test from 'node:test';
import assert from 'node:assert/strict';
import { zzz } from '../index.mjs';
const names = ['cookie_token_v2', 'ltoken_v2', 'account_id_v2', 'account_mid_v2'];
const cookies = names.map((name, i) => `${name}=FAKE_${i}; Path=/; HttpOnly`);
const reply = (data, setCookies = []) => ({ ok: true, headers: { getSetCookie: () => setCookies },
  json: async () => ({ retcode: 0, data }) });

function harness({ expired = false, missing = false, localExpiry = false } = {}) {
  const calls = [], events = [], qr = []; let created = 0, clock = 0;
  const dependencies = { now: () => clock, sleep: async ms => { clock += ms; }, encodeQr: async url => `FAKE_PNG:${url}`,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('createQRLogin')) {
        created++; assert.equal(init.body, '{}');
        assert.equal(init.headers['x-rpc-client_type'], '4');
        assert.equal(init.headers['x-rpc-app_id'], 'cieb8o6xs1kw');
        return reply({ ticket: `FAKE_TICKET_${created}`, url: `FAKE_QR_${created}` });
      }
      if (url.endsWith('queryQRLoginStatus')) {
        assert.equal(JSON.parse(init.body).ticket, `FAKE_TICKET_${created}`);
        if (created === 1 && expired) return reply({ status: 'Expired' });
        if (created === 1 && localExpiry) { clock += 120001; return reply({ status: 'Created' }); }
        return reply({ status: 'Confirmed', tokens: [], user_info: { aid: '99999999' } }, missing !== false ? cookies.filter((_, i) => i !== missing) : cookies);
      }
      if (url.endsWith('getUserGameRolesByCookie')) return reply({ list: [
        { game_biz: 'hk4e_cn', game_uid: '666', region: 'cn_gf01' },
        { game_biz: 'nap_cn', game_uid: '10000001', region: 'prod_gf_cn', nickname: 'FAKE_NICK' },
      ] });
      if (url.includes('/index?')) return reply({ type_stats: [] });
      return reply({ list: [] });
    } };
  return { calls, events, qr, dependencies, options: { dependencies,
    onQr: payload => qr.push(payload), onProgress: event => events.push(event) } };
}

test('tokens 空数组从 Confirmed Set-Cookie 取四项，游戏 UID 非 aid，直接接 collect', async () => {
  const h = harness(); const session = await zzz.login(h.options);
  assert.equal(session.gameUid, '10000001');
  assert.equal(session.region, 'prod_gf_cn');
  assert.equal(session.cookie, names.map((name, i) => `${name}=FAKE_${i}`).join('; '));
  assert.equal(h.calls.filter(c => c.url.endsWith('queryQRLoginStatus')).length, 1);
  assert.equal(h.qr.length, 1);
  assert.ok(!JSON.stringify(h.events).includes('FAKE_'));
  const result = await zzz.collect({ ...session, dependencies: h.dependencies });
  assert.equal(Object.keys(result).length, 13);
  const act = h.calls.find(c => c.url.includes('/index?'));
  assert.equal(act.init.headers.Cookie, session.cookie);
  assert.equal(act.init.headers.Referer, zzz.referer);
});
test('服务端过期自动换码，重新票据轮询后成功', async () => {
  const h = harness({ expired: true }); await zzz.login(h.options);
  assert.equal(h.qr.length, 2);
  assert.notDeepEqual(h.qr[0], h.qr[1]);
  assert.ok(h.events.some(e => e.status === 'expired'));
  assert.equal(new Set(h.calls.filter(c => c.url.endsWith('createQRLogin')).map(c => c.init.headers['x-rpc-device_id'])).size, 1);
});
test('本地2分钟过期也自动换码，不等整体预算结束', async () => {
  const h = harness({ localExpiry: true }); await zzz.login(h.options);
  assert.equal(h.qr.length, 2);
});
test('缺任一必需 Cookie 报错，不重复轮询或请求角色；错误不带凭据', async () => {
  for (let missing = 0; missing < names.length; missing++) {
    const h = harness({ missing });
    await assert.rejects(zzz.login(h.options), error => error.code === 'INVALID_RESPONSE' && !String(error).includes('FAKE_'));
    assert.equal(h.calls.filter(c => c.url.endsWith('queryQRLoginStatus')).length, 1);
    assert.ok(!h.calls.some(c => c.url.endsWith('getUserGameRolesByCookie')));
  }
});
test('取消覆盖等待请求，底层错误不带入 Cookie/ticket', async () => {
  const controller = new AbortController(); const h = harness();
  controller.abort(); await assert.rejects(zzz.login({ ...h.options, signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(h.calls.length, 0);
  const active = new AbortController();
  await assert.rejects(zzz.login({ onQr() {}, signal: active.signal, dependencies: {
    fetch: async () => { active.abort(); throw Error('FAKE_COOKIE'); },
  } }), { code: 'ABORTED' });
  await assert.rejects(zzz.login({ onQr() {}, dependencies: { fetch: async () => { throw Error('FAKE_COOKIE'); } } }),
    error => error.code === 'NETWORK_ERROR' && !String(error).includes('FAKE_COOKIE'));
});
