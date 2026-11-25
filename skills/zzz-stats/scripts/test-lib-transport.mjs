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

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, '..');
/*
 * SDK 现在在仓库根的 `packages/sdk/`，**不在 skill 里**了。
 * 下面有几条断言要 grep SDK 源码（「不许在 SDK 里降级」那几条），
 * 所以这里单独给出 SDK 目录，别再拿 `join(SKILL_DIR, 'lib')`。
 */
const REPO_DIR = resolve(SKILL_DIR, '..', '..');
const SDK_DIR = join(REPO_DIR, 'packages/sdk');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
};

// ------------------------------------------------ 1. 四个并列入口都在

console.log('1. 四个并列入口（登录 / 取数 × node / browser）');
const lib = await import('../../../packages/sdk/index.mjs');
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
const collectMod = await import('../../../packages/sdk/collect.mjs');
const loginNode = await import('../../../packages/sdk/login-node.mjs');

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
      /*
       * 二维码编码器指向 vendor。这条用例的 fetch 立刻抛错，走不到出码那一步，
       * 但 `loginWithQr()` 现在**要求** encodeQr / qrVendorPath 二者之一，
       * 不给会在入口就抛「需要 encodeQr 或 qrVendorPath」而不是那条 FAKE_NETWORK_DOWN。
       */
      qrVendorPath: join(SKILL_DIR, 'assets/vendor/qrcode/core/qrcode.js'),
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

  const browserMod = await import('../../../packages/sdk/login-browser.mjs');
  let e3 = null;
  try { await browserMod.collectViaBrowser({ log: () => {} }); } catch (e) { e3 = e; }
  ok('collectViaBrowser 缺 drv 抛错', e3 !== null && /drv/.test(e3.message));
}

console.log('6. buildReport 收 Map 与收普通对象，产出必须相同');
{
  /*
   * 这条钉的是一个**静默** bug：`buildReport()` 文档说「Map 与普通对象都收」，
   * 但内嵌原始 JSON 时用的是入参 `files`，而 `JSON.stringify(map)` 是 `{}`。
   *
   * 症状不对称，所以最容易漏：构建日志一切正常、没有 fatal、Node 侧口径也全对，
   * **只有打开产物才崩** —— `statsOf()` 拿到 null，抛
   * `Cannot read properties of null (reading 'type_stats')`，页面白屏。
   *
   * CLI 一直传普通对象，所以从拆分那天起这条路径就没被走到过；
   * 是 `serve.mjs` 的浏览器验收（真 chrome 打开 /report）抓到的。
   * 只测了对象那条，就等于只测了承诺的一半 —— 所以这里两条都跑。
   */
  /* 报表渲染器在 skill 的 lib（不在 packages/sdk），它自己定位资源，不用注入 */
  const build = await import('../lib/build.mjs');
  const FIX = join(REPO_DIR, 'fixtures/baseline');
  const CFG = JSON.parse(readFileSync(join(SKILL_DIR, 'config/report.json'), 'utf8'));

  const map = new Map();
  const put = (name) => {
    try { map.set(name, JSON.parse(readFileSync(join(FIX, name), 'utf8'))); } catch { /* 该频道无记录 */ }
  };
  put('index.json');
  put('meta.json');
  for (const ch of CFG.channels) {
    put(`cur_pool_stat_${ch.id}.json`);
    put(`hist_pool_stat_${ch.id}.json`);
  }
  ok('fixtures/baseline 能读成 14 个键的 Map', map.size === 14, `${map.size} 个`);

  const quiet = { logWarn: () => {} };
  const fromMap = build.buildReport({ files: map, cfg: CFG, ...quiet });
  const fromObj = build.buildReport({ files: Object.fromEntries(map), cfg: CFG, ...quiet });
  ok('Map 入参无 fatal', fromMap.fatal.length === 0, fromMap.fatal.join('; '));

  const payloadOf = (html) => {
    const m = html.match(/<script type="application\/json" id="[^"]*">([\s\S]*?)<\/script>/);
    return m ? m[1] : null;
  };
  const pMap = payloadOf(fromMap.html);
  ok('Map 入参的产物里内嵌 JSON 不是空的', Boolean(pMap) && pMap.trim().length > 1000,
    pMap ? `${pMap.length} 字符` : '没找到 payload');

  /*
   * 归一化 generatedAt 之后逐字节比。它是构建时刻，两次调用必然差几毫秒，
   * 除此之外**一个字节都不许差** —— 差一个字节就说明两条入参路径没有被同等地摊平。
   */
  const norm = (s) => s.replace(/20\d{2}-\d{2}-\d{2}T[\d:.]+Z/g, '<T>');
  ok('Map 与对象的产物归一化后逐字节相同',
    norm(fromMap.html) === norm(fromObj.html),
    `Map ${norm(fromMap.html).length} / 对象 ${norm(fromObj.html).length}`);
}

// ------------------------------------------------ 6. 目录边界：采集与报表分属两边

/*
 * 用户拍板的结构：`packages/sdk/` **只放采集**，出报表的留在 `skills/zzz-stats/lib/`。
 * 判据是「它依赖 skill 资源吗」—— ��� `build.mjs` 有 9 处读 `assets/report/**` 与
 * `assets/vendor/**`，它是**这份报表的渲染器**，不是通用 SDK。
 *
 * 这条很容易被「顺手都搬进 packages 更整齐」带回去，带回去的代价是：
 * 要么渲染器到处 404，要么再加一整套资源注入参数（把耦合换个地方而已）。
 * 所以钉成断言。
 */
console.log('');
console.log('6. 目录边界：packages/sdk 只放采集，报表渲染器留 skill/lib');

const sdkIndex = await import('../../../packages/sdk/index.mjs');
ok('packages/sdk 导出采集主入口 collectData', typeof sdkIndex.collectData === 'function');

/*
 * **读源码文本，不 import 那个模块。**
 *
 * 试过从 `packages/sdk/index.mjs` 导出一个 `buildReport` 做反向验证 —— 结果用例在
 * **模块解析期**就崩了、退出码 1，但一条断言都没跑（`build.mjs` 静�� `import
 * '../assets/report/core.js'`，搬到 `packages/sdk/` 后解析成 `packages/assets/...`）。
 * 那不算「断言拦住了」，只是崩得早。所以这几条一律 grep 源码。
 */
const sdkIndexSrc = readFileSync(join(SDK_DIR, 'index.mjs'), 'utf8');
ok('packages/sdk/index.mjs 不导出 buildReport',
  !/export\s*\{[^}]*\bbuildReport\b/.test(sdkIndexSrc));
ok('packages/sdk 不导出 skillAssets（已删，不再有资源路径推断）',
  !/export\s*\{[^}]*\bskillAssets\b/.test(sdkIndexSrc));
ok('packages/sdk/ 下没有 build.mjs / core-inline.mjs / template-tokens.mjs',
  ['build.mjs', 'core-inline.mjs', 'template-tokens.mjs']
    .every((f) => !existsSync(join(SDK_DIR, f))));

const skillLib = await import('../lib/index.mjs');
ok('skill/lib 导出 buildReport', typeof skillLib.buildReport === 'function');
ok('两个出口是不同模块', typeof sdkIndex.buildReport === 'undefined' && typeof skillLib.buildReport === 'function');

/* 采集层不许碰 skill 资源：扫源码里的 assets/ 与 config/ 读取 */
const sdkFiles = ['collect.mjs', 'login-node.mjs', 'login-browser.mjs', 'transport-node.mjs', 'qr.mjs', 'drivers.mjs', 'qr-wait.mjs'];
const sdkReadsSkill = sdkFiles.filter((f) => {
  const src = readFileSync(join(SDK_DIR, f), 'utf8');
  /*
   * 只认「真的读文件」：`readFileSync(join(SKILL_DIR, 'assets/...'))` 这种。
   * 错误信息里提到路径（'assets/vendor/... 的绝对路径'）不算 —— 那是在**要求调用方传**。
   */
  return /readFileSync\([^)]*(assets\/|config\/report\.json)/.test(src);
});
ok('采集层没有任何一处自己读 assets/ 或 config/report.json',
  sdkReadsSkill.length === 0, sdkReadsSkill.join(', '));

/* 渲染器相反：它就该自己读，靠 SKILL_DIR */
const buildSrc = readFileSync(join(SKILL_DIR, 'lib/build.mjs'), 'utf8');
ok('报表渲染器用 SKILL_DIR 自己定位资源', /const SKILL_DIR = resolve\(HERE, '\.\.'\)/.test(buildSrc));
const assetReads = (buildSrc.match(/join\(SKILL_DIR/g) || []).length;
ok('报表渲染器确实在读 skill 资源（≥ 5 处）', assetReads >= 5, `${assetReads} 处`);

console.log('');
console.log(fail === 0 ? `结果：通过 ${pass} / 失败 0` : `结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
