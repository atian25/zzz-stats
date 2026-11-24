/**
 * 模板占位符的填充值：CSS 变量块、文案表、HTML 转义。
 *
 * ## 为什么是「构建期」而不是「运行时」
 *
 * 产物是**构建期拼好的静态 HTML**：`<style>` 里的 CSS 变量、`<span>` 里的标题文案
 * 在 Node 生成文件时就已经落地。浏览器只跑两件事——core 算 `__REPORT__`、charts.js 渲染，
 * 它既不改样式表也不做文案替换。所以这几个函数只有 Node 外壳一个调用方。
 *
 * 历史：拆 core 那一轮把它们放进了 `core.js`，理由是「Node 与浏览器两端都要用」。
 * 那个理由成立的前提是存在一个**运行期**的浏览器外壳（会自己拼 DOM、自己写 `<style>`）。
 * 产物内嵌方案把这个外壳整个去掉了，前提随之消失，而副作用留下了：
 * 这些函数的 token 字面量（`'/*__COPY_CHART_TITLE__*\/'`）会随 core 源码一起
 * 内嵌进产物，于是「产物里不许残留 `/*__` 占位符」这条断言永远命中自己。
 *
 * 所以它们搬到这里：**只注入值，不注入占位符**。
 */

/**
 * 配置 → CSS 变量的 `:root { ... }` 块。
 *
 * 「改配色只改 config」是这份 skill 对外的承诺，但主色 / 歪章色 / 详情条色过去在
 * charts.css 里各写了一份硬编码，改配置纹丝不动。这里把颜色统一灌进 CSS 变量：
 *   --accent / --loss-stamp / --detail-good / --detail-bad / --ink-*
 */
export function cssVarBlock(cfg) {
  const vars = {
    accent: cfg.colors.accent,
    lossStamp: cfg.colors.lossStamp,
    detailGood: cfg.colors.detailGood,
    detailBad: cfg.colors.detailBad,
    extremeTop: cfg.colors.extreme?.top,
    goodTop: cfg.colors.good?.top,
    badTop: cfg.colors.bad?.top,
  };
  const pairs = Object.entries(vars)
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `  --${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${v};`);
  return pairs.length ? `:root {\n${pairs.join('\n')}\n}\n` : '';
}

/**
 * 模板里的文案占位符 → 实际文案。
 *
 * 文案一律从配置来：过去 copy.chartTitle / detailTitle / mergeToggle 有定义没人读，
 * 改配置不生效。
 */
export function textSubs(cfg) {
  return {
    '/*__COPY_CHART_TITLE__*/': cfg.copy.chartTitle ?? '抽卡总览',
    '/*__COPY_DETAIL_TITLE__*/': cfg.copy.detailTitle ?? '抽卡详情',
    // 右栏标题和「抽卡详情」并列在头部，由模板输出（不是 charts.js 画的）
    '/*__COPY_DETAIL_CHARS_TITLE__*/': cfg.copy.detailCharsTitle ?? '代理人汇总',
    '/*__COPY_MERGE_TOGGLE__*/': cfg.copy.mergeToggle ?? '真实抽数',
    /*
     * `copy.detailFilterEmpty`（「当前版本筛选下没有记录」）**不在这里**。
     *
     * 它是 charts.js 运行时自己读 `CFG.copy.detailFilterEmpty` 渲染的空态文案
     * （见 charts.js 里 `el('div', 'detail-empty', ...)` 那行），模板里从来没有它的占位符。
     * 上一版把它也放进 textSubs 是死条目：替换永远命中不到任何东西。
     *
     * 留着它的代价是真实的：构建期的「占位符双向闭环」会要求模板里必须有这个占位符，
     * 于是每次构建都报一条假 fatal。**删掉这条，不是删掉功能** ——
     * 文案仍然生效，走的是 charts.js 那条路。
     */
  };
}

/** HTML 转义：配置里的文案可能带尖括号，不能让它把模板打坏。 */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/**
 * 模板里所有 `/*__NAME__*\/` 形式的占位符。
 *
 * 构建完成后逐个核对：模板里出现的每个占位符都必须被填过，且产物里一个都不剩。
 * 这条断言是被一次真实事故换来的：模板换成了新占位符、构建脚本还在填旧的，
 * 结果产物里留着字面量 `/*__PAYLOAD_JSON__*\/`、`window.__REPORT__` 一次都没赋值，
 * 页面全白——而构建日志照样打印「报表 → xxx，2.15 MB，成功」。
 */
export function templatePlaceholders(src) {
  return [...String(src).matchAll(/\/\*__([A-Z0-9_]+)__\*\//g)].map((m) => m[1]);
}
