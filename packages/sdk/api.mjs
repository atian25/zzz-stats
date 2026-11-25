import { SdkError, abortable, throwIfAborted } from './errors.mjs';

const REGIONS = new Set(['prod_gf_cn', 'prod_gf_jp', 'prod_gf_us', 'prod_gf_eu', 'prod_gf_sg']);
const DEFAULT_CHANNELS = [
  ['2', 'GACHA_TYPE_CHARACTER_UP', '独家频段'],
  ['102', 'GACHA_TYPE_CHARACTER_RETURN', '独家重映'],
  ['3', 'GACHA_TYPE_WEAPON_UP', '音擎频段'],
  ['103', 'GACHA_TYPE_WEAPON_RETURN', '音擎回响'],
  ['1', 'GACHA_TYPE_PERMANENT', '常驻频段'],
  ['5', 'GACHA_TYPE_BANGBOO', '邦布频段'],
].map(([id, enumName, label]) => Object.freeze({ id, enum: enumName, label }));
const sessions = new WeakMap();
const invalid = message => { throw new SdkError('INVALID_ARGUMENT', message); };
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} 必须是对象`);
  return value;
};
const keys = (value, allowed, label) => {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${label} 不支持参数 ${key}`);
};
const COMMON = ['region', 'signal', 'onProgress', 'log', 'dependencies'];
const LOGIN = ['channel', 'login', 'browser', 'endpoints'];

function common(options, stage = 'collect') {
  const deps = options.dependencies ?? {};
  keys(deps, ['fetch', 'sleep', 'now', 'encodeQr'], 'dependencies');
  for (const [key, value] of Object.entries(deps)) if (typeof value !== 'function') invalid(`dependencies.${key} 必须是函数`);
  for (const key of ['onProgress', 'log']) if (options[key] !== undefined && typeof options[key] !== 'function') invalid(`${key} 必须是函数`);
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal 必须是 AbortSignal');
  throwIfAborted(signal);
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  return {
    log: options.log ?? (() => {}),
    now: deps.now ?? Date.now,
    signal,
    progress: (status, data = {}) => callback(options.onProgress, { stage, status, ...data }, signal),
    sleep: ms => abortable(() => sleep(ms), signal),
    fetchImpl: async (url, init) => {
      try {
        const response = await abortable(() => (deps.fetch ?? fetch)(url, { ...init, signal }), signal);
        return new Proxy(response, { get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          return (...args) => abortable(() => value.apply(target, args), signal);
        } });
      }
      catch (cause) {
        if (cause instanceof SdkError) throw cause;
        throwIfAborted(signal);
        throw new SdkError('NETWORK_ERROR', '网络请求失败', { stage, cause });
      }
    },
    encodeQr: deps.encodeQr && (text => abortable(() => deps.encodeQr(text), signal)),
  };
}

async function callback(fn, payload, signal) {
  if (!fn) return;
  try { return await abortable(() => fn(payload), signal); }
  catch (cause) {
    if (cause instanceof SdkError && cause.code === 'ABORTED') throw cause;
    throw new SdkError('CALLBACK_FAILED', '调用方回调失败', { stage: 'callback', cause });
  }
}

function channelsOf(channels = DEFAULT_CHANNELS) {
  if (!Array.isArray(channels) || !channels.length) invalid('channels 必须是非空频道数组');
  const ids = new Set(), enums = new Set();
  return channels.map(ch => {
    object(ch, '频道');
    const known = DEFAULT_CHANNELS.find(v => v.id === ch.id && v.enum === ch.enum);
    if (!known || typeof ch.label !== 'string' || !ch.label || ids.has(ch.id) || enums.has(ch.enum)) invalid('频道 id/enum 必须受支持且唯一，label 必须非空');
    ids.add(ch.id); enums.add(ch.enum);
    return { id: ch.id, enum: ch.enum, label: ch.label };
  });
}

function loginOptions(options) {
  const channel = options.channel ?? 'node';
  const config = options.login ?? {};
  object(config, 'login');
  const method = config.method ?? 'qr';
  if (!['node', 'browser'].includes(channel)) invalid('channel 只支持 node/browser');
  if (!['qr', 'sms'].includes(method)) invalid('login.method 只支持 qr/sms');
  if (channel === 'node' && method === 'sms') invalid('node 通道不支持 sms');
  if (channel === 'node' && typeof config.onQr !== 'function') invalid('node 通道必须传 login.onQr');
  keys(config, ['method', 'onQr', 'input', 'pollMs', 'maxWaitMs', 'maxRefresh', 'minRefreshGapMs'], 'login');
  if (config.onQr !== undefined && typeof config.onQr !== 'function') invalid('login.onQr 必须是函数');
  for (const key of ['pollMs', 'maxWaitMs', 'minRefreshGapMs']) {
    if (config[key] !== undefined && (!Number.isFinite(config[key]) || config[key] <= 0)) invalid(`login.${key} 必须是正数`);
  }
  if (config.maxRefresh !== undefined && (!Number.isInteger(config.maxRefresh) || config.maxRefresh < 0)) invalid('login.maxRefresh 必须是非负整数');
  const input = config.input ?? {};
  keys(input, ['requestPhone', 'requestCode', 'takeRefreshRequest', 'subscribeRefresh', 'requestManualAction'], 'login.input');
  for (const [key, value] of Object.entries(input)) if (typeof value !== 'function') invalid(`login.input.${key} 必须是函数`);
  if (channel === 'node' && (config.maxRefresh !== undefined || config.minRefreshGapMs !== undefined || Object.keys(input).length)) invalid('node 通道当前不支持输入/刷新参数');
  const region = options.region ?? 'prod_gf_cn';
  if (!REGIONS.has(region)) invalid('未知 region');
  if (channel === 'node' && region !== 'prod_gf_cn') throw new SdkError('UNSUPPORTED_REGION', 'node 通道只支持国服', { stage: 'validate' });
  if (method === 'sms' && region !== 'prod_gf_cn') invalid('sms 当前仅支持国服 +86');
  if (channel === 'browser') {
    keys(options.browser ?? {}, ['driver'], 'browser');
    object(options.browser?.driver, 'browser.driver');
  } else if (options.browser !== undefined) invalid('node 通道不接受 browser 参数');
  keys(options.endpoints ?? {}, ['api', 'page'], 'endpoints');
  for (const value of Object.values(options.endpoints ?? {})) {
    try { if (!['http:', 'https:'].includes(new URL(value).protocol)) invalid('endpoint 必须是 HTTP URL'); }
    catch { invalid('endpoint 必须是 HTTP URL'); }
  }
  return { channel, method, region, config, input };
}

function makeSession(fields, drv, owned) {
  let closing;
  const state = { closed: false, drv };
  const session = {
    ...fields,
    async close() {
      if (!closing) {
        state.closed = true;
        if (session.channel === 'node') session.cookieHeader = '';
        closing = Promise.resolve().then(() => owned ? drv?.close?.() : undefined);
      }
      await closing;
    },
  };
  for (const key of ['channel', 'gameUid', 'region']) {
    Object.defineProperty(session, key, { value: fields[key], enumerable: true, writable: false, configurable: false });
  }
  sessions.set(session, state);
  return session;
}

/** 分步登录；方式与执行通道是两个独立参数维度。 */
export async function login(options = {}) {
  keys(options, [...COMMON, ...LOGIN], 'login options');
  const { channel, method, region, config, input } = loginOptions(options);
  const deps = common(options, 'login');
  await callback(options.onProgress, { stage: 'login', status: 'started', message: '申请登录' }, options.signal);
  const onQr = config.onQr && (qr => callback(config.onQr, { dataUrl: qr.dataUrl }, options.signal));
  if (channel === 'node') {
    const { loginByQrNode } = await import('./login-node.mjs');
    const result = await loginByQrNode({ ...deps, onQr, region, pollMs: config.pollMs, maxWaitMs: config.maxWaitMs });
    return makeSession({ channel, accountId: result.uid || null, gameUid: result.gameUid,
      nickname: result.nickname, region, cookieHeader: result.cookieHeader });
  }
  const { loginByQrBrowser } = await import('./login-browser.mjs');
  const host = region === 'prod_gf_cn' ? 'act.mihoyo.com' : 'act.hoyolab.com';
  const result = await loginByQrBrowser({
    ...deps, driver: options.browser.driver, region,
    pageUrl: options.endpoints?.page ?? `https://${host}/zzz/event/gacha-record/index.html`,
    loginMode: method, onQr,
    input: {
      ...input,
      requestPhone: input.requestPhone && (() => callback(input.requestPhone, { signal: options.signal }, options.signal)),
      requestCode: input.requestCode && (() => callback(input.requestCode, { signal: options.signal }, options.signal)),
      requestManualAction: input.requestManualAction && (context => callback(input.requestManualAction, context, options.signal)),
      takeRefreshRequest: input.takeRefreshRequest && (() => callback(input.takeRefreshRequest, undefined, options.signal)),
      subscribeRefresh: input.subscribeRefresh && (() => {
        throwIfAborted(options.signal);
        let unsubscribe;
        try { unsubscribe = input.subscribeRefresh(); } catch (cause) { throw new SdkError('CALLBACK_FAILED', '订阅刷新失败', { stage: 'callback', cause }); }
        if (typeof unsubscribe !== 'function') invalid('subscribeRefresh 必须同步返回退订函数');
        return () => { try { unsubscribe(); } catch (cause) { throw new SdkError('CALLBACK_FAILED', '退订刷新失败', { stage: 'callback', cause }); } };
      }),
    },
    pollMs: config.pollMs, maxWaitMs: config.maxWaitMs,
    maxRefresh: config.maxRefresh, minGapMs: config.minRefreshGapMs,
  });
  return makeSession({ channel, accountId: null, gameUid: result.uid, nickname: result.nickname, region }, result.drv, result.owned);
}

/** 已有会话取数；不关闭借入 session。 */
export async function collect(options = {}) {
  keys(options, [...COMMON, 'session', 'channels', 'endpoints'], 'collect options');
  const session = object(options.session, 'session');
  if (!['node', 'browser'].includes(session.channel) || typeof session.gameUid !== 'string' || !/^\d+$/.test(session.gameUid) || typeof session.close !== 'function') invalid('session 缺少有效 channel/gameUid/close');
  if (!REGIONS.has(session.region) || (options.region !== undefined && options.region !== session.region)) invalid('region 必须与 session.region 一致');
  // 自建 Node session 不在 WeakMap；调用方负责 close 后清空 Cookie 或拒绝复用。
  const state = sessions.get(session);
  if (state?.closed) invalid('session 已关闭');
  if (session.channel === 'node' && !session.cookieHeader) invalid('node session 需要 cookieHeader');
  if (session.channel === 'node' && session.region !== 'prod_gf_cn') throw new SdkError('UNSUPPORTED_REGION', 'node 通道只支持国服');
  if (session.channel === 'browser' && !state?.drv) invalid('browser session 必须由 login 返回');
  const channels = channelsOf(options.channels);
  keys(options.endpoints ?? {}, ['api'], 'endpoints');
  const deps = common(options);
  const { ACT_API } = await import('./transport-node.mjs');
  const api = options.endpoints?.api ?? (session.region === 'prod_gf_cn' ? ACT_API.cn : ACT_API.os);
  try { if (!['http:', 'https:'].includes(new URL(api).protocol)) invalid('api 必须是 HTTP URL'); }
  catch { invalid('api 必须是 HTTP URL'); }
  await callback(options.onProgress, { stage: 'collect', status: 'started', message: '开始取数' }, options.signal);
  const args = { ...deps, uid: session.gameUid, nickname: session.nickname,
    region: session.region, channels, api, fetchedAt: new Date(deps.now()).toISOString() };
  let result;
  if (session.channel === 'node') {
    const { collectViaNode } = await import('./login-node.mjs');
    result = await collectViaNode({ ...args, cookieHeader: session.cookieHeader });
  } else {
    const { collectViaBrowser } = await import('./login-browser.mjs');
    result = await collectViaBrowser({ ...args, drv: state.drv });
  }
  throwIfAborted(options.signal);
  await deps.progress('completed');
  const files = new Map(result.files);
  files.delete('meta.json');
  return { gameUid: session.gameUid, nickname: session.nickname ?? null, region: session.region,
    files, summary: result.summary, meta: result.meta };
}

/** 完整流程；不接 cfg 或已有 session。 */
export async function collectData(options = {}) {
  keys(options, [...COMMON, ...LOGIN, 'channels'], 'collectData options');
  loginOptions(options);
  channelsOf(options.channels);
  const { channels, endpoints, ...loginArgs } = options;
  const session = await login({ ...loginArgs, endpoints });
  try {
    const result = await collect({ session, channels, endpoints: endpoints?.api ? { api: endpoints.api } : undefined,
      region: options.region, signal: options.signal, dependencies: options.dependencies,
      onProgress: options.onProgress, log: options.log });
    await callback(options.onProgress, { stage: 'done', status: 'completed', message: '采集完成' }, options.signal);
    return result;
  } finally { await session.close(); }
}
