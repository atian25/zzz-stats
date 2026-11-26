import { assert, SdkError } from './errors.mjs';

/** 只编码、不落盘；动态加载使不使用二维码的消费者不需要提前载入依赖。 */
export async function encodeQrDataUrl(text) {
  assert(typeof text === 'string' && text.length > 0, '二维码内容不能为空');
  try {
    const { default: QRCode } = await import('qrcode');
    return await QRCode.toDataURL(text, {
      type: 'image/png', errorCorrectionLevel: 'M', scale: 8, margin: 4,
    });
  } catch {
    throw new SdkError('QR_ENCODING_FAILED', '二维码编码失败');
  }
}
