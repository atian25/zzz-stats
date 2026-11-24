#!/usr/bin/env node
/**
 * core.js 的纯度与两端一致性用例。
 *
 * ## 为什么需要这套用例
 *
 * 「核心是纯 JS」这件事没有任何编译期保证：往 core.js 里写一句 `readFileSync`
 * 或 `process.cwd()`，**Node 端照样跑得通**（那边本来就在 Node 里），
 * 只有浏览器端会白屏 —— 而浏览器端白屏的症状是「页面一片空白、console 干净」，
 * 最容易被人当成「还没加载完」。
 *
 * 同理，「静态副本与源一致」也没有保证：改了 `config/report.json` 忘了重跑
 * `build-icons-manifest.mjs`，命令行产物是新配色、静态页是旧配色，两边都「看起来正常」。
 *
 * 所以这里把几条最容易静默漂移的约束钉成断言：
 *
 *   1. core.js 里不许出现 Node 专属符号（node: / process. / Buffer / require( /
 *      __dirname / import.meta / fs.）
 *   2. core.js 能被当作 ESM 加载，且导出的入口齐全
 *   3. `assets/report/config.json` 与 `config/report.json` 逐字节相同
 *   4. `icons/manifest.json` 与 icons/ 下实际文件的 sha1 逐条相同
 *   5. Node 端与浏览器端算出的 report 只差 `icons` 的值（这一条靠一个 fake icons 复算）
 *   6. charts.js 没有被打包进 core（它是渲染层，core 不该依赖它）
 *
 * 不需要浏览器、不联网。跑法：
 *   node skills/zzz-stats/scripts/test-core-pure.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeReport, cssVarBlock, textSubs, filesFromInPage, metaFromInPage } from '../assets/report/core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, '..');
const REPORT_DIR = join(SKILL_DIR, 'assets/report');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- 1. 纯度

console.log('1. core.js 不含 Node 专属符号');
const coreSrc = readFileSync(join(REPORT_DIR, 'core.js'), 'utf8');
/*
 * 注释里出现这些词是**允许且必要的**（文件头就在讲「不许出现 node: import」）。
 * 所以先剥注释再检查，否则文档会把自己的断言判红。
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = stripComments(coreSrc);
for (const [label, re] of [
  ["import 'node:'", /from\s+['"]node:/],
  ['process.', /\bprocess\s*\./],
  ['Buffer', /\bBuffer\b/],
  ['require(', /\brequire\s*\(/],
  ['__dirname', /\b__dirname\b/],
  ['__filename', /\b__filename\b/],
  ['import.meta', /\bimport\.meta\b/],
]) {
  ok(`无 ${label}`, !re.test(code), `匹配到 ${String(code.match(re)?.[0] ?? '')}`);
}
// readFileSync 之类只在带了 fs 前缀时才致命；裸出现同样是 Node API
for (const api of ['readFileSync', 'writeFileSync', 'existsSync', 'readdirSync', 'createHash']) {
  ok(`无 ${api}`, !code.includes(api));
}

// ---------------------------------------------------------------- 2. 入口齐全

console.log('2. 导出的入口齐全');
for (const [name, fn] of [['computeReport', computeReport], ['cssVarBlock', cssVarBlock],
  ['textSubs', textSubs], ['filesFromInPage', filesFromInPage], ['metaFromInPage', metaFromInPage]]) {
  ok(`${name} 是函数`, typeof fn === 'function');
}

// ---------------------------------------------------------------- 3. 静态配置副本

console.log('3. assets/report/config.json 与 config/report.json 一致');
const cfgSrc = readFileSync(join(SKILL_DIR, 'config/report.json'), 'utf8');
const cfgCopy = join(REPORT_DIR, 'config.json');
ok('副本存在', existsSync(cfgCopy));
if (existsSync(cfgCopy)) {
  ok('内容逐字节相同', readFileSync(cfgCopy, 'utf8') === cfgSrc,
    '跑 node scripts/build-icons-manifest.mjs 重新生成');
}

// ---------------------------------------------------------------- 4. 图标清单

console.log('4. icons/manifest.json 与实际图标文件一致');
const manifestPath = join(REPORT_DIR, 'icons/manifest.json');
ok('清单存在', existsSync(manifestPath));
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let bad = 0;
  let checked = 0;
  for (const [key, hash] of Object.entries(manifest)) {
    const p = join(REPORT_DIR, 'icons', `${key}.png`);
    if (!existsSync(p)) { bad += 1; continue; }
    const actual = createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 16);
    checked += 1;
    if (actual !== hash) bad += 1;
  }
  ok(`全部 ${checked} 项 sha1 匹配`, bad === 0, `${bad} 项不匹配`);
  /*
   * 清单必须覆盖 icons/ 下所有 png。漏一项的后果不是报错，而是浏览器端那个图标
   * 静默退到占位图 —— 图上出现灰方块，看着像数据问题。
   */
  const { readdirSync } = await import('node:fs');
  const files = [];
  for (const dir of ['avatars', 'items']) {
    const d = join(REPORT_DIR, 'icons', dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.endsWith('.png')) files.push(`${dir}/${f.slice(0, -4)}`);
  }
  const missing = files.filter((f) => !(f in manifest));
  ok(`清单覆盖全部 ${files.length} 个 png`, missing.length === 0, `漏 ${missing.slice(0, 5).join(',')}`);
}

// ---------------------------------------------------------------- 5. 两端只差 icons 的值

console.log('5. 无效 resolver 不影响除 icons 外的任何字段');
const cfg = JSON.parse(cfgSrc);
/*
 * 用一份极小的合成数据跑一遍：只为了证明「icons 的取值方式不影响口径结果」。
 * 拿 fixtures 跑会更慢，而这条断言的目的是「icons 是纯外挂」，小数据足够。
 */
const tinyFiles = {
  'index.json': {
    retcode: 0,
    data: {
      type_stats: [
        { gacha_type: 'GACHA_TYPE_CHARACTER_UP', total_count: 10, s_count: 1, up_count: 1, next_s_cur_times: 0, avr_up_count: 10, has_data_vers: ['1.0'] },
      ],
      total_gacha_count: 10,
      total_s_count: 1,
      cur_ver: '1.0',
    },
  },
  'meta.json': { uid: '10000001', nickname: '测试', synthetic: true, region: 'prod_gf_cn' },
  'cur_pool_stat_2.json': {
    retcode: 0,
    data: {
      list: [{
        version: '1.0', gacha_type: '2',
        cur_records: [{ sort: '1', count: '10', record_time: '1700000000', item_id: '1021', name: '测试角色', item_type: 'ItemType_Avatar', is_up: true, rarity: 'S' }],
      }],
    },
  },
};
const withNull = computeReport({ files: tinyFiles, cfg, generatedAt: 'FIXED' }).report;
const withKeys = computeReport({
  files: tinyFiles,
  cfg,
  generatedAt: 'FIXED',
  icons: { encode: (dir, id) => `${dir}/${id}`, resolveId: (id) => `avatars/${id}` },
}).report;

/**
 * 剔除**所有图标字段**后再比：`icons` 本体、以及结构上的 `avatarKey` / `iconKey`。
 *
 * 这三处就是「图标在数据里的全部入口」。把它们剔掉之后剩下的必须逐字节相同 ——
 * 如果不同，说明 icons resolver 影响了口径（那是真正的 bug，不是允许的差异）。
 * 第一版断言只剔了 `icons`，把 `avatarKey` 漏在外面，于是这条永远红：
 * 断言本身写错了，不是代码错了。
 */
const stripIcons = (r) => {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'icons' || k === 'avatarKey' || k === 'iconKey') continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(r));
};
ok('两种 resolver 下除图标字段外逐字节相同', stripIcons(withNull) === stripIcons(withKeys));
ok('无 resolver 时 icons 为空对象', JSON.stringify(withNull.icons) === '{}');
ok('无 resolver 时 avatarKey 为 null', withNull.charts[0].rounds[0].avatarKey === null);
ok('有 resolver 时 key 被贴上', withKeys.charts[0].rounds[0].avatarKey === 'avatars/1021',
  String(withKeys.charts[0].rounds[0].avatarKey));

// ---------------------------------------------------------------- 6. 渲染层不进 core

console.log('6. 渲染层没有混进 core');
ok('core.js 不引用 charts.js', !code.includes('charts.js'));
ok('core.js 不碰 document', !/\bdocument\s*\./.test(code));
ok('core.js 不碰 window.', !/\bwindow\s*\./.test(code));

// ---------------------------------------------------------------- 7. 虚拟文件系统的摊平

console.log('7. filesFromInPage 摊平');
const flat = filesFromInPage({
  index: { a: 1 },
  channels: { 2: { curPoolStat: { x: 1 }, histPoolStat: { y: 2 } }, 3: { curPoolStat: { z: 3 } } },
});
ok("index.json 在", JSON.stringify(flat['index.json']) === '{"a":1}');
ok("cur_pool_stat_2.json 在", JSON.stringify(flat['cur_pool_stat_2.json']) === '{"x":1}');
ok("hist_pool_stat_2.json 在", JSON.stringify(flat['hist_pool_stat_2.json']) === '{"y":2}');
ok("cur_pool_stat_3.json 在", JSON.stringify(flat['cur_pool_stat_3.json']) === '{"z":3}');
ok("缺 hist 时不伪造键", !('hist_pool_stat_3.json' in flat));
ok('空 payload 返回空对象', JSON.stringify(filesFromInPage(null)) === '{}');

// ---------------------------------------------------------------- 8. meta 推导

console.log('8. metaFromInPage 与落盘口径一致');
const derived = metaFromInPage({
  uid: '10000001', region: 'prod_gf_us', server: 'os', nickname: 'X',
  fetchedAt: '2026-01-01T00:00:00.000Z',
  index: { data: { type_stats: [{ has_data_vers: ['1.0', '2.1', '2.0'] }], total_gacha_count: 5, total_s_count: 1 } },
});
ok('uid 透传', derived.uid === '10000001');
ok('region 透传', derived.region === 'prod_gf_us');
ok('server 透传', derived.server === 'os');
ok('昵称透传', derived.nickname === 'X');
ok('采集时间透传', derived.fetched_at === '2026-01-01T00:00:00.000Z');
ok('版本区间按降序写「低 → 高」', derived.versions === '1.0 → 2.1', String(derived.versions));
ok('总抽数透传', derived.total_gacha_count === 5);
ok('总金数透传', derived.total_s_count === 1);

// ---------------------------------------------------------------- 结果

console.log('');
console.log(fail === 0 ? `结果：通过 ${pass} / 失败 0` : `结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
