// 不保留请求 URL、Cookie、响应体或底层 cause，避免凭据进入可序列化错误。
export class SdkError extends Error {
  constructor(code, message, { stage, retcode } = {}) {
    super(message);
    this.name = 'SdkError';
    this.code = code;
    if (stage) this.stage = stage;
    if (Number.isInteger(retcode)) this.retcode = retcode;
  }
}
export function assert(condition, message) {
  if (!condition) throw new SdkError('INVALID_ARGUMENT', message);
}
export function checkAbort(signal) {
  if (signal?.aborted) throw new SdkError('ABORTED', '操作已取消');
}
export async function abortable(fn, signal) {
  checkAbort(signal);
  if (!signal) return fn();
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(new SdkError('ABORTED', '操作已取消'));
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) listener();
  });
  try { return await Promise.race([Promise.resolve().then(fn), aborted]); }
  finally { signal.removeEventListener('abort', listener); }
}
