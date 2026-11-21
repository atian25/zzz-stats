#!/usr/bin/env node
/**
 * `_verify/` 临时凭据文件的清理。
 *
 * 为什么单独一个文件：这段逻辑要能在**不启动浏览器**的情况下被测。
 * 扫码采集本身需要人扫，CI 跑不了；但「删干净 / 幂等 / 空目录移除」这三件事
 * 完全可以对着一组假文件验证。放在 collect.mjs 里就测不了（那个文件一 load 就 main()）。
 *
 * 为什么要清：`_verify/` 里全是**凭据性临时文件**——
 *   - `login-qr-<时间戳>-<序号>.png`：二维码截图，里面是可以被人扫的登录码
 *   - `login-qr.png`：最新一张的副本，给人和脚本方便引用的
 *   - `sms-code.txt`：短信验证码中转文件
 *   - `qr-refresh`：换图信号
 * 登录一旦成功，二维码立刻作废，但它**还能被扫**——扫了会提示失效，
 * 可如果用户之后把整个 data/ 打包发出去、或者误提交、或者部署时带上，那张图就是泄漏面。
 * 所以成功即删，失败也删。
 *
 * 清理时机（两处，幂等）：
 *   1. 登录成功那一刻（collect.mjs 的 loginFlow 里）—— 不让废弃的登录码在盘上多躺
 *      后面还要跑 6 个频道的采集，那几十秒没有任何理由留着它
 *   2. main 的 finally —— 兜底：登录失败、采集中途抛错、用户 Ctrl-C 都要清
 *
 * `--keep-verify` 可以保留（排障时看「二维码到底存成什么样」）。
 */
import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 需要清理的文件名判定。
 *
 * 用前缀/全名匹配而不是硬编码单个文件：二维码每换一张就是一个新名字
 * （`login-qr-<时间戳>-<序号>.png`），只删最新那张会留一地历史登录码。
 */
const isVerifyArtifact = (name) =>
  name === 'login-qr.png' ||
  name === 'sms-code.txt' ||
  name === 'qr-refresh' ||
  /^login-qr-.*\.png$/i.test(name);

/**
 * 清理 `_verify/` 下的临时凭据文件，目录空了就把它本身也删掉。
 *
 * 幂等：重复调用、目录不存在、某个文件正被占用，都不会抛错。
 * 单次调用只删它当时看得到的文件——调用方靠「再调一次」兜底，而不是靠一次删全。
 *
 * @param {object} opts
 * @param {string} opts.dir       `_verify` 目录绝对路径
 * @param {boolean} [opts.keep]   true 则什么都不做（`--keep-verify`）
 * @returns {{removed: string[], failed: Array<{name: string, error: string}>, dirRemoved: boolean, skipped: boolean}}
 */
export function purgeVerifyArtifacts({ dir, keep = false }) {
  const result = { removed: [], failed: [], dirRemoved: false, skipped: false };
  if (keep) {
    result.skipped = true;
    return result;
  }
  if (!existsSync(dir)) return result;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    result.failed.push({ name: dir, error: e.message });
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !isVerifyArtifact(entry.name)) continue;
    try {
      rmSync(join(dir, entry.name), { force: true });
      result.removed.push(entry.name);
    } catch (e) {
      // 删不掉不是致命错误：finally 还会再来一次，而且它不该让采集失败
      result.failed.push({ name: entry.name, error: e.message });
    }
  }

  /*
   * 空目录一并删掉。
   * 判空要在**删完之后**重新读——不重读的话，刚删完的文件还留在 entries 里，
   * 目录永远不会被判成空。
   */
  try {
    const left = readdirSync(dir);
    if (left.length === 0) {
      rmdirSync(dir);
      result.dirRemoved = true;
    }
  } catch {
    // 目录已经没了，或者正被别人用；都不算错
  }
  return result;
}

/**
 * 清理并打印一行结果，给采集脚本用。
 *
 * 只有真的删了东西才 log：幂等兜底那次通常是 0，每次都打一行反而噪音。
 * 但 `--keep-verify` 要明确说一句「没清」，否则用户以为清了。
 *
 * @param {object} opts
 * @param {string} opts.dir
 * @param {boolean} [opts.keep]
 * @param {(msg: string) => void} opts.log
 * @param {string} [opts.when]  时机描述，拼进日志里（如「登录成功」）
 */
export function purgeAndLog({ dir, keep = false, log, when = '' }) {
  const r = purgeVerifyArtifacts({ dir, keep });
  const prefix = when ? `${when}：` : '';
  if (r.skipped) {
    log(`⚠️  --keep-verify 已开启，${prefix}保留 _verify/ 下的二维码与验证码文件（排障用，用完请手动删除）`);
    return r;
  }
  if (r.removed.length) {
    log(`${prefix}已清理二维码等临时文件（${r.removed.length} 个）${r.dirRemoved ? '，_verify/ 空目录已移除' : ''}`);
  }
  if (r.failed.length) {
    log(`⚠️  ${prefix}有 ${r.failed.length} 个临时文件没删掉，收尾会再试一次`);
  }
  return r;
}
