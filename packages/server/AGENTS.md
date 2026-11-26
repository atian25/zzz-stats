# 本地 Web 服务开发约定

服务是 SDK 与报表渲染器的消费者，只调公共接口，不把服务策略写回 SDK。使用说明与排查经验见 [README.md](README.md)。

## 服务契约

- 后端 serve.mjs 与前端 index.html/app.js/style.css 同目录；前端不内联进后端，也不混入 skill 的报表资源。
- 每次 start 创建独立 run，QR、事件、进度与 HTML 按 runId 隔离；不能用全局 currentRun，不能启动新任务时取消其他用户。
- 按 run 读取的接口必须带 runId；缺失返回 400，不猜最新账号。并发上限满时返回 503，不踢掉旧 run。
- 只用 `channel: 'node'`，服务里不降级；SMS、浏览器策略与落盘归档是 CLI 的事。
- 采集与 HTML 只保存在 run 内存中，结束后按 TTL 释放，不写 output。files 的 13 个键外要补 result.meta 为 meta.json 再交给 buildReport。
- ticket、Cookie、set-cookie、token、验证码不进日志/SSE；不能把已登录 session 序列化交给前端。
- 静态路由用固定白名单，不从 URL 拼本地路径。预览图缺失时按现有 204 降级，不暴露源码或目录。
- 默认 host 为 0.0.0.0，局域网可访问；本机使用应显式传 127.0.0.1。runId 是定位符，不是成熟的访问鉴权，不把本地开发服务当公网安全产品。

## 前端与验收

- 首页不自动申请二维码，也不接最近一次运行；点开始才创建本次 run。
- 二维码生成与倒计时使用 SDK progress 的 TTL，不自行补硬编码兜底。
- 扫码后的阶段给 QR 盖遮罩，藏掉换码按钮与倒计时；失败后停止转圈。判断按实际阶段白名单，不靠计时器猜。
- 保留 `[hidden] { display: none !important; }`；验收测 computed display 与真实尺寸，不只测 hidden 属性。
- 首页图高按视口减非图预算计算，保留可读下限与上限。改 padding 时重新量预算，检查媒体查询顺序和跨断点单调性；极矮窗口可以滚动，不为塞首屏裁掉说明。
- Map 与对象入参都要真构建，并在浏览器检查账号信息、非空图表、实际尺寸与控制台；HTTP 200 不等于报表正确。
- 先跑 `node packages/server/test-sdk-integration.mjs`；涉及交互/样式再独立浏览器验收两人隔离、QR 遮罩与笔记本/窄屏布局。
- 验证另用独立端口，不重启用户当前服务。报表模板或算法改动另外遵守仓库的 skill 验收约定。
