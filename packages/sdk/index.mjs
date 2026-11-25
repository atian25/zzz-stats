/** 采集 SDK 公共入口：仅登录、取数、完整流程、二维码编码与错误类型。
 * 不读报表资源、不保存采集产物、不解析 argv；内部工具不构成公共 API。
 */
export { collectData, login, collect } from './api.mjs';
export { encodeQrDataUrl } from './qr.mjs';
export { SdkError } from './errors.mjs';
