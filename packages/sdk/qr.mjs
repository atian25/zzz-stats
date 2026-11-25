/** 二维码编码：SDK 正常依赖 qrcode，不依赖 skill 的 vendor 目录。 */
import QRCode from 'qrcode';
import { SdkError } from './errors.mjs';

/**
 * 登录二维码内容 → PNG data URL。
 * scale 为每模块像素数，margin 为模块数；保留四模块静区供扫码器识别。
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function encodeQrDataUrl(text) {
  if (typeof text !== 'string' || !text) throw new SdkError('INVALID_ARGUMENT', '二维码内容为空', { stage: 'qr' });
  try {
    return await QRCode.toDataURL(text, {
      type: 'image/png', errorCorrectionLevel: 'M', scale: 8, margin: 4,
    });
  } catch (cause) {
    throw new SdkError('QR_ENCODING_FAILED', '二维码编码失败', { stage: 'qr', cause });
  }
}

/** data URL → 原始字节；保存位置由外壳决定。 */
export function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('不是合法的 data URL');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}
