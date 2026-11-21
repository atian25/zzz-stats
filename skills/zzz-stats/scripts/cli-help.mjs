#!/usr/bin/env node
/**
 * `--help` / `-h` 的共用实现。
 *
 * 为什么单独一个文件：四个脚本的用法文本如果各写一份，改参数时必然漏掉某一处，
 * 而且会出现「`--help` 说支持、实际不支持」这种更坏的情况。集中一处，一份事实。
 *
 * 为什么必须支持：`collect.mjs` 曾经在收到 `--help` 时**直接进入采集流程**（要扫码登录），
 * 因为它的参数解析只认白名单里的键，认不出的就当没传。误触一次就是一次意外登录。
 *
 * 用法（在每个脚本解析参数之前调用）：
 *   import { wantsHelp, printHelp, signalHandlers } from './cli-help.mjs';
 *   if (wantsHelp()) printHelp('collect', { usage, options });
 *
 * 约束：这个函数只打印并 `process.exit(0)`，**不启动浏览器、不写文件、不读数据集**。
 */

/** 是否是 `--help` / `-h`（含 `--help=true` 这类等号写法）。 */
export function wantsHelp(argv = process.argv.slice(2)) {
  return argv.some((a) => a === '--help' || a === '-h' || a === '--h' || /^--help=/.test(a));
}

/**
 * 打印用法并退出 0。
 *
 * @param {string} name      脚本名，不带 .mjs（用于拼示例命令）
 * @param {object} spec
 * @param {string} spec.summary  一句话说明这个脚本干什么
 * @param {Array<{flag: string, desc: string}>} spec.options
 * @param {string[]} [spec.notes]  末尾补充说明
 */
export function printHelp(name, { summary, options = [], notes = [] }) {
  const cmd = `node skills/zzz-stats/scripts/${name}.mjs`;
  const lines = [];
  lines.push(`${name} — ${summary}`);
  lines.push('');
  lines.push('用法：');
  lines.push(`  ${cmd} [选项]`);
  if (options.length) {
    lines.push('');
    lines.push('选项：');
    const width = Math.max(...options.map((o) => o.flag.length));
    for (const o of options) lines.push(`  ${o.flag.padEnd(width + 2)}${o.desc}`);
  }
  if (notes.length) {
    lines.push('');
    for (const n of notes) lines.push(n);
  }
  lines.push('');
  lines.push('参数两种写法都支持：--flag value 与 --flag=value。');
  console.log(lines.join('\n'));
  process.exit(0);
}

/**
 * 共用的末尾提示：数据落点与 skill 目录是分开的。
 * 每个脚本的 note 里都会重复这一条，因为它是最容易被误解的一处。
 */
export const WORK_DIR_NOTE =
  '数据落点是「用户工作目录」：--cwd 优先，否则当前目录。skill 目录只读，不会写进去。';
