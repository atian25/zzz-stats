/**
 * 二维码编码 —— 把登录接口返回的二维码内容（一个 URL 字符串）编成 PNG。
 *
 * ## 为什么要自己编
 *
 * 纯 Node 那条路不经过浏览器，拿不到 DOM 里那张 `<img src="data:image/png">`，
 * 只有一个字符串。扫码需要图，所以得在本机编。
 *
 * ## 为什么要自己带一份
 *
 * 这个 skill **不许加 npm 依赖**（仓库根没有 package.json，用户复制目录就能用，
 * 不能要求先 `npm install`）。所以把二维码编码内核 vendor 进
 * `assets/vendor/qrcode/`，和 `echarts.min.js` 同一个思路。
 *
 * **不要改回「去某个已知位置 require('qrcode')」那种找法。**
 * 早先的版本在候选目录里写死了 `/Users/<用户名>/.dsh/profiles/desktop/node_modules`，
 * 那是开发机上的路径，换台机器必然找不到；更糟的是它看起来「能用」，
 * 直到别人拿去跑才暴露。自带一份是唯一与运行环境无关的做法。
 *
 * ## vendor 的是裁剪过的版本
 *
 * 上游 `qrcode` 的 `lib/core/` 加上它唯一的运行时依赖 `dijkstrajs`，共 128 KB。
 * 没有带 `lib/renderer/`（那一条才依赖 `pngjs`，1.1 MB，而我们不用它——
 * PNG 在本文件里用内置 `zlib` 直接编，见 `matrixToPng`）。
 * `core/segments.js` 里 `require('dijkstrajs')` 改成了 `require('./dijkstra')`，
 * 其余逐字未改。升级上游时按同样方式重新裁剪。
 *
 * 许可证：MIT，随 vendor 目录带 `LICENSE`。
 */

import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** vendor 的 qrcode 内核（CommonJS，用 createRequire 加载）。 */
const VENDOR_QRCODE = join(HERE, '..', 'assets/vendor/qrcode/core/qrcode.js');

let cachedQrCode = null;

/**
 * 加载 vendor 的二维码内核。
 *
 * vendor 目录随 skill 一起走，**不依赖任何用户路径或 node_modules**。
 * 找不到就是仓库坏了（文件缺失），所以这里不降级、直接报错。
 *
 * @returns {{create: (text: string, opts?: object) => {modules: object}}}
 */
export function loadQrcode() {
  if (cachedQrCode) return cachedQrCode;
  const req = createRequire(import.meta.url);
  const mod = req(VENDOR_QRCODE);
  if (typeof mod?.create !== 'function') {
    throw new Error(`vendor 的 qrcode 内核不可用（${VENDOR_QRCODE} 没有导出 create）`);
  }
  cachedQrCode = mod;
  return cachedQrCode;
}

/**
 * 二维码模块矩阵 → 灰度 PNG。
 *
 * 用内置 `zlib` 手写 PNG，是为了不再引入 `pngjs`（1.1 MB，只为了存一张黑白点阵）。
 * 格式取最省事的组合：8 bit、灰度（color type 0）、无隔行、单个 IDAT。
 *
 * @param {{size: number, get: (row: number, col: number) => boolean}} modules
 * @param {{scale?: number, margin?: number}} [opts]
 * @returns {Buffer}
 */
export function matrixToPng(modules, opts = {}) {
  const scale = opts.scale ?? 8;
  const margin = opts.margin ?? 4;
  const n = modules.size;
  const width = n * scale + margin * 2;

  /*
   * PNG 每行前面要一个 filter 字节。这里统一用 0（None）：
   * 图是纯黑白，压缩率本来就高，不值得为省几百字节去实现 Sub/Up 滤波器。
   */
  const rowBytes = width + 1;
  const raw = Buffer.alloc(rowBytes * width);
  for (let y = 0; y < width; y += 1) {
    const base = y * rowBytes;
    raw[base] = 0;
    const my = Math.floor((y - margin) / scale);
    const insideY = my >= 0 && my < n;
    for (let x = 0; x < width; x += 1) {
      const mx = Math.floor((x - margin) / scale);
      const dark = insideY && mx >= 0 && mx < n && modules.get(my, mx);
      raw[base + 1 + x] = dark ? 0 : 255;
    }
  }

  return buildPng(width, width, raw);
}

/** CRC32 查表（PNG 每个 chunk 都要）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 拼一个 PNG chunk：长度 + 类型 + 数据 + CRC。 */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 组装最小 PNG 文件。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} raw  已含每行 filter 字节的原始像素
 */
function buildPng(width, height, raw) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 二维码内容 → PNG 的 data URL（给 `<img src>` 直接用）。
 *
 * `width: 320, margin: 4` 与之前一致：320px 够手机扫，
 * margin 不能是 0 —— 贴边在部分扫码器上识别率会下降。
 *
 * @param {string} text 二维码实际内容（登录接口返回的 `data.url`）
 * @returns {Promise<string>} `data:image/png;base64,...`
 */
export async function encodeQrDataUrl(text) {
  if (typeof text !== 'string' || !text) throw new Error('二维码内容为空');
  const { create } = loadQrcode();
  const qr = create(text, { errorCorrectionLevel: 'M' });
  const png = matrixToPng(qr.modules, { scale: 8, margin: 4 });
  return `data:image/png;base64,${png.toString('base64')}`;
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
