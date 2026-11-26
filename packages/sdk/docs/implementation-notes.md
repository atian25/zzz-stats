# 采集实现与排查经验

本文件给 SDK 维护者看。公共调用以 [api.md](api.md) 为准；下面是协议与资源层的经验，不是让 skill 使用者手工重写登录。

## Node passport 登录

Node 通道只实现国服扫码，直接 HTTP 登录后使用内存 Cookie 请求 act 接口。它依赖官方页面请求逆向得出的私有协议，不是有稳定公开文档的 API。

遇到业务错误时先核对真实响应，再比较官方请求中的 app_id、Cookie 名、game_biz；不能只因业务码就断言网络失败。

- `x-rpc-app_id` 使用 `cieb8o6xs1kw`；错误或旧值曾导致 `-3005`。
- 国服 `game_biz`/`x-rpc-game_biz` 为 `nap_cn`。国际服不能只改 region 复用同一套 passport 协议。
- 确认响应中的 token 从 `Set-Cookie` 获取，不能假定 `data.tokens` 非空。凭据只在首次 Confirmed 响应下发，必须处理那次响应，不能返回后再补查。
- Cookie 只取白名单认证项，排除 CDN 会话 `aliyungf_tc`；不要把 Path/Domain 等属性拼进请求 Cookie。
- `queryQRLoginStatus` 的 `user_info.aid` 是米游社账号 ID；通过 `getUserGameRolesByCookie` 解析游戏 UID、实际 region 和昵称。
- 未真实扫码只证明创建/轮询前段；假 fetch 验证接线不能当成真实上游验收。

## browser 登录

- 官方登录为跨域 iframe；外层 iframe 出现不代表里面 DOM 已渲染，要等待 frame 和实际表单。
- 默认可能是短信模式，扫码模式用 location.hash 判断，再检查二维码图片是否近似正方形；横幅与小 logo 也可能是 data URL。
- Element UI 表单需原生 input setter 和 input/change 事件，直接写 el.value 不会同步组件状态。
- 手机区号目前为固定 +86；发送短信不自动重试，提交失败不自动重发。
- 自动登录能力不足时交给消费者的人工操作回调，回调结束后必须重新验证登录态，不能只相信「用户完成了」。
- 页内请求必须在官方统计页源下执行，不能在 about:blank 请求后把 CORS 误报成网络不可用。

## 采集

先 index，再按 SDK 频道顺序采集。历史版本取该频道自身 has_data_vers，单次最多 10 个；超限分片并合并去重。不要拿所有频道版本并集去请求某一频道。

公共结果 13 个响应键：index 与六组 cur/hist；meta 单独返回，由消费者补入报表文件映射。官方总抽与 S 数不含邦布。cur 的既有容错还在，空列表与 retcode=0 不能作为错误证据。

## CDP 所有权

CDP URL 的 host/port/协议必须传到 HTTP 发现与 WebSocket 连接层。连接借来的 Chrome 只拥有新建 target，不拥有用户已有页面或进程。

自启 Chrome 必须保留 child 引用，启动失败、取消和 close 都等待自己的进程退出。createTarget 取消后仍可能迟到返回 targetId，清理要处理迟到结果；不能让已 aborted 的 signal 阻断 closeTarget。

create/close target 可设有界超时，不要把同一个短超时强加给所有 evaluate 操作。远端失联或 target 创建无响应时只能说明资源清理限制，不能承诺所有情况下零残留。

## 迁移记录

2026-11 的采集/渲染拆分曾使用平铺 transport/cfg 参数与更多根导出；这些是旧接口。现在采集进本目录，渲染器仍在 skill 的 scripts，因为它读取模板、配置和图标。迁移 CLI 时必须同步依赖声明与 workspace 链接，裸包名能在仓库其他 package 导入不代表 skill 包也能导入。
