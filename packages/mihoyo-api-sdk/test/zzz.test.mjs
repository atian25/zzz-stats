import test from 'node:test';
import assert from 'node:assert/strict';
import { zzz } from '../index.mjs';

const response = json => ({ ok: true, json: async () => json });
const ok = data => ({ retcode: 0, data });
const args = { cookie: 'FAKE_COOKIE=ONLY', gameUid: '10000001', channels: ['2'] };
const index = versions => ok({ cur_ver: '2.0', type_stats: [
  { gacha_type: 'GACHA_TYPE_CHARACTER_UP', has_data_vers: versions },
  { gacha_type: 'GACHA_TYPE_WEAPON_UP', has_data_vers: ['9.9'] },
] });

test('index 缺 type_stats 立即报错，不发 cur/hist 请求', async () => {
  let calls = 0;
  await assert.rejects(zzz.collect({ ...args, dependencies: { fetch: async () => {
    calls++; return response(ok({}));
  }, sleep: async () => {} } }), { code: 'INVALID_RESPONSE' });
  assert.equal(calls, 1);
});

test('cur 失败空 list 兜底，保留 index 与官方 cur/hist 形状', async () => {
  const calls = [], waits = [];
  const original = index(['1.0']);
  const pool = { gacha_type: '2', version: '1.0', start_ts: 1, end_ts: 2, cur_records: [{ unknown_field: true }] };
  const result = await zzz.collect({ ...args, dependencies: {
    sleep: async ms => waits.push(ms), fetch: async (url, init) => {
      const u = new URL(url); calls.push(u.pathname.split('/').pop());
      assert.equal(init.headers.Referer, zzz.referer);
      assert.equal(init.headers.Cookie, args.cookie);
      assert.equal(u.searchParams.get('uid'), args.gameUid);
      assert.equal(u.searchParams.get('region'), 'prod_gf_cn');
      if (url.includes('/index?')) return response(original);
      if (url.includes('/cur_pool_stat?')) return response({ retcode: -100, message: 'FAKE_SECRET' });
      return response(ok({ list: [pool] }));
    },
  } });
  assert.deepEqual(calls, ['index', 'cur_pool_stat', 'hist_pool_stat']);
  assert.deepEqual(waits, [350, 350]);
  assert.equal(result.index, original);
  assert.deepEqual(result.cur_pool_stat_2, { retcode: 0, data: { list: [] } });
  assert.deepEqual(result.hist_pool_stat_2.data.list, [pool]);
  assert.equal(result.hist_pool_stat_2.data.cur_ver, '2.0');
  assert.deepEqual(Object.keys(result), ['index', 'cur_pool_stat_2', 'hist_pool_stat_2']);
});

test('hist 降序、每片最多10版本、只取本频道版本、按四元组去重', async () => {
  const chunks = [], waits = [];
  const versions = Array.from({ length: 21 }, (_, i) => `1.${i}`);
  const pool = { gacha_type: '2', version: '1.20', start_ts: 10, end_ts: 20, cur_records: ['FIRST'] };
  const distinct = [
    { ...pool, gacha_type: '3' }, { ...pool, version: '1.19' },
    { ...pool, start_ts: 11 }, { ...pool, end_ts: 21 },
  ];
  const result = await zzz.collect({ ...args, dependencies: {
    sleep: async ms => waits.push(ms), fetch: async url => {
      if (url.includes('/index?')) return response(index(versions));
      if (url.includes('/cur_pool_stat?')) return response(ok({ list: [], extra: 'raw' }));
      const u = new URL(url); chunks.push(u.searchParams.get('vers').split(','));
      return response(ok({ list: chunks.length === 1 ? [pool, ...distinct] : [{ ...pool, cur_records: ['LATER'] }] }));
    },
  } });
  assert.deepEqual(chunks.map(c => c.length), [10, 10, 1]);
  assert.deepEqual(chunks.flat(), [...versions].reverse());
  assert.ok(!chunks.flat().includes('9.9'));
  assert.equal(result.hist_pool_stat_2.data.list.length, 5);
  assert.equal(result.hist_pool_stat_2.data.list[0], pool);
  assert.equal(result.cur_pool_stat_2.data.extra, 'raw');
  assert.deepEqual(waits, [350, 350, 350, 350]);
});

test('取消不能被 cur 容错吞掉', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(zzz.collect({ ...args, signal: controller.signal, dependencies: {
    sleep: async () => {}, fetch: async url => {
      calls++;
      if (url.includes('/index?')) return response(index([]));
      controller.abort(); throw Error('FAKE_COOKIE=ONLY');
    },
  } }), { code: 'ABORTED' });
  assert.equal(calls, 2);
});

test('hist 业务/网络失败必须抛出且不泄漏凭据', async () => {
  for (const network of [false, true]) {
    await assert.rejects(zzz.collect({ ...args, dependencies: {
      sleep: async () => {}, fetch: async url => {
        if (url.includes('/index?')) return response(index(['1.0']));
        if (url.includes('/cur_pool_stat?')) return response(ok({ list: [] }));
        if (network) throw Error('FAKE_COOKIE=ONLY');
        return response({ retcode: -400005, message: 'FAKE_COOKIE=ONLY' });
      },
    } }), error => {
      assert.equal(error.code, network ? 'NETWORK_ERROR' : 'UPSTREAM_ERROR');
      assert.ok(!String(error).includes('FAKE_COOKIE'));
      assert.ok(!JSON.stringify(error).includes('FAKE_COOKIE'));
      return true;
    });
  }
});

test('参数校验发生在 I/O 前；无版本时不请求 hist', async () => {
  let calls = 0;
  const dependencies = { sleep: async () => {}, fetch: async url => {
    calls++; return response(url.includes('/index?') ? index([]) : ok({ list: [] }));
  } };
  await assert.rejects(zzz.collect({ ...args, channels: ['2', '2'], dependencies }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(zzz.collect({ ...args, cookie: 'FAKE\r\nCookie', dependencies }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls, 0);
  const result = await zzz.collect({ ...args, dependencies });
  assert.equal(calls, 2);
  assert.deepEqual(result.hist_pool_stat_2.data.list, []);
});
