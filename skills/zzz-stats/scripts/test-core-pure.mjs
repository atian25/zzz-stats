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
 * 同理，「图标资产齐全」也没有保证：少一张 png 不会报错，构建时那个图标静默退到
 * 占位图，图上出现灰方块，看着像数据问题。
 *
 * 所以这里把几条最容易静默漂移的约束钉成断言：
 *
 *   1. core.js 里不许出现 Node 专属符号（node: / process. / Buffer / require( /
 *      __dirname / import.meta / fs.）
 *   2. core.js 能被当作 ESM 加载，且导出的入口齐全
 *   3. 粘贴面板（app.html / app.js）与它的静态副本确实已删除
 *   4. icons/ 下的图标资产齐全，每个 png 都能算出 16 位 sha1 key
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
import { computeReport } from '../assets/report/core.js';
import { cssVarBlock, textSubs } from './template-tokens.mjs';

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
  ['textSubs', textSubs]]) {
  ok(`${name} 是函数`, typeof fn === 'function');
}

// ------------------------------------------------- 3. 粘贴面板的兼容入口确实删干净

console.log('3. 浏览器粘贴面板（app.html / app.js）已删除');
/*
 * 上一版有个「把采集 JSON 粘贴/拖进静态页」的入口，用户明确否掉了这个方向
 * （他原话是「我不要粘贴，还是之前 skill 那套流程」）。用户要求「直接删掉，
 * 不要留兼容入口」，所以这里把「删掉了」本身钉成断言 ——
 * 只删文件不留痕迹是记不住的，下一轮很容易有人「顺手」把它加回来。
 *
 * 判据是**文件不存在**，不是「目录里搜不到引用」：留着文件但没人用，
 * 下一个人会以为它还该维护。
 */
for (const gone of ['app.html', 'app.js']) {
  ok(`${gone} 已删除`, !existsSync(join(REPORT_DIR, gone)), '用户要求删掉，不要留兼容入口');
}
/* 这两份是粘贴面板的静态副本，唯一消费者就是 app.js，一起删 */
for (const gone of ['config.json', 'icons/manifest.json']) {
  ok(`${gone} 已删除`, !existsSync(join(REPORT_DIR, gone)), '粘贴面板的静态副本，随它一起删');
}
ok('build-icons-manifest.mjs 已删除', !existsSync(join(SKILL_DIR, 'scripts/build-icons-manifest.mjs')));

// ---------------------------------------------------------------- 4. 图标资产完整

console.log('4. icons/ 下的图标资产齐全（产物内嵌时逐个编码）');
/*
 * 粘贴面板靠 `icons/manifest.json` 查 key，那份清单已随面板删除。
 * 但图标文件本身仍是构建期的输入（产物把它们编码成 dataURL 内嵌），
 * 所以这里改成直接对着目录断言：**每个 png 都能被 sha1 算出 key**。
 *
 * 漏一项的后果不是报错，而是构建时那个图标静默退到占位图 ——
 * 图上出现灰方块，看着像数据问题。
 */
{
  const { readdirSync } = await import('node:fs');
  const files = [];
  for (const dir of ['avatars', 'items']) {
    const d = join(REPORT_DIR, 'icons', dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.endsWith('.png')) files.push(`${dir}/${f.slice(0, -4)}`);
  }
  ok(`icons/ 下有 ${files.length} 个 png`, files.length > 100);
  ok('占位图 items/_fallback.png 在', files.includes('items/_fallback'));
  const hashed = files.map((key) => {
    const buf = readFileSync(join(REPORT_DIR, 'icons', `${key}.png`));
    return createHash('sha1').update(buf).digest('hex').slice(0, 16);
  });
  ok('每个 png 都能算出 16 位 sha1 key', hashed.every((h) => /^[0-9a-f]{16}$/.test(h)));
}

// ---------------------------------------------------------------- 5. 两端只差 icons 的值

console.log('5. 无效 resolver 不影响除 icons 外的任何字段');
const cfgSrc = readFileSync(join(SKILL_DIR, 'config/report.json'), 'utf8');
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

// ------------------------------------------ 7. 产物内嵌用的转换（core-inline.mjs）

console.log('7. core-inline：ESM → 经典同步脚本的转换');
/*
 * 这段转换是产物的命门：转错了，产物里那段脚本要么语法错误、要么把 `export` 留在里面
 * （浏览器按经典脚本解析 → SyntaxError → 全白），而 Node 端 `import core.js` 一切正常。
 * 所以它必须有自己的断言，不能只靠「构建一次、肉眼看看」。
 */
const {
  PAYLOAD_ID, escapeJsonForScript, stripExports, buildCorePlusBoot, checkInlinedScript,
} = await import('./core-inline.mjs');

ok('PAYLOAD_ID 是个合法 id', /^[a-z][a-z0-9-]*$/.test(PAYLOAD_ID), PAYLOAD_ID);

ok('剥掉 export 前缀', stripExports('export function a() {}\nexport function b() {}') === 'function a() {}\nfunction b() {}', '');
ok('非 function 的 export 直接抛错（不静默留半份 ESM）', (() => {
  try { stripExports('export const x = 1;'); return false; } catch { return true; }
})());
ok('注释里的 export 不被误删', stripExports('// export foo\nexport function a() {}').startsWith('// export foo'));

/*
 * 转义是「数据里出现 </script 会不会截断脚本」的唯一防线。
 * 用一条真的含 `</script>` 的字符串验，而不是只查函数里有没有 replace 这个词。
 */
const nasty = JSON.stringify({ nickname: 'A</script><b>B', sep: 'x\u2028y' });
const escaped = escapeJsonForScript(nasty);
ok('转义后没有裸的 </script', !/<>\/script/i.test(escaped) && !escaped.includes('</script'));
ok('转义后仍能被 JSON.parse 还原', JSON.parse(escaped).nickname === 'A</script><b>B');
ok('\u2028 也被转义（JS 的行终止符）', !escaped.includes('\u2028'));

/*
 * 真跑一次转换：喂真的 core.js 和真的配置，断言产出的那段脚本能通过形状自检。
 * 这比「拼个小字符串试试」强：真实源码里有什么（注释里的反引号、正则里的斜杠）
 * 只有真跑一遍才知道。
 */
const repoCfg = JSON.parse(readFileSync(join(SKILL_DIR, 'config/report.json'), 'utf8'));
const built = buildCorePlusBoot({
  coreSource: readFileSync(join(REPORT_DIR, 'core.js'), 'utf8'),
  config: repoCfg,
  iconIds: { 'avatars/1021': 'deadbeefdeadbeef', 'items/_fallback': 'ffff0000ffff0000' },
  iconData: { deadbeefdeadbeef: 'data:image/png;base64,AA==' },
  generatedAt: 'FIXED',
});
ok('转换结果能通过形状自检', checkInlinedScript(built).length === 0, checkInlinedScript(built).slice(0, 2).join('；'));
ok('转换结果里有 computeReport 的定义', built.includes('function computeReport('));
ok('转换结果里没有 import', !/^\s*import\s/m.test(built) && !built.includes('import('));
ok('转换结果是同步的（没有 await）', !/\bawait\b/.test(built.replace(/\/\*[\s\S]*?\*\//g, '')));
ok('转换结果会挂 window.__REPORT__', built.includes('window.__REPORT__ = out.report'));
ok('配置被内嵌（不是运行时 fetch）', built.includes(JSON.stringify(repoCfg.colors.accent)));
ok('图标索引与图标数据都内嵌了', built.includes('ICON_IDS') && built.includes('ICON_DATA'));
ok('转换结果里不含任何 /*__ 占位符', !/\/\*__/.test(built));

// 负向：把 export 留在里面，自检必须报错（否则这条自检等于没写）
ok('自检能抓到残留的 export', checkInlinedScript('export function computeReport(){}; window.__REPORT__ = out.report;').length > 0);
ok('自检能抓到裸的 </script', checkInlinedScript('var a = 1;\n</script>').length > 0);

// ---------------------------------------------------------------- 结果

console.log('');
console.log(fail === 0 ? `结果：通过 ${pass} / 失败 0` : `结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
