#!/usr/bin/env node
/**
 * 扫码等待期的两件事：**刷新信号从哪来**、**二维码什么时候过期**。
 *
 * 为什么单独成文件：这两段都要能在**不启动浏览器、不用真扫码**的情况下被测。
 * 扫码采集本身需要人扫，CI 跑不了；但「TTY 与非 TTY 都能被信号文件触发刷新」
 * 「按键只认 r」「刷新后计时起点归零」这些完全可以对着临时文件与假时钟验证。
 * 留在 collect.mjs 里就测不了（那个文件一 load 就 main()）。
 *
 * ## 这里修过的一个真 bug（别再退回去）
 *
 * 早先 collect.mjs 里是这么写的：
 *
 *   if (stdin.isTTY) { stdin.on('data', onKey) }        // 只有 TTY 听按键
 *   if (!stdinRaw && existsSync(REFRESH_SIGNAL)) {...}  // **只有非 TTY 查信号文件**
 *
 * 两条通道被写成了**二选一**，而 agent 代跑时的典型场景正好落在两条通道的缝隙里：
 * 进程挂在终端里（有 TTY），但 agent 没法往那个 TTY 发按键，只能写文件 ——
 * 写下去没有任何人读，日志还在打「仍在等待…」，白等几十秒。
 *
 * 现在两条通道**并行生效、互相独立**，任一命中就刷新：
 *   - 终端里按 r（本地手动跑）
 *   - agent 写 `output/qr-refresh`（代跑时唯一可行的那条）
 * TTY 与否只影响**提示文案**怎么写，不影响判断逻辑。判断逻辑里没有 stdinRaw 这个输入，
 * 这是故意的：它一旦重新参与判断，就又会变回二选一。
 */
import { rmSync, statSync } from 'node:fs';

/**
 * 换图信号文件名（固定名，落在 `output/` 根下）。
 * 与 `verify-cleanup.mjs` 的 `CREDENTIAL_FILES` 共用同一份事实——它也是登录成功时要删的文件之一。
 */
export const REFRESH_SIGNAL_FILE = 'qr-refresh';

/**
 * 这次 stdin 读到的是不是「换一张」按键。
 *
 * **只认单个 r / R。** TTY 下开了 `setRawMode(true)`，终端不再做行编辑，
 * 方向键、Ctrl-C 之外的每个按键都会原样送到 `data` 事件里 ——
 * 所以这里必须是严格相等，不能写成「包含 r」：否则 `\x1b[A`（上方向键）、
 * 粘贴进来的一段文字都会被当成刷新，用户随便敲个键就把二维码换掉了。
 * 多字节的粘贴（例如 `rr`、`r `）同样忽略，宁可让用户重按一次。
 *
 * @param {Buffer|string|null|undefined} buf
 * @returns {boolean}
 */
export function isRefreshKey(buf) {
  if (buf === null || buf === undefined) return false;
  return buf.toString().toLowerCase() === 'r';
}

/**
 * 检查一次刷新请求，并**顺手消费**信号文件。
 *
 * 两条通道同时看，不是 if/else：
 *   - `keyPressed`：stdin 的 `data` 事件置位的标志
 *   - 信号文件：存在（且是普通文件）就删掉并算一次请求
 *
 * 为什么要删：不删的话下一轮循环（3 秒后）还会命中同一个文件，
 * 一次请求变成连续两次重取 —— 直接吃掉 5 秒的最短间隔、加速撞 3 次上限。
 *
 * 幂等：文件不存在、同名的是个目录（用户自己造的）、删不掉，都不会抛错。
 * 同名目录当成**没有信号**处理：它删不掉，如果还算一次请求，就会每 3 秒重试一次刷新，
 * 把刷新次数白白刷到上限。
 *
 * @param {object} opts
 * @param {boolean} [opts.keyPressed] 终端里是不是按过 r
 * @param {string} [opts.signalFile]  `output/qr-refresh` 的绝对路径
 * @returns {{refresh: boolean, via: 'key'|'signal'|'key+signal'|null, removed: boolean}}
 */
export function takeRefreshRequest({ keyPressed = false, signalFile } = {}) {
  const result = { refresh: false, via: null, removed: false };

  if (keyPressed) {
    result.refresh = true;
    result.via = 'key';
  }

  if (signalFile) {
    let isFile = false;
    try {
      isFile = statSync(signalFile).isFile();
    } catch {
      // 不存在（最常见）：安静返回，不当成请求
      isFile = false;
    }
    if (isFile) {
      try {
        rmSync(signalFile, { force: true });
        result.removed = true;
      } catch {
        // 删不掉也还是把这次请求算上：不刷新才是用户真正会抱怨的那个结果
        result.removed = false;
      }
      result.refresh = true;
      result.via = result.via === 'key' ? 'key+signal' : 'signal';
    }
  }

  return result;
}

/**
 * 开始等待时的提示：告诉用户「怎么换一张」。
 *
 * 两条通道**都要提**。早先 TTY 只说「按 r」、非 TTY 只说信号文件，
 * 而 agent 恰恰读的是这段文字——它照着「按 r」去操作，然后完全没有反应。
 * TTY 时「按 r 不可用」这句话不成立，所以两个分支都写明另一条通道。
 */
export function refreshChannelHint({ signalFile, stdinRaw }) {
  if (stdinRaw) {
    return `（换一张二维码：在运行脚本的终端里按 r，或由 agent 写入 ${signalFile} —— 两条通道都有效、互不影响）`;
  }
  return `（换一张二维码：由 agent 写入 ${signalFile} —— 本进程没有终端，按 r 这条通道在这里用不了）`;
}

/** 二维码过期时的提示，与上面同理：别只给一条路。 */
export function expiredRefreshHint({ signalFile, stdinRaw }) {
  if (stdinRaw) {
    return `    需要换一张才能继续：终端里按 r，或由 agent 写入 ${signalFile}（两条通道都有效、互不影响）。`;
  }
  return `    需要换一张才能继续：由 agent 写入 ${signalFile}（本进程没有终端，按 r 用不了）。`;
}

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

/**
 * 「按键通道」的输入缓冲。
 *
 * 抽出来是为了让等待循环能在**不接 stdin** 的情况下被测：用例直接 `press('r')`。
 * TTY 接线仍在 collect.mjs 里（`stdin.on('data', (b) => input.press(b))`）——
 * 这里只管「有没有人按过刷新键」。
 */
export function createRefreshInput() {
  let pressed = false;
  return {
    /** 收到一段 stdin 数据；只认单个 r/R，其他按键返回 false 且不留痕迹 */
    press(buf) {
      if (!isRefreshKey(buf)) return false;
      pressed = true;
      return true;
    },
    /** 取走「按过刷新键」这个事实（取完清零） */
    take() {
      const v = pressed;
      pressed = false;
      return v;
    },
  };
}

/**
 * 扫码等待循环本体。
 *
 * 从 collect.mjs 抽出来的原因很直接：这个循环里踩过两次**只有真跑才显形**的 bug ——
 *   1) 两条刷新通道被写成二选一（有 TTY 就不查信号文件）
 *   2) 改循环时漏了 `let wantRefresh`，ESM 严格模式下赋值未声明变量，直接 ReferenceError
 * 而 `node --check` 对第 2 类毫无反应（语法是合法的）。所以这段必须能被**真实执行**地测。
 *
 * 所有外部依赖都从参数注入（时钟、sleep、DOM 操作、日志），用例因此不需要浏览器、
 * 不需要真 TTY、不需要等 2 分钟。
 *
 * @returns {Promise<{ok: boolean, refreshes: number, refreshCount: number}>}
 */
export async function waitForLogin({
  isLoggedIn,          // async () => 'logged-in' | 其他
  probe,               // async () => 心跳用的页面快照描述
  refreshQr,           // async () => 点了过期按钮之后的命中结果
  grabQr,              // async () => 二维码对象或 null
  saveQr,              // (qr) => { png, url }
  input,               // createRefreshInput()
  clock,               // createQrClock()
  log,                 // (msg: string) => void
  signalFile,
  stdinRaw,
  maxRefresh = 3,
  minGapMs = 5000,
  maxWaitMs = 10 * 60 * 1000,
  pollMs = 3000,
  heartbeatEvery = 5,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let ok = false;
  let tick = 0;
  let refreshCount = 0;
  let refreshes = 0;
  let lastRefreshAt = 0;
  const deadline = now() + maxWaitMs;

  while (now() < deadline) {
    if (await isLoggedIn() === 'logged-in') { ok = true; break; }

    /*
     * 两条通道都查，任一命中就刷新 —— 不是 if/else。
     * 信号文件在这里被**消费掉**（删除），否则下一轮会再命中一次，
     * 一次请求变成两次重取，白吃 5 秒最短间隔。
     */
    const req = takeRefreshRequest({ keyPressed: input.take(), signalFile });
    const wantRefresh = req.refresh;

    // 二维码本身的有效期，与整体等待上限无关
    const qrAge = clock.ageMs();
    if (clock.takeExpiryWarning()) {
      log('');
      log('⚠️  二维码已过期（截取于 ' +
        new Date(clock.issuedAt).toLocaleTimeString('zh-CN', { hour12: false }) +
        `，已过 ${Math.round(qrAge / 1000)} 秒）`);
      log(expiredRefreshHint({ signalFile, stdinRaw }));
      log('    （不会自动刷新——避免没人看着时反复请求登录接口）');
      log('');
    }

    // 每 N 轮报一次心跳：让用户看得出脚本还活着、还在等
    tick += 1;
    if (tick % heartbeatEvery === 0) {
      const leftMin = Math.ceil((deadline - now()) / 60000);
      const info = await probe();
      log(clock.expired()
        ? `仍在等待…（二维码已过期，需换一张；最多再等 ${leftMin} 分钟）｜${info}`
        : `仍在等待扫码…（二维码还剩约 ${Math.round(clock.remainingMs() / 1000)} 秒有效）｜${info}`);
    }

    if (wantRefresh) {
      if (refreshCount >= maxRefresh) {
        log(`已重取 ${refreshCount} 次，达到上限，不再自动换图。`);
      } else if (lastRefreshAt && now() - lastRefreshAt < minGapMs) {
        log(`刷新太快了，请等 ${Math.ceil((minGapMs - (now() - lastRefreshAt)) / 1000)} 秒后再试。`);
      } else {
        lastRefreshAt = now();
        refreshCount += 1;
        refreshes += 1;
        const hit = await refreshQr();
        const qr = await grabQr();
        const left = maxRefresh - refreshCount;
        if (qr?.src) {
          const { png: file, url } = saveQr(qr);
          /*
           * 换到新码就必须重置计时起点。
           * 早先漏了这一步：新码已经拿到，但过期判断还拿旧 issuedAt 在算，
           * 于是新码一出来就被标成「已过期」——用户拿到的永远是一张判定过期的图。
           * clock.reissue() 同时清掉「已提示过期」标志，否则新码再过期就不会再提醒。
           */
          clock.reissue();
          log(hit === 'no-expired-node'
            ? `二维码尚未过期，仍是同一张（${file}）。剩余 ${left} 次。`
            : `已换新二维码（${hit}）：${file}。剩余 ${left} 次。`);
          if (url) log(`二维码图片地址：${url}`);
        } else {
          log(`刷新后没读到二维码（${hit}）。剩余 ${left} 次。`);
        }
      }
    }

    await sleep(pollMs);
  }

  return { ok, refreshes, refreshCount };
}
