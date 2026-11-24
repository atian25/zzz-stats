/**
 * zzz-stats 逻辑 SDK —— 统一入口。
 *
 * ## 这里有什么、没有什么
 *
 * **有**：登录、采集、出报表三件事的纯逻辑。全部返回数据，**不写盘、不读参数、
 * 不调用 process.exit**。同一份内核因此能被 CLI、未来的 HTTP 服务、用例共用。
 *
 * **没有**：文件系统布局（`output/<账号名>/data/`）、日志格式、退出码、二维码图片服务、
 * 信号处理。那些都是「外壳」的事，留在 `scripts/` 下：
 *
 *   scripts/collect.mjs        采集 CLI
 *   scripts/build-report.mjs   构建 CLI
 *   scripts/screenshot.mjs     截图 CLI
 *
 * ## 两条采集路径
 *
 *   transport = 'node'     纯 Node：passport 扫码 → Cookie → act 接口直连
 *                          优点：不需要浏览器、快；缺点：只做国服、依赖逆向的私有 header
 *   transport = 'browser'  浏览器：官方页面里点登录/扫码 → 页内 fetch
 *                          优点：风控与签名交给官方前端；缺点：要浏览器、要人等扫码
 *
 * CLI 默认 node，失败自动降到 browser 并打一行说明。这个「降级」在外壳里做
 * （见 `scripts/collect.mjs`），SDK 只管把失败原因原样抛出来。
 *
 * ## 典型用法
 *
 * ```js
 * import { collectData, buildReport } from './lib/index.mjs';
 *
 * // 采集（不写盘）
 * const { uid, nickname, files, meta } = await collectData({
 *   transport: 'node',
 *   onQr: async ({ dataUrl }) => { /＊ 自己决定怎么展示 /落盘 ＊/ },
 *   onProgress: (ev) => console.log(ev.stage, ev.message),
 * });
 * files.set('meta.json', meta);
 *
 * // 出报表（不写盘）
 * const { html, fatal, warnings } = buildReport({ files });
 * if (!fatal.length) await writeFile('report.html', html);
 * ```
 */

export { collectData, collectFiles, buildMeta, sortVersionsDesc, chunk, MAX_VERS, REQUEST_GAP_MS } from './collect.mjs';
export { buildReport } from './build.mjs';
export { loginWithQr, resolveGameUid, cookiesFromSetCookie } from './login-node.mjs';
export { createNodeTransport } from './transport-node.mjs';
export { encodeQrDataUrl, dataUrlToBuffer } from './qr.mjs';
