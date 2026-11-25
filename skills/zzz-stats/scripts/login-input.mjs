/** CLI 输入适配：文件与终端只在外壳接触，SDK 只收到回调。 */
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdout } from 'node:process';
import { createRefreshInput, refreshChannelHint, expiredRefreshHint, REFRESH_SIGNAL_FILE } from '../../../packages/sdk/qr-wait.mjs';
import { takeRefreshRequest } from './qr-wait.mjs';

export async function readInputFile(file, { label, timeoutMs, validate, log, sleep }) {
  const deadline = Date.now() + timeoutMs;
  let complained = null;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      let raw = '';
      try { raw = readFileSync(file, 'utf8').trim(); } catch { /* 等完整写入 */ }
      if (raw) {
        try { rmSync(file); } catch {}
        if (!validate || validate(raw)) return raw;
        if (complained !== raw) {
          complained = raw;
          log(`⚠️  ${label}格式不对（收到 ${raw.length} 位），已忽略，请重新写入。`);
        }
      }
    }
    await sleep(400);
  }
  throw new Error(`${label}等待超时（${Math.round(timeoutMs / 1000)} 秒）。agent 应把用户给的值写入 ${file}。`);
}

export function createLoginInput({ workDir, outputDir, stdinStream, sms = {}, log, sleep }) {
  const signalFile = join(outputDir, REFRESH_SIGNAL_FILE);
  const input = createRefreshInput();
  const stdinRaw = Boolean(stdinStream?.isTTY);
  const ask = async (question) => {
    if (!stdinRaw) throw new Error(`需要交互输入（${question}），但当前不是终端环境。请通过参数或文件提供输入。`);
    const rl = createInterface({ input: stdinStream, output: stdout });
    try { return await rl.question(`${question} … `); } finally { rl.close(); }
  };
  return {
    ask: stdinRaw ? ask : null,
    requestPhone: async () => {
      const phone = sms.phone ?? process.env.ZZZ_PHONE;
      if (phone) return phone;
      if (sms.phoneFile) return readInputFile(resolve(workDir, sms.phoneFile), {
        label: '手机号', timeoutMs: 300000, validate: v => /^\d{11}$/.test(v), log, sleep,
      });
      return ask('请输入手机号（11 位，仅用于填入官方登录框）');
    },
    requestCode: async () => {
      const code = sms.code ?? process.env.ZZZ_SMS_CODE;
      if (code) return code;
      if (stdinRaw && !sms.codeFile) return ask('请输入收到的验证码（通常 60 秒内有效）');
      const file = resolve(workDir, sms.codeFile ?? join(outputDir, 'sms-code.txt'));
      mkdirSync(dirname(file), { recursive: true });
      log(`等待验证码…（短信约 60 秒失效，收到请尽快写入 ${file}）`);
      return readInputFile(file, {
        label: '验证码', timeoutMs: 300000, validate: v => /^\d{4,8}$/.test(v), log, sleep,
      });
    },
    takeRefreshRequest: () => takeRefreshRequest({ keyPressed: input.take(), signalFile }),
    refreshHint: refreshChannelHint({ signalFile, stdinRaw }),
    expiredHint: expiredRefreshHint({ signalFile, stdinRaw }),
    subscribeRefresh: () => {
      if (!stdinRaw) return () => {};
      const onData = buf => input.press(buf);
      stdinStream.setRawMode?.(true);
      stdinStream.resume();
      stdinStream.on('data', onData);
      return () => {
        stdinStream.off('data', onData);
        stdinStream.setRawMode?.(false);
        stdinStream.pause();
      };
    },
  };
}
