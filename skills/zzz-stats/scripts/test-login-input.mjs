import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoginInput } from './login-input.mjs';
const root = mkdtempSync(join(tmpdir(), 'zzz-login-input-'));
let passed = 0;
const stream = new PassThrough(); stream.isTTY = true;
stream.setRawMode = value => { stream.raw = value; };
const make = sms => createLoginInput({ workDir: root, outputDir: root, stdinStream: stream, sms, log() {}, sleep: async () => {} });
try {
  const file = join(root, 'code.txt'); writeFileSync(file, '123456');
  const input = make({ codeFile: file });
  assert.equal(await input.requestCode(), '123456'); passed++;
  console.log('✓ TTY 下 --code-file 优先，直接读取验证码而非终端提问');
  assert.equal(existsSync(file), false); passed++; console.log('✓ 验证码文件读取后删除');
  const unsubscribe = input.subscribeRefresh();
  stream.emit('data', Buffer.from('r'));
  assert.equal(input.takeRefreshRequest().refresh, true); passed++; console.log('✓ TTY 按 r 生效');
  writeFileSync(join(root, 'qr-refresh'), '');
  assert.equal(input.takeRefreshRequest().refresh, true); passed++; console.log('✓ TTY 下信号文件仍生效');
  unsubscribe(); assert.equal(stream.raw, false); assert.equal(stream.listenerCount('data'), 0); passed++; console.log('✓ 退订恢复 raw 状态并移除监听');
  assert.equal(await make({ phone: '13800000000' }).requestPhone(), '13800000000'); passed++; console.log('✓ 显式手机号优先');
  assert.equal(await make({ code: '654321' }).requestCode(), '654321'); passed++; console.log('✓ 显式验证码优先');
  assert.equal(typeof input.requestManualAction, 'function'); passed++; console.log('✓ 提供 requestManualAction 而非 SDK 旧 ask');
} finally { assert.ok(root.startsWith(join(tmpdir(), 'zzz-login-input-'))); rmSync(root, { recursive: true, force: true }); }
console.log(`结果：通过 ${passed} / 失败 0`);
