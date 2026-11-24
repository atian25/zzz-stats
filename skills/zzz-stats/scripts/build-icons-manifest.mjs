#!/usr/bin/env node
/**
 * 生成 `assets/report/config.json` 与 `assets/report/icons/manifest.json`。
 *
 * ## 为什么需要这一步
 *
 * 浏览器外壳（`app.html`）是纯静态页：它拿不到 `config/report.json`
 * （在 skill 根的 `config/` 下，不在 `assets/report/` 里，且静态服务不一定把整个 skill 目录
 * 暴露出去），也没有文件系统去算图标 sha1。所以这两样东西要**预先落成静态文件**。
 *
 * ## config.json：复制，不是手工维护
 *
 * 它是 `config/report.json` 的**逐字节副本**。手工维护必飘（改配色只改一处、
 * 另一处还是旧值，而症状是「命令行出的图是新配色、网页上是旧配色」）。
 * 用例 `test-core-pure.mjs` 会断言两者仍然相同，不同就退 1。
 *
 * ## icons/manifest.json：`{ "dir/id": "<sha1 前 16 位>" }`
 *
 * 浏览器端要用**和 Node 端相同的 key**（charts.js 的 `ICONS[key]` 只认字符串 key）。
 * Node 端的 key 是图标文件内容的 sha1 前 16 位（见 build-report.mjs 的 makeIconResolver），
 * 所以这里用完全相同的算法生成一张静态对照表；浏览器端拿它查 key，值换成静态 png 路径。
 *
 * 这样 `report.icons` 在两端**键集完全一致**，只有值不同（dataURL vs 路径）——
 * 等价性验收允许的差异就只有这一项。
 *
 * 用法：
 *   node skills/zzz-stats/scripts/build-icons-manifest.mjs          # 生成/更新
 *   node skills/zzz-stats/scripts/build-icons-manifest.mjs --check  # 只校验是否最新（CI 用）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wantsHelp, printHelp } from './cli-help.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, '..');
const REPORT_DIR = join(SKILL_DIR, 'assets/report');
const ICONS_DIR = join(REPORT_DIR, 'icons');
const CONFIG_SRC = join(SKILL_DIR, 'config/report.json');
const CONFIG_OUT = join(REPORT_DIR, 'config.json');
const MANIFEST_OUT = join(ICONS_DIR, 'manifest.json');

if (wantsHelp()) {
  printHelp('build-icons-manifest', {
    summary: '把 config/report.json 与图标清单落成静态文件，供浏览器外壳读取',
    options: [
      { flag: '--check', desc: '只校验是否与源一致（不改文件），不一致退出 1' },
      { flag: '--help, -h', desc: '打印本帮助后退出' },
    ],
    notes: [
      '改了 config/report.json 或 icons/ 之后要重跑本脚本，否则浏览器外壳读到的是旧值。',
      'test-core-pure.mjs 会断言静态副本仍与源一致。',
    ],
  });
}

const CHECK = process.argv.slice(2).includes('--check');

/** 目录下的 png，按文件名排序 —— 排序保证输出稳定，只有内容变了文件才会变。 */
function listPng(dir) {
  const p = join(ICONS_DIR, dir);
  if (!existsSync(p)) return [];
  return readdirSync(p).filter((f) => f.endsWith('.png')).sort();
}

const manifest = {};
for (const dir of ['avatars', 'items']) {
  for (const f of listPng(dir)) {
    const buf = readFileSync(join(ICONS_DIR, dir, f));
    manifest[`${dir}/${f.slice(0, -4)}`] = createHash('sha1').update(buf).digest('hex').slice(0, 16);
  }
}
const manifestText = `${JSON.stringify(manifest, null, 1)}\n`;
const configText = readFileSync(CONFIG_SRC, 'utf8');

if (CHECK) {
  const problems = [];
  if (!existsSync(MANIFEST_OUT)) problems.push(`缺 ${MANIFEST_OUT}`);
  else if (readFileSync(MANIFEST_OUT, 'utf8') !== manifestText) problems.push('icons/manifest.json 与 icons/ 不一致');
  if (!existsSync(CONFIG_OUT)) problems.push(`缺 ${CONFIG_OUT}`);
  else if (readFileSync(CONFIG_OUT, 'utf8') !== configText) problems.push('assets/report/config.json 与 config/report.json 不一致');
  if (problems.length) {
    console.error('✖ 静态副本过期：');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('  → 跑一次 node skills/zzz-stats/scripts/build-icons-manifest.mjs');
    process.exit(1);
  }
  console.log(`✅ 静态副本与源一致（${Object.keys(manifest).length} 个图标）`);
  process.exit(0);
}

writeFileSync(MANIFEST_OUT, manifestText);
writeFileSync(CONFIG_OUT, configText);
console.log(`图标清单 → ${MANIFEST_OUT}（${Object.keys(manifest).length} 项）`);
console.log(`配置副本 → ${CONFIG_OUT}（${configText.length} 字节）`);
