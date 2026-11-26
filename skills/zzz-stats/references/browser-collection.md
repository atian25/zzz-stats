# 浏览器手动采集

仅在无法运行采集 CLI、但宿主有浏览器页内 JS 能力时使用。登录与取数脚本已封装，正常 CLI 流程不需要读本文件。

## 前提

- 能打开官方页面，在页面上下文执行支持 Promise 的 JS，并取得返回值。
- 用户自己完成扫码、短信或人机验证，遵循宿主的人工接管与安全输入要求。
- 不导出 Cookie、请求头或浏览器登录态。

国服页面：[官方调频统计](https://act.mihoyo.com/zzz/event/gacha-record/index.html)。国际服页面：[HoYoLAB 调频统计](https://act.hoyolab.com/zzz/event/gacha-record/index.html)。

## 流程

1. 打开对应官方页面，等待统计页或登录入口渲染。
2. 用户完成登录。已有登录态可直接使用，不重复请求短信或扫码。
3. 在官方页面上下文执行 [fetch-in-page.js](../scripts/fetch-in-page.js) 的完整内容，不自行重新实现分片与去重。
4. 把返回 JSON 保存到用户工作目录的临时输入文件，用 [save-in-page-json.mjs](../scripts/save-in-page-json.mjs) 落盘：

```bash
node "$SKILL_DIR/scripts/save-in-page-json.mjs" --cwd "$WORK_DIR" --in result.json
```

5. 检查退出码与数据目录，再按 SKILL 的构建步骤生成报表。没有 Node 环境时只能先交付 JSON，不能承诺已生成 HTML。

## 登录观察与常见阻断

- 页面显示游戏 UID 或「总调频次数」等统计内容后，再开始取数；米游社账号 ID 不是游戏 UID。
- 页面一直「加载中」时可能被后台节流，按宿主能力提供可见窗口/真实视口，不反复刷新。
- 登录 iframe 跨域。宿主不能访问时请用户自己操作，不绕过浏览器权限。
- 登录框默认可能是短信模式；扫码模式可用 `location.hash === '#/login/qr'` 判断，不用「有一张大图」猜模式。
- 若提取二维码，优先读取 frame 中宽高至少 120、近似正方形的 data URL 图片，排除 logo 与横幅；不要导出其他敏感页面内容。
- 交付当次二维码，保持等待能力；用户已登录后不再展示旧码。

## 取数约束

页内 fetch 要在官方统计页面执行，不能在 `about:blank` 或其他站点发送。使用当前游戏 UID 与实际 region，不猜国际服区服。

脚本负责 index、六频道当前池与历史池、频道各自版本分片（单次最多 10 个）、去重与业务返回码校验。返回错误时报告真实信息，登录失效就重新让用户登录，不改响应凑出报表。
