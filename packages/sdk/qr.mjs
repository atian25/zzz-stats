/** 二维码编码：SDK 正常依赖 qrcode，不依赖 skill 的 vendor 目录。 */
import QRCode from 'qrcode';

/**
 * 登录二维码内容 → PNG data URL。
 * scale 为每模块像素数，margin 为模块数；保留四模块静区供扫码器识别。
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function encodeQrDataUrl(text) {
  if (typeof text !== 'string' || !text) throw new Error('二维码内容为空');
  return QRCode.toDataURL(text, {
    type: 'image/png', errorCorrectionLevel: 'M', scale: 8, margin: 4,
  });
}

/** data URL → 原始字节；保存位置由外壳决定。 */
export function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('不是合法的 data URL');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}
