/** CLI 刷新文件适配；纯等待逻辑仍由 SDK 提供。 */
import { rmSync, statSync } from 'node:fs';
// 终端键位、信号文件和提示归 CLI；SDK 只保留等待机制。
export const REFRESH_SIGNAL_FILE = 'qr-refresh';
export function isRefreshKey(buf) { return buf != null && buf.toString().toLowerCase() === 'r'; }
export function createRefreshInput() {
  let pressed = false;
  return {
    press(buf) { if (!isRefreshKey(buf)) return false; pressed = true; return true; },
    take() { const value = pressed; pressed = false; return value; },
  };
}
export function refreshChannelHint({ signalFile, stdinRaw }) {
  return stdinRaw
    ? `（换一张二维码：在运行脚本的终端里按 r，或由 agent 写入 ${signalFile} —— 两条通道都有效、互不影响）`
    : `（换一张二维码：由 agent 写入 ${signalFile} —— 本进程没有终端，按 r 这条通道在这里用不了）`;
}
export function expiredRefreshHint({ signalFile, stdinRaw }) {
  return stdinRaw
    ? `    需要换一张才能继续：终端里按 r，或由 agent 写入 ${signalFile}（两条通道都有效、互不影响）。`
    : `    需要换一张才能继续：由 agent 写入 ${signalFile}（本进程没有终端，按 r 用不了）。`;
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
 * 文件不存在、同名的是个目录（用户自己造的）、删不掉，都不会抛错。
 * 成功删除后不会重复消费；删除失败仍算请求，下轮可能再次命中，刷新限流仍生效。
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

