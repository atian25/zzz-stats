#!/usr/bin/env node
/**
 * `output/` 下凭据性临时文件的清理。
 *
 * 为什么单独一个文件：这段逻辑要能在**不启动浏览器**的情况下被测。
 * 扫码采集本身需要人扫，CI 跑不了；但「删干净 / 幂等 / 不误删」这三件事
 * 完全可以对着一组假文件验证。放在 collect.mjs 里就测不了（那个文件一 load 就 main()）。
 *
 * 要清的是什么（三个固定文件名，都在 `WORK_DIR/output/` 根下）：
 *   - `login-qr.png`：二维码截图，里面是可以被人扫的登录码
 *   - `sms-code.txt`：短信验证码中转文件，明文
 *   - `qr-refresh`：换图信号
 *
 * 为什么挪到 `output/` 根而不是数据目录里：
 *   账号名要等登录成功、甚至采集完才知道，而二维码在**登录之前**就得落盘。
 *   挂在数据集目录下的话，扫码阶段根本没有确定的路径可写。
 *   这三份东西的生命周期也确实是「登录前」，跟账号数据不是一回事。
 *
 * 为什么用固定文件名而不是带时间戳的唯一名：
 *   唯一名是为了躲「覆盖同名文件时缓存继续显示旧图」那个坑。现在改由图片服务的 URL
 *   带 `?t=<毫秒>` 破缓存（见 collect.mjs 的 startImageServer），盘上就可以只留固定名。
 *   少一个变量：清理时不需要「按前缀扫一堆历史截图」。
 *
 * 清理时机（三处，幂等）：
 *   1. 登录成功那一刻（collect.mjs 的 loginFlow 里）—— 不让废弃的登录码在盘上多躺
 *      后面还要跑 6 个频道的采集，那几十秒没有任何理由留着它
 *   2. main 的 finally —— 兜底：登录失败、采集中途抛错
 *   3. SIGINT / SIGTERM / SIGHUP —— async main 的 finally 在 SIGINT 下**不会执行**（实测），
 *      用户等不及直接掐掉是最常见的操作，必须显式处理
 *
 * `--keep-verify` 可以保留（排障时看「二维码到底存成什么样」）。
 *
 * **这个模块永不删目录。** `output/` 里同时装着账号目录，删目录就是误删用户数据；
 * 而这三个固定文件删完也不需要「空目录清理」——目录 `output/` 本来就该在。
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 凭据性临时文件名（固定三个，不多不少）。
 *
 * 写成导出常量是为了让测试与文档都引用同一份事实——
 * 早先按前缀匹配历史二维码，是因为文件名带时间戳序号；现在固定名，就该是精确列表。
 */
export const CREDENTIAL_FILES = ['login-qr.png', 'sms-code.txt', 'qr-refresh'];

/**
 * 清理 `output/` 下的凭据性临时文件。
 *
 * 幂等：重复调用、目录不存在、某个文件正被占用，都不会抛错。
 * 单次调用只删它当时看得到的文件——调用方靠「再调一次」兜底，而不是靠一次删全。
 *
 * @param {object} opts
 * @param {string} opts.dir       `output/` 的绝对路径
 * @param {boolean} [opts.keep]   true 则什么都不做（`--keep-verify`）
 * @returns {{removed: string[], failed: Array<{name: string, error: string}>, skipped: boolean}}
 */
export function purgeVerifyArtifacts({ dir, keep = false }) {
  const result = { removed: [], failed: [], skipped: false };
  if (keep) {
    result.skipped = true;
    return result;
  }
  if (!existsSync(dir)) return result;

  for (const name of CREDENTIAL_FILES) {
    const file = join(dir, name);
    // 只删普通文件：同名目录（用户自己造的）不动，删不掉也只是记一笔
    try {
      if (!existsSync(file)) continue;
      rmSync(file, { recursive: false, force: true });
      result.removed.push(name);
    } catch (e) {
      // 删不掉不是致命错误：finally / 信号处理还会再来一次，而且它不该让采集失败
      result.failed.push({ name, error: e.message });
    }
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
    log(`⚠️  --keep-verify 已开启，${prefix}保留 output/ 下的二维码与验证码文件（排障用，用完请手动删除）`);
    return r;
  }
  if (r.removed.length) {
    log(`${prefix}已清理二维码等临时文件（${r.removed.length} 个）`);
  }
  if (r.failed.length) {
    log(`⚠️  ${prefix}有 ${r.failed.length} 个临时文件没删掉，收尾会再试一次`);
  }
  return r;
}
