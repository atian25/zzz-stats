/**
 * `skills/zzz-stats/lib/` —— **出报表这一层**的统一出口。
 *
 * 与 `packages/sdk/index.mjs`（只放采集）是一对：那边采集，这边渲染。
 *
 * ## 为什么这一层不跟着搬进 packages
 *
 * 判据是「它依赖 skill 资源吗」。这三份文件跟 `assets/report/**` 绑死：
 *
 *   build.mjs           读 template.html / charts.js / charts.css / core.js /
 *                       icons/ / vendor/echarts.min.js —— 十处
 *   core-inline.mjs     把 core.js 转成产物里能跑的那段脚本
 *   template-tokens.mjs 模板占位符与配色变量
 *
 * 它们本质上是 **zzz-stats 这份报表的渲染器**，不是通用 SDK。
 * 搬进 packages 只是把耦合换个地方，还得再加一套资源注入参数 —— 没有真正解耦。
 * 所以它留在 skill 里，用 `SKILL_DIR = resolve(HERE, '..')` 自己定位资源。
 *
 * ## 用法
 *
 * ```js
 * import { buildReport } from '../lib/index.mjs';   // 相对路径按调用方算
 *
 * const { html, fatal } = buildReport({ files, cfg });
 * ```
 *
 * `buildReport()` 收 `cfg` 可选：不传就自己读 `config/report.json`
 * （它知道 skill 目录在哪）。这与采集层相反 —— `collectData()` 的 `cfg` 是**必传**。
 */

export { buildReport } from './build.mjs';
export { cssVarBlock, textSubs, escapeHtml, templatePlaceholders } from './template-tokens.mjs';
export {
  PAYLOAD_ID,
  escapeJsonForScript,
  buildCorePlusBoot,
  checkInlinedScript,
  stripExports,
} from './core-inline.mjs';
