// 可选真实 Chrome 验收；只用独立端口和独立临时 profile，不访问 9222。
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const port = Number(process.env.CDP_TEST_PORT ?? 9334);
assert.notEqual(port, 9222);
const reservation = createServer();
await new Promise((res, rej) => { reservation.once('error', rej); reservation.listen(port, '127.0.0.1', res); });
await new Promise(res => reservation.close(res));
const root = resolve('output');
const profile = await mkdtemp(resolve(root, '.cdp-contract-'));
const nativeSpawn = childProcess.spawn;
const children = [];
childProcess.spawn = (...args) => { const child = nativeSpawn(...args); children.push(child); return child; };
syncBuiltinESMExports();
process.env.ZZZ_CHROME_ARGS = '--headless=new --no-sandbox';
const { openDriver } = await import('../drivers.mjs');
let d;
try {
  d = await openDriver({ driver: 'cdp', port, profile, log: console.log });
  await d.open('data:text/html,<title>CDP contract</title>');
  assert.equal(await d.evaluate('document.title'), 'CDP contract');
  await d.close(); await d.close();
  for (const child of children) assert.throws(() => process.kill(child.pid, 0), x => x.code === 'ESRCH');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/json/version`));
  console.log(`✓ 真实 Chrome 页面执行正确；close 后 PID ${children.map(x => x.pid)} 不存在，端口 ${port} 已释放`);
  console.log('结果：通过 1 / 失败 0');
} finally {
  await d?.close();
  childProcess.spawn = nativeSpawn; syncBuiltinESMExports();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(res => child.once('exit', res)); }
  // 只删除本脚本 mkdtemp 得到且已核对的 profile，不删除 output 目录或账号产物。
  assert.equal(profile.startsWith(root + '/.cdp-contract-'), true);
  console.log(`清理独立 profile：${profile}`);
  await rm(profile, { recursive: true, force: true });
}
