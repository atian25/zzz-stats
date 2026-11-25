import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const nativeSpawn = childProcess.spawn;
const spawned = [];
childProcess.spawn = (...args) => { const child = nativeSpawn(...args); spawned.push(child); return child; };
syncBuiltinESMExports();

const fakeBin = fileURLToPath(new URL('./cdp-fake-chrome.mjs', import.meta.url));
chmodSync(fakeBin, 0o755);
process.env.CHROME_PATH = fakeBin;
const { openDriver } = await import('../drivers.mjs');
const NativeWebSocket = globalThis.WebSocket;
let requests = [];
let delayCreate = 0;
let abortCreate;
class FakeWebSocket extends EventTarget {
  constructor(url) { super(); this.url = url; setTimeout(() => this.dispatchEvent(new Event('open')), 0); }
  send(raw) {
    const message = JSON.parse(raw);
    requests.push(message);
    const result = message.method === 'Target.getTargets' ? { targetInfos: [{ targetId: 'a', type: 'page', url: 'https://a.test' }, { targetId: 'b', type: 'page', url: 'https://b.test' }] }
      : message.method === 'Target.createTarget' ? { targetId: 'c' }
      : message.method === 'Target.attachToTarget' ? { sessionId: 'session-c' } : {};
    const reply = () => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result }) }));
    if (message.method === 'Target.createTarget' && delayCreate) { setTimeout(reply, delayCreate); abortCreate?.(); }
    else queueMicrotask(reply);
  }
  close() { this.dispatchEvent(new Event('close')); }
}
globalThis.WebSocket = FakeWebSocket;
let passed = 0, failed = 0;
async function test(name, run) {
  requests = []; delayCreate = 0; abortCreate = null;
  console.log(`开始：${name}`);
  try { await run(); passed++; console.log(`✓ ${name}`); }
  catch (cause) { failed++; console.error(`✗ ${name}`, cause); }
}
async function reserve() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fakeServer(run) {
  let host;
  const server = createServer((req, res) => {
    host = req.headers.host;
    res.end(JSON.stringify({ Browser: 'borrowed', webSocketDebuggerUrl: 'ws://localhost/fake' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(server.address().port, () => host); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function absent(pid) { assert.throws(() => process.kill(pid, 0), cause => cause.code === 'ESRCH'); }
async function owned(profile, run) {
  const port = await reserve();
  const d = await openDriver({ driver: 'cdp', port, profile, log() {} });
  const { pid } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  try { await run(d, pid, port); }
  finally { await d.close(); absent(pid); }
}
try {
  await test('自启进程 close 等待退出并释放端口', () => owned('fake-normal', async (d, pid, port) => {
    await d.open('https://example.test');
    await d.close(); absent(pid);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/json/version`));
  }));
  await test('忽略 SIGTERM 的自启进程由 SIGKILL 收尾，重复 close 幂等', () => owned('fake-ignore-term', async (d, pid) => {
    await Promise.all([d.close(), d.close()]); absent(pid); await d.close();
  }));
  await test('借入 Chrome close 只关自建 target，服务仍可请求', () => fakeServer(async port => {
    const d = await openDriver({ cdpUrl: `http://127.0.0.1:${port}`, log() {} });
    try { await d.open('https://example.test'); }
    finally { await d.close(); }
    assert.equal((await fetch(`http://127.0.0.1:${port}/json/version`)).status, 200);
    assert.deepEqual(requests.filter(x => x.method === 'Target.closeTarget').map(x => x.params.targetId), ['c']);
  }));
  await test('已有两个页面不被复用；重复 open 只用自己的第三个 target', () => fakeServer(async port => {
    const d = await openDriver({ cdpUrl: `http://127.0.0.1:${port}`, log() {} });
    try { await d.open('https://first.test'); await d.open('https://second.test'); }
    finally { await d.close(); }
    assert.equal(requests.filter(x => x.method === 'Target.createTarget').length, 1);
    assert.ok(requests.filter(x => x.method === 'Target.attachToTarget').every(x => x.params.targetId === 'c'));
    assert.equal(requests.some(x => ['a', 'b'].includes(x.params.targetId)), false);
  }));
  await test('非 127.0.0.1 host 透传 HTTP Host', () => fakeServer(async (port, host) => {
    const d = await openDriver({ cdpUrl: `http://localhost:${port}`, log() {} });
    await d.close(); assert.equal(host(), `localhost:${port}`);
  }));
  await test('取消 target 创建后迟到结果仍关闭，不继续 attach', () => fakeServer(async port => {
    const controller = new AbortController();
    const d = await openDriver({ cdpUrl: `http://127.0.0.1:${port}`, signal: controller.signal, log() {} });
    delayCreate = 40; abortCreate = () => controller.abort();
    try { await assert.rejects(d.open('https://example.test'), x => x.code === 'ABORTED'); }
    finally { await d.close(); }
    assert.equal(requests.some(x => x.method === 'Target.attachToTarget'), false);
    assert.deepEqual(requests.filter(x => x.method === 'Target.closeTarget').map(x => x.params.targetId), ['c']);
  }));
  await test('启动等待期间取消，openDriver 返回前已释放自启进程', async () => {
    const port = await reserve();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(openDriver({ driver: 'cdp', port, profile: 'fake-startup-wait', signal: controller.signal, log() {} }), x => x.code === 'ABORTED'); }
    finally { clearTimeout(timer); }
    assert.ok(spawned.at(-1)?.pid); absent(spawned.at(-1).pid);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/json/version`));
  });
  await test('自启进程提前退出，启动失败不会等满 30 秒', async () => {
    const port = await reserve();
    const start = Date.now();
    await assert.rejects(openDriver({ driver: 'cdp', port, profile: 'fake-exit-early', log() {} }), /Chrome 没在端口/);
    assert.ok(Date.now() - start < 5000);
  });
} finally {
  globalThis.WebSocket = NativeWebSocket;
  childProcess.spawn = nativeSpawn; syncBuiltinESMExports();
  for (const child of spawned) { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); } }
}
console.log(`结果：通过 ${passed} / 失败 ${failed}`);
process.exitCode = failed ? 1 : 0;
