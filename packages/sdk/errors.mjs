/** 公共错误形状。cause 仅供本地诊断，不应序列化到页面或日志。 */
export class SdkError extends Error {
  constructor(code, message, { stage = 'validate', retcode, httpStatus, endpoint, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SdkError';
    this.code = code;
    this.stage = stage;
    if (retcode !== undefined) this.retcode = retcode;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (endpoint !== undefined) this.endpoint = endpoint;
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new SdkError('ABORTED', '操作已取消', { cause: signal.reason });
}

/** 可结束对未配合取消的外部 Promise 的等待，但不能撤销它的副作用。 */
export function abortable(operation, signal) {
  throwIfAborted(signal);
  if (!signal) return Promise.resolve().then(operation);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new SdkError('ABORTED', '操作已取消', { cause: signal.reason }));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { throwIfAborted(signal); return operation(); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** 不关闭借入驱动；取消仅终止等待，不能撤销已发送的浏览器操作。 */
export function guardDriver(driver, signal, stage = 'driver') {
  return new Proxy(driver, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function' || key === 'close') return typeof value === 'function' ? value.bind(target) : value;
      return (...args) => abortable(() => value.apply(target, args), signal).catch(cause => {
        if (cause instanceof SdkError) throw cause;
        throw new SdkError('BROWSER_UNAVAILABLE', '浏览器操作失败', { stage, cause });
      });
    },
  });
}
