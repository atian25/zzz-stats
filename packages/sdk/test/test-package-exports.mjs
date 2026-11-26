#!/usr/bin/env node
/** workspace 包边界回归，不启动 server 或浏览器。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
const requireFromServer = createRequire(new URL('../../server/serve.mjs', import.meta.url));
let pass = 0;
function check(name, value) { assert.ok(value, name); pass++; console.log(`✓ ${name}`); }
for (const [name, symbol] of [
  ['@atian25/zzz-stats-sdk', 'collectData'],
  ['@atian25/zzz-stats-sdk', 'encodeQrDataUrl'],
  ['@atian25/zzz-stats-sdk', 'login'],
  ['@atian25/zzz-stats-skill/report', 'buildReport'],
]) {
  const module = await import(requireFromServer.resolve(name));
  check(`${name} 出口可调用`, typeof module[symbol] === 'function');
}
const config = JSON.parse(readFileSync(requireFromServer.resolve('@atian25/zzz-stats-skill/config'), 'utf8'));
check('skill 配置出口包含频道表', Array.isArray(config.channels));
assert.throws(() => requireFromServer.resolve('@atian25/zzz-stats-sdk/login-node.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
check('未公开 SDK 内部子路径不可通过包名读取', true);
for (const suffix of ['qr', 'drivers', 'transport', 'qr-wait']) {
  assert.throws(() => requireFromServer.resolve(`@atian25/zzz-stats-sdk/${suffix}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  check(`${suffix} 子路径被拒绝`, true);
}
const publicModule = await import(requireFromServer.resolve('@atian25/zzz-stats-sdk'));
check('根入口恰好五个导出', Object.keys(publicModule).sort().join(',') === 'SdkError,collect,collectData,encodeQrDataUrl,login');
const sdk = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
check('SDK 是可发布的 ESM 包', sdk.private !== true && sdk.type === 'module');
for (const path of ['../../server/package.json', '../../../skills/zzz-stats/package.json']) {
  const manifest = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  check(`${manifest.name} 为 private ESM 包`, manifest.private === true && manifest.type === 'module');
}
check('exports 只留根入口', JSON.stringify(sdk.exports) === '{".":"./index.mjs"}');
check('发布元数据齐全', ['description', 'license', 'repository', 'author', 'keywords'].every(key => sdk[key] && (typeof sdk[key] !== 'object' || Object.keys(sdk[key]).length)));
check('发布目标是 npmjs.org 且公开', sdk.publishConfig?.registry === 'https://registry.npmjs.org/' && sdk.publishConfig?.access === 'public');
check('Playwright 为 optional peer 非普通依赖', sdk.peerDependenciesMeta['playwright-core'].optional && !sdk.dependencies['playwright-core']);
check('只有根 lockfile', existsSync(new URL('../../../pnpm-lock.yaml', import.meta.url)) && !existsSync(new URL('../pnpm-lock.yaml', import.meta.url)));
console.log(`结果：通过 ${pass} / 失败 0`);
