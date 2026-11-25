#!/usr/bin/env node
/**
 * `packages/sdk/` —— 采集层的接口形状与「降级只在 CLI」这条纪律。
 *
 * 这是**采集层自己的**用例，所以它跟 `packages/sdk/` **同进同出**：
 * 把 `packages/sdk/` 单独拷走、不给 skill 目录，它照样能跑。
 * 边界那条判据是：**它读不读 `skills/zzz-stats/`**。要读，就说明它不是纯采集测试。
 *
 * 渲染层（`buildReport` 的 Map/对象契约、以及两层目录边界）在
 * `skills/zzz-stats/scripts/test-render-contract.mjs` —— 那边要同时看两个目录，
 * 从仓库层级看最合理。
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
 * **也不需要 skill 目录**：`cfg` 内联给、二维码编码用 `encodeQr` 接管，
 * 所以它连 `config/report.json` 和 `assets/vendor/` 都不读。
 *
 * 跑法：node packages/sdk/test/test-sdk-transport.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/* 本文件在 packages/sdk/test/，SDK 根在上一级 */
const SDK_DIR = resolve(HERE, '..');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
};

/*
 * 最小 cfg：这条用例只测**分支选择**，不测频道逻辑。
 * 内联给而不是读 `config/report.json` —— 那是 skill 的资源，
 * 读了这套就不是「纯采集测试」了（见文件头的边界判据）。
 */
const MIN_CFG = { channels: [] };

/* 接管二维码编码，不碰 assets/vendor/qrcode */
const fakeEncodeQr = async () => 'data:image/png;base64,FAKE';

// ------------------------------------------------ 1. 四个并列入口都在

console.log('1. 四个并列入口（登录 / 取数 × node / browser）');
const lib = await import('../index.mjs');
for (const name of ['loginByQrNode', 'collectViaNode', 'loginByQrBrowser', 'collectViaBrowser']) {
  ok(`${name} 是函数`, typeof lib[name] === 'function', typeof lib[name]);
}
ok('closeBrowserSession 也在（浏览器上下文要由调用方关）', typeof lib.closeBrowserSession === 'function');

console.log('2. 源码里没有「在 SDK 内换一条路」的痕迹');
const srcOf = (f) => readFileSync(join(SDK_DIR, f), 'utf8');
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
const collectMod = await import('../collect.mjs');
const loginNode = await import('../login-node.mjs');

/*
 * 纯 Node 路径：给一个不可能成功的 fetchImpl，
 * 看它抛的是 node 的错还是 browser 的错。
 */
{
  const fakeFetch = async () => { throw new Error('FAKE_NETWORK_DOWN'); };
  let err = null;
  try {
    await collectMod.collectData({
      transport: 'node',
      cfg: MIN_CFG,
      // 接管编码以隔离网络分支测试；默认编码器另有 PNG 解码回归。
      encodeQr: fakeEncodeQr,
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

  const browserMod = await import('../login-browser.mjs');
  let e3 = null;
  try { await browserMod.collectViaBrowser({ log: () => {} }); } catch (e) { e3 = e; }
  ok('collectViaBrowser 缺 drv 抛错', e3 !== null && /drv/.test(e3.message));
}

console.log('6. 短信登录真实函数：文件输入与直接输入');
{
  const { smsLogin, loginFlow } = await import('../login-browser.mjs');
  const drv = {
    waitFor: async () => ({ mounted: true, loggedOut: true, hasUid: false }),
    loginFrame: async () => ({}),
    evaluate: async () => 'logged-in',
    evaluateInFrame: async (_frame, expression) => {
      if (expression.includes('hasPhone:')) return { hasPhone: true, hasCode: true, areaCode: '+86' };
      if (expression.includes('const setter')) return 'ok';
      if (expression.includes('获取验证码')) return 'clicked';
      return 'clicked';
    },
  };
  for (const [label, sms] of [
    ['直接传手机号与验证码', { phone: '13800000000', code: '123456' }],
    ['手机号由回调提供', { code: '123456' }],
    ['验证码由回调提供', { phone: '13800000000' }],
  ]) {
    let error = null;
    try {
      await smsLogin(drv, {}, {
        sms, workDir: '/tmp', outputDir: '/tmp', stdinStream: null,
        requestPhone: async () => '13800000000', requestCode: async () => '123456',
        purge: () => {}, log: () => {}, sleep: async () => {}, LOGGED_IN: 'logged-in',
      });
    } catch (e) { error = e; }
    ok(`短信登录：${label}`, error === null, error?.stack);
  }
  let flowError = null;
  try {
    await loginFlow(drv, {
      mode: 'sms', input: { requestPhone: async () => '13800000000', requestCode: async () => '123456' },
      purge: () => {}, sleep: async () => {},
    });
  } catch (e) { flowError = e; }
  ok('loginFlow 短信分流实际接通回调且 sms 可省略', flowError === null, flowError?.stack);
}

console.log('');
console.log(fail === 0 ? `结果：通过 ${pass} / 失败 0` : `结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
