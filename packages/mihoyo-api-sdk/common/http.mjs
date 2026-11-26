import { SdkError, assert, abortable, checkAbort } from './errors.mjs';

export async function requestJson(url, init, { fetch: fetchImpl = globalThis.fetch, signal } = {}) {
  assert(typeof fetchImpl === 'function', 'fetch 必须是函数');
  checkAbort(signal);
  try {
    const response = await abortable(() => fetchImpl(url, { ...init, signal }), signal);
    if (!response.ok) throw new SdkError('HTTP_ERROR', '上游 HTTP 请求失败');
    let json;
    try { json = await abortable(() => response.json(), signal); }
    catch (error) {
      if (error instanceof SdkError) throw error;
      throw new SdkError('INVALID_RESPONSE', '上游响应不是 JSON');
    }
    if (!json || !Number.isInteger(json.retcode)) throw new SdkError('INVALID_RESPONSE', '上游响应缺少 retcode');
    if (json.retcode !== 0) throw new SdkError('UPSTREAM_ERROR', '上游业务请求失败', { retcode: json.retcode });
    return json.data;
  } catch (error) {
    checkAbort(signal);
    if (error instanceof SdkError) throw error;
    throw new SdkError('NETWORK_ERROR', '网络请求失败');
  }
}

export async function notify(callback, data, signal) {
  if (!callback) return;
  assert(typeof callback === 'function', '回调必须是函数');
  try { return await abortable(() => callback(data), signal); }
  catch (error) {
    checkAbort(signal);
    throw new SdkError('CALLBACK_FAILED', '调用方回调失败');
  }
}
