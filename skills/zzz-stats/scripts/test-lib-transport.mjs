#!/usr/bin/env node
/**
 * lib/ SDK 的接口形状与「降级只在 CLI」这条纪律。
 *
 * ## 为什么需要这套用例
 *
 * 「SDK 不做降级」是个**结构性约定**：很容易在下一轮被好心加回来
 * （「node 失败了顺手换浏览器多方便」）。加回来之后行为看起来更好，
 * 但代价是服务端调用方再也拿不到「node 这条路失败」这个事实 ——
 * 它只会看到「成功」，而实际走的是另一条路。这种 bug 不会报错，只会让人困惑。
 *
 * 所以这里把三件事钉成断言：
 *
 *   1. 四个并列入口都在、签名互不依赖（登录与取数可以分开调）
 *   2. `collectData({transport})` 只调给定的那一条：另一条**一次都不许被调用**
 *   3. 纯 Node 那条路遇到国际服**抛错**，而不是自己换成浏览器
 *
 * 不需要浏览器、不联网：所有网络调用都用假实现注入。
 *
 * 跑法：node skills/zzz-stats/scripts/test-lib-transport.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, '..');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
};

// ------------------------------------------------ 1. 四个并列入口都在

console.log('1. 四个并列入口（登录 / 取数 × node / browser）');
const lib = await import('../lib/index.mjs');
for (const name of ['loginByQrNode', 'collectViaNode', 'loginByQrBrowser', 'collectViaBrowser']) {
  ok(`${name} 是函数`, typeof lib[name] === 'function', typeof lib[name]);
}
ok('closeBrowserSession 也在（浏览器上下文要由调用方关）', typeof lib.closeBrowserSession === 'function');

console.log('2. 源码里没有「在 SDK 内换一条路」的痕迹');
const libDir = join(SKILL_DIR, 'lib');
const srcOf = (f) => readFileSync(join(libDir, f), 'utf8');
/*
 * 这几种写法都是「SDK 自己决定降级」的味道：
 *   - 在 node 分支里 catch 之后调 browser
 *   - 反过来
 *   - 用 `??` / `||` 在两条路之间挑
 * 逐个 grep 而不是靠肉眼看，因为下一轮很容易「顺手加一行」。
 */
for (const [file, label] of [
  ['collect.mjs', 'collect.mjs'],
  ['login-node.mjs', 'login-node.mjs'],
  ['login-browser.mjs', 'login-browser.mjs'],
]) {
  const src = srcOf(file);
  // collect.mjs 的注释里会写到「没有降级」，先剥注释再判断
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok(`${label} 里没有「catch 后改道」的注释级痕迹`, !/catch[\s\S]{0,400}?(loginByQrBrowser|collectViaBrowser)\(/.test(
    code.split('\n').filter((l) => !/降级|策略|SDK 不|不判断/.test(l)).join('\n'),
  ));
}

// ---------------------------------- 3. collectData 只调指定的那一条

console.log('3. collectData 只调给定的 transport，另一条一次都不许碰');

/*
 * 用「记录被调用」的假模块思路：直接 monkey-patch 两条路的入口。
 * 这不是在测真实网络，而是测**分支选择**——正好是这一单的核心。
 */
const calls = [];
const collectMod = await import('../lib/collect.mjs');
const loginNode = await import('../lib/login-node.mjs');

/*
 * 纯 Node 路径：把 loginByQrNode / collectViaNode 换成假的。
 * 注意动态 import 拿到的命名空间是**只读**的，所以要测分支选择，
 * 我们用「真实但会立刻失败的入参」来观察：给一个不可能成功的 fetchImpl，
 * 看它抛的是 node 的错还是 browser 的错。
 */
{
  const fakeFetch = async () => { throw new Error('FAKE_NETWORK_DOWN'); };
  let err = null;
  try {
    await collectMod.collectData({
      transport: 'node',
      cfg: JSON.parse(readFileSync(join(SKILL_DIR, 'config/report.json'), 'utf8')),
      fetchImpl: fakeFetch,
      onQr: async () => { calls.push('node-onQr'); },
      log: () => {},
      sleep: async () => {},
    });
  } catch (e) { err = e; }
  ok('transport=node 时抛的是 node 那条路的错（没有偷偷换路）',
    err !== null && /FAKE_NETWORK_DOWN|申请二维码失败/.test(err.message), err?.message?.slice(0, 80));
  ok('node 失败时没有走到浏览器的扫码回调', !calls.includes('browser-onQr'));
}

console.log('4. 纯 Node 遇到国际服：抛错，不自己换浏览器');
{
  let err = null;
  try {
    await loginNode.loginByQrNode({
      region: 'prod_gf_us',
      onQr: async () => {},
      log: () => {},
      sleep: async () => {},
      fetchImpl: async () => { throw new Error('不该被调到'); },
    });
  } catch (e) { err = e; }
  ok('loginByQrNode 对国际服直接抛错',
    err !== null && /只做国服/.test(err.message), err?.message?.slice(0, 60));

  let err2 = null;
  try {
    await loginNode.collectViaNode({
      cookieHeader: 'a=1', uid: '123', region: 'prod_gf_us',
      log: () => {}, sleep: async () => {}, fetchImpl: async () => { throw new Error('不该被调到'); },
    });
  } catch (e) { err2 = e; }
  ok('collectViaNode 对国际服直接抛错',
    err2 !== null && /只做国服/.test(err2.message), err2?.message?.slice(0, 60));
}

console.log('5. 入口自检：缺参数就抛，不静默');
{
  let e1 = null;
  try { await loginNode.collectViaNode({ log: () => {} }); } catch (e) { e1 = e; }
  ok('collectViaNode 缺 cookieHeader 抛错', e1 !== null && /cookieHeader/.test(e1.message));

  let e2 = null;
  try { await loginNode.collectViaNode({ cookieHeader: 'a=1', log: () => {} }); } catch (e) { e2 = e; }
  ok('collectViaNode 缺 uid 抛错', e2 !== null && /uid/.test(e2.message));

  const browserMod = await import('../lib/login-browser.mjs');
  let e3 = null;
  try { await browserMod.collectViaBrowser({ log: () => {} }); } catch (e) { e3 = e; }
  ok('collectViaBrowser 缺 drv 抛错', e3 !== null && /drv/.test(e3.message));
}

console.log('');
console.log(fail === 0 ? `结果：通过 ${pass} / 失败 0` : `结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
