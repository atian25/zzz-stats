#!/usr/bin/env node
/** CLI 输入适配回归；只用临时假值，不访问真实账号。 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createLoginInput } from './login-input.mjs';
const root = mkdtempSync(join(tmpdir(), 'zzz-input-'));
const outputDir = join(root, 'output');
const originalEnv = { phone: process.env.ZZZ_PHONE, code: process.env.ZZZ_SMS_CODE };
delete process.env.ZZZ_PHONE; delete process.env.ZZZ_SMS_CODE;
let pass = 0;
const check = (name, condition) => { assert.ok(condition, name); console.log(`✓ ${name}`); pass++; };
try {
  mkdirSync(outputDir);
  writeFileSync(join(root, 'phone.txt'), '13800000000');
  writeFileSync(join(root, 'code.txt'), '123456');
  const input = createLoginInput({ workDir: root, outputDir, stdinStream: null,
    sms: { phoneFile: 'phone.txt', codeFile: 'code.txt' }, log: () => {}, sleep: async () => {} });
  check('手机号相对 WORK_DIR 读取', await input.requestPhone() === '13800000000');
  check('手机号文件消费后删除', !existsSync(join(root, 'phone.txt')));
  check('验证码相对 WORK_DIR 读取', await input.requestCode() === '123456');
  check('验证码文件消费后删除', !existsSync(join(root, 'code.txt')));
  writeFileSync(join(outputDir, 'sms-code.txt'), '654321');
  const defaults = createLoginInput({ workDir: root, outputDir, stdinStream: null, log: () => {}, sleep: async () => {} });
  check('默认验证码读取 output/sms-code.txt', await defaults.requestCode() === '654321');
  check('默认验证码已删除', !existsSync(join(outputDir, 'sms-code.txt')));
  const tty = new EventEmitter(); tty.isTTY = true;
  tty.resume = () => {}; tty.pause = () => {}; tty.setRawMode = () => {};
  const terminal = createLoginInput({ workDir: root, outputDir, stdinStream: tty, log: () => {}, sleep: async () => {} });
  writeFileSync(join(root, 'tty-code.txt'), '234567');
  const explicit = createLoginInput({ workDir: root, outputDir, stdinStream: tty,
    sms: { codeFile: 'tty-code.txt' }, log: () => {}, sleep: async () => {} });
  check('TTY 下显式验证码文件优先于终端提问', await explicit.requestCode() === '234567');
  const off = terminal.subscribeRefresh();
  writeFileSync(join(outputDir, 'qr-refresh'), '');
  check('TTY 下文件刷新仍触发', terminal.takeRefreshRequest().via === 'signal');
  tty.emit('data', Buffer.from('r'));
  writeFileSync(join(outputDir, 'qr-refresh'), '');
  check('键盘与文件同时触发只返回一条请求', terminal.takeRefreshRequest().via === 'key+signal');
  check('请求消费后无重复', !terminal.takeRefreshRequest().refresh);
  off(); check('收尾摘除键盘监听', tty.listenerCount('data') === 0);
  console.log(`结果：通过 ${pass} / 失败 0`);
} finally {
  for (const [key, value] of [['ZZZ_PHONE', originalEnv.phone], ['ZZZ_SMS_CODE', originalEnv.code]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  // 只删除本测试刚创建且路径前缀已确认的临时目录。
  assert.ok(root.startsWith(join(tmpdir(), 'zzz-input-')));
  rmSync(root, { recursive: true, force: true });
}
