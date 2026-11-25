#!/usr/bin/env node
/** SDK 显式驱动注入不启动浏览器，不依赖 skill runtime。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let pass = 0;
const check = (label, condition) => { assert.ok(condition, label); console.log(`✓ ${label}`); pass++; };
for (const path of ['../drivers.mjs']) {
  const { openDriver } = await import(path);
  let launched = 0, closed = 0;
  const page = { evaluate: async () => 'fake-page' };
  const browser = { version: () => 'fake', newPage: async () => page, close: async () => { closed++; } };
  const chromium = { launch: async () => { launched++; return browser; } };
  const drv = await openDriver({ chromium, log: () => {} });
  check(`${path} 使用显式 chromium`, launched === 1 && drv.kind === 'playwright');
  check(`${path} 可执行注入页面`, await drv.evaluate('ignored') === 'fake-page');
  await drv.close();
  check(`${path} 可关闭注入驱动`, closed === 1);
}
const source = readFileSync(new URL('../drivers.mjs', import.meta.url), 'utf8');
check('驱动不猜宿主 profile 或祖先依赖目录', !source.includes('.dsh/profiles') && !source.includes('ancestorNodeModules'));
console.log(`结果：通过 ${pass} / 失败 0`);
