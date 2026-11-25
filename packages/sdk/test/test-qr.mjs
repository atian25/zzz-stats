#!/usr/bin/env node
/** 真 PNG 编码/解码回归，不访问登录接口、不依赖 skill vendor。 */
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { encodeQrDataUrl, dataUrlToBuffer } from '../qr.mjs';
import { loginWithQr } from '../login-node.mjs';
let pass = 0;
const check = (name, cond) => { assert.ok(cond, name); console.log(`✓ ${name}`); pass++; };
const decode = dataUrl => {
  const png = PNG.sync.read(dataUrlToBuffer(dataUrl));
  return { png, result: jsQR(new Uint8ClampedArray(png.data), png.width, png.height) };
};
for (const text of ['https://example.com/login?ticket=test-123', '二维码测试：绳匠A & 123', 'x'.repeat(600)]) {
  const pending = encodeQrDataUrl(text);
  check('编码返回 Promise', pending instanceof Promise);
  const dataUrl = await pending;
  check('返回 PNG data URL', dataUrl.startsWith('data:image/png;base64,'));
  const { png, result } = decode(dataUrl);
  check('PNG 为非空正方形', png.width === png.height && png.width > 0);
  check('独立解码内容逐字一致', result?.data === text);
}
for (const text of ['', null, 1]) {
  await assert.rejects(() => encodeQrDataUrl(text), /二维码内容为空/);
  pass++; console.log('✓ 非法内容明确拒绝');
}
let qr;
const text = 'https://example.com/login?ticket=server-test';
await loginWithQr({
  onQr: async value => { qr = value; },
  fetchImpl: async url => ({
    headers: { getSetCookie: () => ['ltoken_v2=test; Path=/'] },
    json: async () => ({ retcode: 0, data: url.endsWith('createQRLogin')
      ? { url: text, ticket: 'fake-ticket' }
      : { status: 'Confirmed', user_info: { aid: '10000001' } } }),
  }),
});
check('登录默认编码器产生可解码图片', decode(qr.dataUrl).result?.data === text);
check('登录回调严格只有 dataUrl', Object.keys(qr).join(',') === 'dataUrl');
let injected = false;
await loginWithQr({
  encodeQr: async value => { injected = value === text; return 'data:image/png;base64,FAKE'; },
  fetchImpl: async url => ({
    headers: { getSetCookie: () => ['ltoken_v2=test; Path=/'] },
    json: async () => ({ retcode: 0, data: url.endsWith('createQRLogin')
      ? { url: text, ticket: 'fake-ticket' } : { status: 'Confirmed' } }),
  }),
  onQr: async value => { check('自定义异步编码结果交给回调', value.dataUrl === 'data:image/png;base64,FAKE'); },
});
check('encodeQr 注入仍有效', injected);
console.log(`结果：通过 ${pass} / 失败 0`);
