#!/usr/bin/env node
// CDP 启动生命周期测试用进程：只开 HTTP，不启动真实浏览器或写 profile。
import { createServer } from 'node:http';
const port = Number(process.argv.find(x => x.startsWith('--remote-debugging-port='))?.split('=')[1]);
const profile = process.argv.find(x => x.startsWith('--user-data-dir=')) ?? '';
if (profile.includes('ignore-term')) process.on('SIGTERM', () => {});
if (profile.includes('exit-early')) process.exit(7);
if (profile.includes('startup-wait')) setInterval(() => {}, 1000);
else createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ Browser: 'fake Chrome', pid: process.pid, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
}).listen(port, '127.0.0.1');
