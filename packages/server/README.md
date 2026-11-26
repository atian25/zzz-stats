# 本地扫码报表服务

需要 Node.js ≥22 和 pnpm 12。首次克隆后从仓库根安装整个 workspace，再运行：

```bash
pnpm install --frozen-lockfile
node packages/server/serve.mjs --host 127.0.0.1
# 可选：--port 8080 --max-runs 4 --ttl 30
```

默认端口 3000、host 为 0.0.0.0、并发上限 8、结束后的 run 保留 30 分钟。默认监听允许局域网访问；只在本机使用应显式指定 127.0.0.1。不承诺公网部署的鉴权与安全隔离。

## 流程与边界

首页展示示例与「开始扫码」，不读取其他用户的运行。点按钮后创建独立 run，显示 QR、SDK 给出的有效期与进度。扫码后的 QR 失效展示，完成后跳到该 run 的 HTML。

每个 run 的状态、事件流和报表通过 runId 定位；缺少 runId 不猜「最新一个」。满并发返回 503，不取消别人。runId 不是访问鉴权，不要公开他人的报表地址。

服务只走国服纯 Node 扫码，不自动切浏览器。采集 JSON 与 HTML 在内存中，结束后 TTL 释放；需要归档、短信或浏览器通道时使用 skill 的 CLI。

前端与后端在本目录；预览图来自仓库的 docs/preview.png，缺图返回 204 并提示，不影响采集。它是 GitHub/服务展示资源，不是 skill 执行步骤。

## 排查经验

- **Map 序列化**：JSON.stringify(Map) 得到 `{}`。buildReport 要使用归一化后的文件对象，Map 与对象两条输入都应验证。
- **meta 丢失**：SDK files 只有 13 个响应键，meta 是单独字段。内存直通也必须补 meta.json，否则图表可能正常但昵称/UID 为空。
- **隐藏无效**：hidden 属性可能被作者样式覆盖；同时检查 computed display 和真实占位尺寸，不只看属性。
- **扫码反馈**：使用真实进度阶段盖 QR 遮罩、隐藏倒计时和换码按钮，不靠「已过 N 秒」猜扫码。
- **笔记本首屏溢出**：图高按视口减非图预算计算；padding 改动、媒体查询定义顺序和跨断点单调性都需要一起验收。
- **多人隔离**：用两个独立浏览器上下文实际启动，检查各自事件、昵称和报表，不只断言 RUNS 是 Map。

开发约定见 [仓库 AGENTS.md 的 server 一节](../../AGENTS.md)，旧版本的实测记录见 [docs/history.md](docs/history.md)。历史中的旧路径、transport 参数、单用户取消策略、落盘与内联前端约束不代表现状。
