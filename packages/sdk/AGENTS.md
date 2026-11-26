# 采集 SDK 开发约定

本目录只负责登录、采集和二维码编码，不依赖 skill 的配置、模板或图标。公共契约读 [docs/api.md](docs/api.md)，协议排查经验读 [docs/implementation-notes.md](docs/implementation-notes.md)。

## 公共面与宿主边界

- 根入口只导出 `collectData`、`login`、`collect`、`encodeQrDataUrl`、`SdkError`，package exports 只留 `.`。测试可以直引内部模块，不因此增加公共出口。
- 参数按 `channel: node|browser` 与 `login.method: qr|sms` 两个维度组织；无效组合在 I/O 前拒绝。SDK 不接报表 cfg。
- `onQr` 只传 `{ dataUrl }`，两通道 await；TTL 与状态通过 progress 表达，不添加宿主 UI 参数。
- SDK 不读 argv/stdin，不保存采集或凭据中转文件，不退出进程；QR 展示、中文提示、信号文件、TTY、等待与通道降级由消费者负责。
- 公共结果统一为 13 个响应键的 files 与单独 meta；session 的 channel/gameUid/region 只读。不能用米游社账号 ID 冒充游戏 UID。
- 自动驱动回退与采集通道降级是两回事；SDK 不在 Node 失败后改走 browser。

## 资源、取消与错误

- CDP 永远新建自己的 target，close 只关闭自己的 target；不能征用已有页面。
- 只终止自己 spawn 的 Chrome；借入连接不能杀进程。close 幂等，SIGTERM 后 SIGKILL 兜底，等退出后返回。
- CDP URL 透传 host/port/协议，不静默改连本机。远端断连、创建无响应和已发副作用的限制按 api 文档说明，不作绝对保证。
- 取消检查覆盖网络、响应体、输入回调和驱动等待；取消不阻碍必要的资源清理。
- 已知错误按 SdkError 分类。cur 请求仍保留宽泛容错，不把空列表当成错误证据；变更此策略需要单独讨论。
- 日志、事件和报错不得带 Cookie、token、ticket 或验证码。

## 验证

从仓库根运行（数字以实际输出为准）：

```bash
node packages/sdk/test/test-sdk-transport.mjs
node packages/sdk/test/test-qr.mjs
node packages/sdk/test/test-package-exports.mjs
node packages/sdk/test/test-driver-injection.mjs
node packages/sdk/test/test-cdp-resources.mjs
node packages/server/test-sdk-integration.mjs
```

真实 Chrome 验证使用 `test/test-cdp-chrome.mjs` 的独立端口/profile，不连接用户日常 9222。退出后确认自己启动的 PID 不存在、端口释放，只清理本次创建的 profile。不要把假网络通过写成真实账号扫码/短信已验收。
