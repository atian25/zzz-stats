#!/usr/bin/env node
/**
 * 渲染层契约：`buildReport()` 收 Map 与收普通对象必须等价，
 * 以及「采集进 `packages/sdk/`、渲染留 `skills/zzz-stats/scripts/`」这条目录边界。
 *
 * ## 为什么这套留在 skill 里，而不是跟采集测试一起进 `packages/sdk/test/`
 *
 * 它**同时要看两个目录**：`packages/sdk/`（采集）+ `skills/zzz-stats/scripts/`（渲染），
 * 还要读 `config/report.json` 与 `fixtures/`。从仓库层级看最合理。
 * 采集层那份（`packages/sdk/test/test-sdk-transport.mjs`）刻意不读 skill 目录，
 * 所以它能跟着 `packages/sdk/` 单独走。
 *
 * ## 两段断言
 *
 *   1. `buildReport({files})` 收 Map 与收普通对象，产出逐字节相同
 *   2. 目录边界：采集层不碰 skill 资源，渲染器相反
 *
 * 不需要浏览器、不联网。
 *
 * 跑法：node skills/zzz-stats/test/test-render-contract.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, '..');
/*
 * 边界那一段要同时看 SDK 与 skill/scripts，所以需要仓库根。
 * SDK 在仓库根的 `packages/sdk/`，**不在 skill 里** —— 别从 skill 内部反推它的位置。
 */
const REPO_DIR = resolve(SKILL_DIR, '..', '..');
const SDK_DIR = join(REPO_DIR, 'packages/sdk');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
};

console.log('1. buildReport 收 Map 与收普通对象，产出必须相同');
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
  /* 报表渲染器在 skill 的 scripts（不在 packages/sdk），它自己定位资源，不用注入 */
  const build = await import('../scripts/build.mjs');
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

// ------------------------------------------------ 2. 目录边界：采集与报表分属两边

/*
 * 用户拍板的结构：`packages/sdk/` **只放采集**，出报表的留在 `skills/zzz-stats/scripts/`。
 * 判据是「它依赖 skill 资源吗」—— `build.mjs` 有 9 处读 `assets/report/**` 与
 * `assets/vendor/**`，它是**这份报表的渲染器**，不是通用 SDK。
 *
 * 这条很容易被「顺手都搬进 packages 更整齐」带回去，带回去的代价是：
 * 要么渲染器到处 404，要么再加一整套资源注入参数（把耦合换个地方而已）。
 * 所以钉成断言。
 */
console.log('');
console.log('2. 目录边界：packages/sdk 只放采集，报表渲染器留 skill/scripts');

const sdkIndex = await import('../../../packages/sdk/index.mjs');
ok('packages/sdk 导出采集主入口 collectData', typeof sdkIndex.collectData === 'function');

/*
 * **读源码文本，不 import 那个模块。**
 *
 * 试过从 `packages/sdk/index.mjs` 导出一个 `buildReport` 做反向验证 —— 结果用例在
 * **模块解析期**就崩了、退出码 1，但一条断言都没跑（`build.mjs` 静态 `import
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

const skillLib = await import('../scripts/index.mjs');
ok('skill/scripts 导出 buildReport', typeof skillLib.buildReport === 'function');
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
const buildSrc = readFileSync(join(SKILL_DIR, 'scripts/build.mjs'), 'utf8');
ok('报表渲染器用 SKILL_DIR 自己定位资源', /const SKILL_DIR = resolve\(HERE, '\.\.'\)/.test(buildSrc));
const assetReads = (buildSrc.match(/join\(SKILL_DIR/g) || []).length;
ok('报表渲染器确实在读 skill 资源（≥ 5 处）', assetReads >= 5, `${assetReads} 处`);

console.log('');
console.log(fail === 0 ? `结果：通过 ${pass} / 失败 0` : `结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
