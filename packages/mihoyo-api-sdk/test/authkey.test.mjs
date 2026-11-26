import test from 'node:test';
import assert from 'node:assert/strict';
import { genshin, starrail } from '../index.mjs';
const reply = json => ({ ok: true, json: async () => json });
const ok = data => ({ retcode: 0, message: 'OK', data });
const role = { game_biz: 'hk4e_cn', game_uid: '10000001', region: 'cn_gf01' };
const options = { authkey: 'FAKE_AUTHKEY', role, channels: ['301'] };

test('原神分页末条 id 原样传递，短页不停止，空页停止并保留原响应', async () => {
  const pages = [ok({ list: [{ id: '99999999999999999999', extra: true }] }),
    ok({ list: [{ id: '88888888888888888888' }] }), ok({ list: [], extra: 'EMPTY' })];
  const calls = [], waits = [];
  const result = await genshin.collect({ ...options, dependencies: {
    sleep: async ms => waits.push(ms), fetch: async url => {
      const u = new URL(url); calls.push(u);
      assert.equal(u.origin + u.pathname, genshin.endpoint);
      return reply(pages[calls.length - 1]);
    },
  } });
  assert.deepEqual(calls.map(u => u.searchParams.get('end_id')), ['0', '99999999999999999999', '88888888888888888888']);
  assert.deepEqual(calls.map(u => u.searchParams.get('page')), ['1', '2', '3']);
  assert.deepEqual(waits, [350, 350]);
  assert.equal(result['301'][0], pages[0]);
  assert.equal(result['301'][2], pages[2]);
});

test('原神/星铁频道、host、授权参数与首分页正确，星铁未验证标注存在', async () => {
  for (const adapter of [genshin, starrail]) {
    const calls = [];
    const selectedRole = { ...role, game_biz: adapter.gameBiz };
    await adapter.collect({ authkey: 'FAKE_AUTHKEY', role: selectedRole, dependencies: {
      sleep: async () => {}, fetch: async url => { calls.push(new URL(url)); return reply(ok({ list: [] })); },
    } });
    assert.deepEqual(calls.map(u => u.searchParams.get('gacha_type')), adapter.channels);
    for (const u of calls) {
      assert.equal(u.origin + u.pathname, adapter.endpoint);
      for (const [key, value] of Object.entries({ authkey_ver: '1', sign_type: '2', auth_appid: 'webview_gacha',
        lang: 'zh-cn', device_type: 'mobile', game_biz: adapter.gameBiz, region: role.region, uid: role.game_uid,
        page: '1', size: '20', end_id: '0', authkey: 'FAKE_AUTHKEY' })) assert.equal(u.searchParams.get(key), value);
      assert.equal(u.searchParams.get('init_type'), u.searchParams.get('gacha_type'));
    }
  }
  assert.deepEqual(genshin.channels, ['301', '302', '200']);
  assert.deepEqual(starrail.channels, ['1', '2', '11', '12', '21', '22']);
  assert.match(starrail.verification, /未验证/);
});

test('重复游标与分页上限报错，不静默返回不完整结果', async () => {
  for (const [maxPages, code] of [[5, 'PAGINATION_STALLED'], [1, 'PAGE_LIMIT_EXCEEDED']]) {
    let calls = 0;
    await assert.rejects(genshin.collect({ ...options, maxPages, dependencies: {
      sleep: async () => {}, fetch: async () => { calls++; return reply(ok({ list: [{ id: '123' }] })); },
    } }), { code });
    assert.equal(calls, maxPages === 1 ? 1 : 2);
  }
});

test('错误与取消不泄漏 authkey；无效记录 id 拒绝 Number 化', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(genshin.collect({ ...options, signal: controller.signal }), { code: 'ABORTED' });
  await assert.rejects(genshin.collect({ ...options, dependencies: {
    fetch: async () => { throw Error('FAKE_AUTHKEY'); },
  } }), error => error.code === 'NETWORK_ERROR' && !String(error).includes('FAKE_AUTHKEY'));
  await assert.rejects(genshin.collect({ ...options, dependencies: {
    fetch: async () => reply(ok({ list: [{ id: 123 }] })),
  } }), { code: 'INVALID_RESPONSE' });
});

function loginDependencies(roles, calls) {
  return { encodeQr: async () => 'data:image/png;base64,FAKE', random: () => '123456', fetch: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('createQRLogin')) return reply(ok({ ticket: 'FAKE_TICKET', url: 'https://example.invalid/qr' }));
    if (url.endsWith('queryQRLoginStatus')) return reply(ok({ status: 'Confirmed',
      tokens: [{ token_type: 1, token: 'v2_FAKE' }], user_info: { mid: 'FAKE_MID', aid: '99999999' } }));
    if (url.endsWith('getUserGameRolesByStoken')) return reply(ok({ list: roles }));
    assert.equal(url.endsWith('genAuthKey'), true);
    return reply(ok({ authkey: 'FAKE_AUTHKEY' }));
  } };
}
test('App 登录按游戏过滤角色并以游戏 UID 生成 authkey', async () => {
  for (const adapter of [genshin, starrail]) {
    const target = { ...role, game_biz: adapter.gameBiz }, calls = [];
    const result = await adapter.login({ deviceFp: 'FAKE_FP', onQr() {},
      dependencies: loginDependencies([{ ...role, game_biz: 'nap_cn' }, target], calls) });
    assert.deepEqual(result, { authkey: 'FAKE_AUTHKEY', role: target });
    assert.equal(calls.length, 4);
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), { auth_appid: 'webview_gacha',
      game_biz: adapter.gameBiz, game_uid: 10000001, region: 'cn_gf01' });
    assert.equal(calls.at(-1).init.headers['x-rpc-client_type'], '5');
  }
});
test('多角色必须选择；回调选择只能来自账号角色列表', async () => {
  const roles = [role, { ...role, game_uid: '10000002' }];
  await assert.rejects(genshin.login({ deviceFp: 'FAKE_FP', onQr() {},
    dependencies: loginDependencies(roles, []) }), { code: 'ROLE_SELECTION_REQUIRED' });
  const result = await genshin.login({ deviceFp: 'FAKE_FP', onQr() {}, selectRole: list => list[1],
    dependencies: loginDependencies(roles, []) });
  assert.equal(result.role.game_uid, '10000002');
  await assert.rejects(genshin.login({ deviceFp: 'FAKE_FP', onQr() {}, selectRole: () => ({ game_uid: '7', region: 'cn_gf01' }),
    dependencies: loginDependencies(roles, []) }), { code: 'INVALID_ARGUMENT' });
});
