/**
 * 把 ESM 的 `core.js` 转换成**经典同步脚本**里可以内嵌的形式。
 *
 * ## 为什么需要这一步
 *
 * `core.js` 是 ESM（`export function computeReport(...)`），Node 外壳直接 `import` 它。
 * 但产物里的口径计算必须是**经典同步脚本**：
 *
 *   <script type="application/json">原始采集 JSON</script>
 *   <script>core（换算过）+ 引导 → window.__REPORT__</script>
 *   <script>charts.js</script>
 *
 * 一旦换成 `<script type="module">` 或 `await import()`，脚本就变成**异步执行**，
 * `charts.js` 会在 `__REPORT__` 还没赋值时先跑起来——它的第一行 `if (!R) return`
 * 静默退出，页面一片空白、console 干净。`screenshot.mjs` 只等
 * `DOMContentLoaded + setTimeout(0)`，4 套用例也都在这个时机读页面，
 * 异步化会让它们间歇性扑空，且极难定位（真实踩过一次，见 report-rules.md §6.8）。
 *
 * ## 为什么不在 core.js 里写 UMD / CJS
 *
 * 那会破坏已经验收过的一条性质：**Node 与浏览器加载同一份字节**。
 * core.js 保持纯 ESM，转换只发生在**构建期**，转换规则本身可以单测
 * （`test-core-pure.mjs` 断言转换后 `export ` 出现 0 次、且能取到 `computeReport`）。
 *
 * ## 转换规则（写死在这里，不要在别处再写一份）
 *
 *   1. 顶层 `export function foo(` → `function foo(`。core.js 只有这一种 export 形式，
 *      多一种就当场报错，而不是静默留下半份 ESM。
 *   2. 整段包进 IIFE（`'use strict'`），避免污染产物页面的全局作用域。
 *   3. IIFE 末尾调用 `computeReport(...)` 并把结果挂到 `window.__REPORT__`。
 *   4. 所有注入的 JSON（配置、图标索引、时间戳）都做 `</script` / 行分隔符转义。
 */

/**
 * 产物里存原始采集 JSON 的那个 `<script>` 的 id。
 *
 * 模板、构建脚本、用例三处都读这个常量 —— 各写一份字符串必然漂移，
 * 漂移的症状是「模板里 id 改了、引导脚本还找旧 id」→ `document.getElementById` 返回 null
 * → 抛错 → 页面空白，但构建是绿的。
 */
export const PAYLOAD_ID = 'zzz-stats-payload';

/**
 * 把 JSON 文本塞进 HTML 的 `<script>` 里时做的转义。
 *
 * **必须转义 `<`**：数据里只要出现 `</script`，HTML 解析器就会在那里截断脚本，
 * 后面的代码变成可见文本。昵称、角色名都是外部输入，不能假设干净。
 * `\u003c` 在 JSON 里与 `<` 等价，`JSON.parse` 读回来一字不差。
 *
 * `\u2028` / `\u2029` 是 JS 的**行终止符**：在 `<script type="application/json">`
 * 里无害（那不当 JS 解析），但同一份 JSON 也会嵌进可执行脚本（配置、图标表），
 * 那里不转义会让脚本变成语法错误。统一转掉，两处共用一份实现。
 */
export function escapeJsonForScript(json) {
  return String(json)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 剥掉 `export ` 前缀。
 *
 * 只认 `export function`（core.js 的 export 形式就是这个）。
 * 出现别的 export 形式时**直接抛错**：静默留下半份 ESM 的后果是产物里
 * `<script>` 语法错误、页面全白，而构建日志照样打印「成功」。
 */
export function stripExports(src) {
  const text = String(src);
  const other = text.match(/^\s*export\s+(?!function\s)/gm);
  if (other) {
    throw new Error(`core.js 里有不认识的 export 形式：${other.map((s) => s.trim()).join(', ')}`);
  }
  return text.replace(/^export function /gm, 'function ');
}

/**
 * 生成产物里的第 ② 段脚本：热线（core 源码）+ 引导。
 *
 * @param {object} opts
 * @param {string} opts.coreSource   core.js 原文（ESM）
 * @param {object} opts.config       config/report.json 的解析结果
 * @param {object} opts.iconIds      `{ "avatars/1021": "<sha1 前 16 位>" }`，与 Node 端同一份
 * @param {object} opts.iconData     `{ "<sha1>": "data:image/png;base64,…" }`，只含被引用的图标
 * @param {string} opts.generatedAt  构建时间戳（固定值，保证产物可复现）
 * @returns {string} 可直接放进 `<script>` 的源码
 */
export function buildCorePlusBoot({ coreSource, config, iconIds, iconData, generatedAt }) {
  const core = stripExports(coreSource).trimEnd();
  const json = (v) => escapeJsonForScript(JSON.stringify(v));
  /*
   * 这里用**数组拼接**而不是模板字符串：拼进去的是一段 JS 源码，
   * 注释里天然会出现反引号（比如 `report.icons`），模板字符串会被它们截断，
   * 报出来的还是「SyntaxError: Unexpected identifier」这种指不到根因的错。
   */
  return [
    '(function () {',
    "'use strict';",
    core,
    '',
    '/*',
    ' * 引导：读上面那块 application/json → 调 computeReport → 挂 window.__REPORT__。',
    ' *',
    ' * 图标解析器与 Node 外壳逐条对齐：',
    ' *   encode(dir, id)  → 该 id 的 sha1；查不到就把 key 设成 null（Node 端同）',
    ' *   resolveId(id)    → 先 avatars 再 items，都没有再试 _fallback（Node 端同）',
    ' * core 只认「key 字符串」，所以 charts.js 的 ICONS[key] 一行都不用改。',
    ' */',
    'var PAYLOAD_ID = ' + JSON.stringify(PAYLOAD_ID) + ';',
    'var CONFIG = ' + json(config) + ';',
    'var ICON_IDS = ' + json(iconIds) + ';',
    'var ICON_DATA = ' + json(iconData) + ';',
    'var GENERATED_AT = ' + JSON.stringify(String(generatedAt)) + ';',
    'var FALLBACK = Object.prototype.hasOwnProperty.call(ICON_IDS, "items/_fallback")',
    '  ? ICON_IDS["items/_fallback"]',
    '  : null;',
    '',
    'var node = document.getElementById(PAYLOAD_ID);',
    'if (!node) throw new Error("产物里找不到 #" + PAYLOAD_ID + "：模板与构建脚本的占位符对不上");',
    '',
    'var icons = {',
    '  encode: function (dir, id) {',
    '    var key = dir + "/" + id;',
    '    return Object.prototype.hasOwnProperty.call(ICON_IDS, key) ? ICON_IDS[key] : FALLBACK;',
    '  },',
    '  resolveId: function (id) {',
    '    if (Object.prototype.hasOwnProperty.call(ICON_IDS, "avatars/" + id)) return ICON_IDS["avatars/" + id];',
    '    if (Object.prototype.hasOwnProperty.call(ICON_IDS, "items/" + id)) return ICON_IDS["items/" + id];',
    '    return FALLBACK;',
    '  },',
    '};',
    '',
    'var out = computeReport({',
    '  files: JSON.parse(node.textContent),',
    '  cfg: CONFIG,',
    '  icons: icons,',
    '  generatedAt: GENERATED_AT,',
    '});',
    '/*',
    ' * core 只把图标 key 贴到结构上，report.icons 本体由调用方填',
    ' * （core 不知道图标是 dataURL 还是路径）。这里填的表和 Node 外壳填的是同一张。',
    ' */',
    'out.report.icons = ICON_DATA;',
    'window.__REPORT__ = out.report;',
    '})();',
    '',
  ].join('\n');
}

/**
 * 构建期自检：转换结果必须满足的硬条件。
 *
 * 返回**问题列表**（空数组 = 通过），由调用方决定是 fatal 还是警告。
 * 之所以放在这里而不是只写在构建脚本里：这些条件是「产物一定坏」的判定，
 * 而它们本身可以被单测覆盖（不需要真的构建一次）。
 *
 * @param {string} script `buildCorePlusBoot()` 的返回值
 * @returns {string[]}
 */
export function checkInlinedScript(script) {
  const problems = [];
  // 注释里出现 "export" 不致命（core.js 的文件头就在讲这件事），剥掉注释再查
  const code = String(script)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const leftover = code.match(/^\s*export\s+/gm);
  if (leftover) problems.push(`转换后仍有 ${leftover.length} 处 export：${leftover[0].trim()}`);
  if (!/\bfunction\s+computeReport\s*\(/.test(code)) {
    problems.push('转换后取不到 computeReport 函数');
  }
  if (!/window\.__REPORT__\s*=\s*out\.report/.test(code)) {
    problems.push('引导没有把结果挂到 window.__REPORT__');
  }
  if (/\bimport\s*\(/.test(code) || /^\s*import\s+/m.test(code)) {
    problems.push('转换后仍有 import：脚本会变成异步，charts.js 会先于 __REPORT__ 执行');
  }
  if (/\bawait\b/.test(code)) {
    problems.push('转换后出现 await：同理会破坏同步执行顺序');
  }
  /*
   * 数据里若出现 `</script`，HTML 解析器会在那里截断脚本。
   * 转义之后源码里不该再有裸的 `</script`（大小写不敏感）。
   */
  if (/<\/script/i.test(script)) {
    problems.push('内嵌脚本里出现裸的 </script：HTML 解析器会截断，必须转义成 \\u003c/script');
  }
  return problems;
}
