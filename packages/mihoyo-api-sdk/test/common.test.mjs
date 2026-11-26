import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDs, signedHeaders, PROFILES, parseSToken, loginByAppQr,
  getRoles, generateAuthKey, genshin, starrail, zzz } from '../index.mjs';

const now = () => 1700000000000, random = () => '123456';
const hash = value => createHash('md5').update(value).digest('hex');
const credential = { stoken: 'v2_FAKE_ONLY', mid: 'FAKE_MID', aid: '10000000' };
const confirmed = { status: 'Confirmed', tokens: [{ token_type: 2, token: 'FAKE_LTOKEN' },
  { token_type: 1, token: credential.stoken }], user_info: { mid: credential.mid, aid: credential.aid } };
const reply = data => ({ ok: true, json: async () => ({ retcode: 0, data }) });

test('类型2 DS 对实际 body/query 签名', () => {
  const body = '{"ticket":"FAKE"}', query = 'a=1';
  assert.equal(createDs({ ...PROFILES.passport, now, random, body, query }),
    `1700000000,123456,${hash(`salt=${PROFILES.passport.salt}&t=1700000000&r=123456&b=${body}&q=${query}`)}`);
});
test('签名型 DS 不含 body/query；接口配置各自独立', () => {
  for (const profile of [PROFILES.roles, PROFILES.authkey]) {
    assert.equal(createDs({ ...profile, now, random, body: 'ignored', query: 'ignored' }),
      `1700000000,123456,${hash(`salt=${profile.salt}&t=1700000000&r=123456`)}`);
  }
  assert.deepEqual(Object.values(PROFILES).map(p => p.clientType), ['3', '2', '5']);
  assert.equal(signedHeaders(PROFILES.authkey, { now, random })['x-rpc-client_type'], '5');
});
test('DS 拒绝缺少签名类型与错误输入', () => {
  assert.throws(() => createDs({ salt: 'x' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => createDs({ salt: 'x', isSign: false, body: {} }), { code: 'INVALID_ARGUMENT' });
});
test('Confirmed 只从 tokens 数组的 token_type=1 获取 SToken', () => {
  assert.deepEqual(parseSToken(confirmed), credential);
  assert.equal(Object.isFrozen(parseSToken(confirmed)), true);
});
test('拒绝旧 token.token、ltoken、字符串类型1与缺身份', () => {
  for (const data of [
    { ...confirmed, tokens: [], token: { token: credential.stoken } },
    { ...confirmed, tokens: [{ token_type: 2, token: 'FAKE_LTOKEN' }] },
    { ...confirmed, tokens: [{ token_type: '1', token: credential.stoken }] },
    { ...confirmed, user_info: {} },
    { ...confirmed, tokens: [{ token_type: 1, token: 'ltoken_FAKE' }] },
  ]) assert.throws(() => parseSToken(data), { code: 'INVALID_RESPONSE' });
});
test('App 扫码与轮询真函数走 Created → Scanned → Confirmed', async () => {
  const calls = [], progress = []; let polls = 0, time = 1700000000000;
  const result = await loginByAppQr({ deviceFp: 'FAKE_FP', onQr: qr => assert.equal(qr.dataUrl, 'data:image/png;base64,FAKE'),
    onProgress: e => progress.push(e), pollMs: 1,
    dependencies: { now: () => time, random, sleep: async ms => { time += ms; },
      encodeQr: async () => 'data:image/png;base64,FAKE', fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith('createQRLogin')) return reply({ ticket: 'FAKE_TICKET', url: 'https://example.invalid/qr' });
        return reply([ { status: 'Created' }, { status: 'Scanned' }, confirmed ][polls++]);
      } } });
  assert.deepEqual(result, credential);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].init.body, '{}');
  assert.ok(calls.every(c => c.url.includes('/app/')));
  assert.equal(new Set(calls.map(c => c.init.headers['x-rpc-device_id'])).size, 1);
  assert.ok(calls.every(c => c.init.headers['x-rpc-client_type'] === '3'));
  for (const { init: { headers } } of calls) {
    for (const key of ['x-rpc-app_version', 'x-rpc-sdk_version', 'x-rpc-account_version']) assert.equal(headers[key], '2.119.0');
    assert.equal(headers['x-rpc-app_id'], 'bll8iq97cem8');
    assert.equal(headers['x-rpc-game_biz'], 'bbs_cn');
    assert.equal(headers['user-agent'], 'Mozilla/5.0 miHoYoBBS/2.119.0 Capture/2.2.0');
    assert.equal(headers['x-rpc-device_fp'], 'FAKE_FP');
    assert.match(headers.DS, /^\d+,\d+,[a-f0-9]{32}$/);
  }
  assert.ok(progress.some(e => e.status === 'scanned'));
  assert.ok(!JSON.stringify(progress).includes('FAKE_TICKET'));
  assert.ok(!JSON.stringify(progress).includes('FAKE_ONLY'));
});
test('缺设备指纹在 I/O 前拒绝', async () => {
  await assert.rejects(loginByAppQr({ onQr() {} }), { code: 'INVALID_ARGUMENT' });
});
test('扫码取消、过期、超时与未知状态', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loginByAppQr({ deviceFp: 'FAKE', onQr() {}, signal: controller.signal }), { code: 'ABORTED' });
  for (const [status, code] of [['Expired', 'QR_EXPIRED'], ['Unexpected', 'INVALID_RESPONSE'], ['Created', 'LOGIN_TIMEOUT']]) {
    let time = 0;
    await assert.rejects(loginByAppQr({ deviceFp: 'FAKE', onQr() {}, pollMs: 1, maxWaitMs: 2,
      dependencies: { now: () => time, random, sleep: async ms => { time += ms; }, encodeQr: async () => 'FAKE',
        fetch: async url => reply(url.endsWith('createQRLogin') ? { ticket: 'FAKE', url: 'FAKE' } : { status }) } }), { code });
  }
});
test('角色一次取全与 genAuthKey 请求配置正确', async () => {
  const roles = [{ game_biz: 'hk4e_cn', game_uid: '10000001' }, { game_biz: 'nap_cn', game_uid: '10000002' }];
  const calls = [];
  const dependencies = { now, random, fetch: async (url, init) => {
    calls.push({ url, init }); return reply(url.endsWith('genAuthKey') ? { authkey: 'FAKE_AUTHKEY' } : { list: roles });
  } };
  assert.deepEqual(await getRoles({ credential, dependencies }), roles);
  assert.equal(await generateAuthKey({ credential, gameBiz: 'hk4e_cn', gameUid: '10000001', region: 'cn_gf01', dependencies }), 'FAKE_AUTHKEY');
  assert.equal(calls[0].init.headers['x-rpc-client_type'], '2');
  assert.equal(calls[1].init.headers['x-rpc-client_type'], '5');
  for (const { init: { headers } } of calls) {
    assert.equal(headers['x-rpc-app_version'], '2.119.0');
    assert.match(headers['x-rpc-app_version'], /^\d+\.\d+\.\d+$/);
    assert.equal(headers['x-rpc-app_id'], 'bll8iq97cem8');
    assert.equal(headers['x-rpc-game_biz'], 'bbs_cn');
    assert.equal(headers['user-agent'], 'Mozilla/5.0 miHoYoBBS/2.119.0 Capture/2.2.0');
    assert.ok(headers.Cookie);
    assert.match(headers.DS, /^\d+,[a-zA-Z0-9]+,[a-f0-9]{32}$/);
  }
  assert.deepEqual(JSON.parse(calls[1].init.body), { auth_appid: 'webview_gacha', game_biz: 'hk4e_cn', game_uid: 10000001, region: 'cn_gf01' });
  assert.equal(calls[0].init.headers.Cookie, 'stoken=v2_FAKE_ONLY; mid=FAKE_MID; stuid=10000000; account_id=10000000');
});
test('上游错误不泄漏消息/凭据；Cookie 注入被拒绝', async () => {
  await assert.rejects(getRoles({ credential, dependencies: { fetch: async () => ({ ok: true,
    json: async () => ({ retcode: -100, message: 'SECRET_TOKEN' }) }) } }), error =>
    error.code === 'UPSTREAM_ERROR' && error.retcode === -100 && !JSON.stringify(error).includes('SECRET'));
  await assert.rejects(getRoles({ credential: { ...credential, mid: 'x;evil=y' } }), { code: 'INVALID_ARGUMENT' });
});
test('原神/星铁使用 App，绝区零使用 web + act 路线', async () => {
  for (const adapter of [genshin, starrail]) {
    assert.equal(adapter.loginMethod, 'app');
    assert.equal(adapter.protocol, 'authkey-log');
    assert.ok(Array.isArray(adapter.channels));
    await assert.rejects(adapter.collect({}), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(zzz.loginMethod, 'web');
  assert.equal(zzz.protocol, 'act-aggregate');
  assert.notEqual(zzz.login, loginByAppQr);
  await assert.rejects(zzz.login({}), { code: 'INVALID_ARGUMENT' });
  assert.match(starrail.verification, /未验证/);
});
