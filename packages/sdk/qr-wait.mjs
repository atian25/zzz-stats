/** 二维码计时、人工刷新限流和登录等待；不含文件或终端策略。 */
import { abortable, throwIfAborted, SdkError } from './errors.mjs';

/**
 * 二维码的计时器：**换到新码必须重置起点**。
 *
 * 这里踩过一个只在这种路径下才显形的 bug：刷新拿到新码，但过期判断还拿旧 `issuedAt`
 * 在算，于是新码一生成就被判「已过期」，用户永远扫不到有效码。
 * 把它抽成对象是为了能对着假时钟测：`reissue()` 之后 `ageMs()` 必须归零、
 * 过期警告必须能**再次**触发。
 *
 * @param {object} opts
 * @param {number} opts.ttlMs  有效期（官方二维码约 2 分钟）
 * @param {() => number} [opts.now] 注入时钟（测试用）
 */
export function createQrClock({ ttlMs, now = () => Date.now() }) {
  let issuedAt = now();
  let warned = false;

  const ageMs = () => now() - issuedAt;

  return {
    /** 当前这张码的截取时刻 */
    get issuedAt() { return issuedAt; },
    /** 已经过了多久 */
    ageMs,
    /** 还剩多久有效（下限 0） */
    remainingMs: () => Math.max(0, ttlMs - ageMs()),
    /** 是否已过期 */
    expired: () => ageMs() >= ttlMs,
    /**
     * 过期提示只报一次：每轮都刷一行「已过期」会把日志淹掉，
     * 心跳那一行本来就在说同一件事。换码（reissue）后可再次触发。
     */
    takeExpiryWarning: () => {
      if (warned || ageMs() < ttlMs) return false;
      warned = true;
      return true;
    },
    /** 换到新码：重置起点与「已提示过期」标志 */
    reissue: () => {
      issuedAt = now();
      warned = false;
      return issuedAt;
    },
  };
}

export async function waitForLogin({
  isLoggedIn, refreshQr, grabQr, emitQr, clock,
  takeRefreshRequest = () => ({ refresh: false }),
  maxRefresh = 3, minGapMs = 5000, maxWaitMs = 600000, pollMs = 3000,
  now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)),
  signal, progress = async () => {},
}) {
  let refreshCount = 0;
  let lastRefreshAt = null;
  const deadline = now() + maxWaitMs;
  while (now() < deadline) {
    throwIfAborted(signal);
    if (await abortable(isLoggedIn, signal) === 'logged-in') return { ok: true, refreshes: refreshCount, refreshCount };
    const req = await abortable(takeRefreshRequest, signal);
    if (!req || typeof req.refresh !== 'boolean') throw new SdkError('INVALID_RESPONSE', '刷新回调需要返回 refresh 布尔值', { stage: 'callback' });
    if (clock.takeExpiryWarning()) await progress('expired');
    if (req.refresh) {
      if (refreshCount >= maxRefresh || lastRefreshAt !== null && now() - lastRefreshAt < minGapMs) {
        await progress('refresh-denied');
      } else {
        lastRefreshAt = now();
        refreshCount += 1;
        const hit = await abortable(refreshQr, signal);
        const qr = await abortable(grabQr, signal);
        if (qr?.src && hit !== 'no-expired-node') {
          clock.reissue();
          await abortable(() => emitQr(qr), signal);
        } else await progress('refresh-denied');
      }
    }
    await abortable(() => sleep(pollMs), signal);
  }
  return { ok: false, refreshes: refreshCount, refreshCount };
}
