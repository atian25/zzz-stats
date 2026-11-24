/**
 * 二维码编码 —— 把登录接口返回的二维码内容（一个 URL 字符串）编成 PNG。
 *
 * ## 为什么要自己编
 *
 * 纯 Node 那条路不经过浏览器，拿不到 DOM 里那张 `<img src="data:image/png">`，
 * 只有一个字符串。扫码需要图，所以得在本机编。
 *
 * ## 为什么从 dsh 的 node_modules 借 `qrcode`
 *
 * 这个 skill **不许加 npm 依赖**（仓库根连 package.json 都没有，删了它构建就断）。
 * 而本机跑着的 dsh 自带 `qrcode`。用 `createRequire` 去几个已知位置找，
 * 找到就用、找不到就明确报错——不静默退化成「没有二维码」。
 *
 * `toDataURL(url, { width: 320, margin: 1 })` 是实测参数：320px 够手机扫，
 * margin 1 让边缘留一格白（margin 0 在部分扫码器上贴边识别率下降）。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/*
 * 候选位置。顺序有意义：先找 dsh 自己的 node_modules（本机一定有），
 * 再找用户 profile 下的，最后才是标准 node_modules 解析（万一有人全局装了）。
 *
 * **不要改成「先试 require('qrcode') 再说」**：那个调用在没装时抛的错是
 * `Cannot find module 'qrcode'`，看不出「该去哪装」，而这条路本来就是给
 * 「没有网络、不能 npm install」的场景准备的。
 */
const CANDIDATE_ROOTS = [
  '/Users/tz/.dsh/profiles/desktop/node_modules',
  join(process.env.HOME ?? '', '.dsh/profiles/desktop/node_modules'),
  join(process.env.HOME ?? '', 'node_modules'),
];

let cached = null;

/**
 * 找到一个可用的 `qrcode` 模块。
 * @returns {{toDataURL: (text: string, opts?: object) => Promise<string>}}
 */
export function loadQrcode() {
  if (cached) return cached;
  const tried = [];
  for (const root of CANDIDATE_ROOTS) {
    if (!root || !existsSync(root)) continue;
    tried.push(root);
    try {
      const req = createRequire(join(root, 'noop.js'));
      const mod = req('qrcode');
      if (typeof mod?.toDataURL === 'function') { cached = mod; return cached; }
    } catch { /* 该位置没有，试下一个 */ }
  }
  throw new Error(
    '找不到 qrcode 模块（自带二维码编码用）。\n' +
    `已试：${tried.join('、') || '（无可用目录）'}\n` +
    '→ 纯 Node 登录需要它；也可以用 --transport browser 走浏览器那条路（浏览器自己画二维码）。',
  );
}

/**
 * 二维码内容 → PNG 的 data URL。
 * @param {string} text  二维码实际内容（登录接口返回的 `data.url`）
 * @returns {Promise<string>} `data:image/png;base64,...`
 */
export async function encodeQrDataUrl(text) {
  if (typeof text !== 'string' || !text) throw new Error('二维码内容为空');
  const qrcode = loadQrcode();
  return qrcode.toDataURL(text, { width: 320, margin: 1 });
}

/**
 * data URL → 原始 PNG 字节。落盘要字节，不要 data URL 前缀。
 * @param {string} dataUrl
 * @returns {Buffer}
 */
export function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('不是合法的 data URL');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}
