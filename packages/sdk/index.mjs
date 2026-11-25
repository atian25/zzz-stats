/**
 * `packages/sdk/` —— **只放采集这一层**的统一出口。
 *
 * ## 边界（用这个核对「哪些文件在 packages/sdk」）
 *
 * 这里**只有采集**：登录、取数、二维码编码。判据是「它依赖 skill 资源吗」：
 *
 * | 文件 | 干什么 | 依赖 skill 资源？ |
 * |---|---|---|
 * | `collect.mjs` | 采集编排：登录 → 定 uid/昵称 → 按频道取数 → 返回 Map | 只用到 `channels`，由调用方传 `cfg` |
 * | `login-node.mjs` | 纯 Node 扫码登录（passport + Cookie） | 否 |
 * | `login-browser.mjs` | 浏览器登录（页面 iframe 扫码 / 短信） | 否 |
 * | `transport-node.mjs` | 纯 Node 取数（act 接口直连） | 否 |
 * | `qr.mjs` | 二维码编码 → data URL | 否（vendor 路径由调用方传） |
 * | `drivers.mjs` | 浏览器驱动适配层（playwright / cdp） | 否 |
 * | `qr-wait.mjs` | 换码通道 + 二维码计时 | 否 |
 *
 * **这里没有 `buildReport`。** 报表渲染器留在 `skills/zzz-stats/lib/build.mjs`：
 * 它那 10 处读取 `assets/report/template.html`、`charts.js`、`charts.css`、`core.js`、
 * `icons/`、`assets/vendor/echarts.min.js` —— 它本质上是**这份报表的渲染器**，
 * 不是通用 SDK。搬走只是把耦合换个地方，没有真正解耦。
 *
 * `drivers.mjs` / `qr-wait.mjs` 跟着采集走，是因为 `login-browser.mjs` 静态依赖它们，
 * 不是为了「都在 packages 下」凑数：它们自身都**不读 skill 资源**
 * （`drivers.mjs` 用 `createRequire(import.meta.url)` 找 playwright，
 * `qr-wait.mjs` 的信号文件路径由入参给）。
 *
 * ## 三条边界（改之前先读）
 *
 * 1. **SDK 不写盘。** 只返回 `files: Map`。写不写、往哪写是外壳的决定。
 * 2. **SDK 不读 `process.argv`、不调 `process.exit`。**
 * 3. **配置由调用方给。** `collectData({ cfg })` —— 采集层与 skill 目录已分离，
 *    它不能靠 `resolve(HERE,'..')` 猜 `config/report.json` 在哪。
 *    渲染器不一样：它就在 skill 里，照旧自己定位，不需要注入。
 *
 * ## 两个出口，别混
 *
 * ```js
 * // 采集：从 packages/sdk 引
 * import { collectData } from './packages/sdk/index.mjs';
 *
 * // 报表：从 skill 的 lib 引（不在 packages/sdk 里）
 * import { buildReport } from './skills/zzz-stats/lib/build.mjs';
 * ```
 *
 * 现在的调用方：
 *
 *   skills/zzz-stats/scripts/collect.mjs        采集 CLI     → 只用采集层
 *   skills/zzz-stats/scripts/build-report.mjs   构建 CLI     → 用 skill/lib 的 buildReport
 *   packages/server/serve.mjs                   本地 Web 服务 → 两个都用
 */

export {
  collectData,
  collectFiles,
  buildMeta,
  sortVersionsDesc,
  chunk,
  MAX_VERS,
  REQUEST_GAP_MS,
} from './collect.mjs';
export {
  loginWithQr,
  resolveGameUid,
  cookiesFromSetCookie,
  loginByQrNode,
  collectViaNode,
} from './login-node.mjs';
export { loginByQrBrowser, collectViaBrowser, closeBrowserSession } from './login-browser.mjs';
export { createNodeTransport } from './transport-node.mjs';
export { encodeQrDataUrl, dataUrlToBuffer, loadQrcode } from './qr.mjs';
