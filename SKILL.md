---
name: zzz-stats
description: 采集《绝区零》调频（抽卡）数据并落盘，按定稿口径生成单屏报表。当用户提到"绝区零抽卡记录/调频记录/抽卡统计/保底/出金率/导出抽卡数据/看看我抽得怎么样"时使用：驱动用户自己的 Chrome 打开官方「调频统计工具」，点登录后把二维码用动态 UI 画到对话流里让用户扫，抓官方统计接口，存成本地 JSON，再按 references/report-rules.md 出图；UIGF/CSV 导出在后续步骤实现。
---

# 绝区零调频数据采集

## 这个 skill 做什么

只做一件事：把用户账号的调频数据从官方「调频统计工具」页面取下来，存成本地 JSON。

- **能拿到**：每个频道的总抽数、S 数、UP 数、UP 平均抽数、当前垫抽、硬保底；每个卡池里**每一金**的物品 ID、名称、稀有度、是否 UP、消耗抽数、时间戳、池内序号；覆盖版本范围。
- **拿不到**：4 星记录、逐抽记录、记录 ID。要这些必须走 authkey 接口（`getGachaLog`），不在本文件范围。

## 边界（必须遵守）

1. **绝不索取账号密码、验证码、cookie、token**。登录由用户自己完成（扫码）。
2. 不读取、不保存、不打印 cookie 与请求头。只取三个接口的**响应体**。
3. 除了"点一下登录按钮"和"截一张二维码图"，不做任何自动化点击；不模拟抽卡、不改账号设置。
4. 数据只落本地 `data/` 目录，不上传。

## 唯一路径：用户自己的 Chrome

只用**外部浏览器**（TRAE Chrome 扩展驱动用户本机 Chrome），没有其他分支。

- 好处：登录态直接落在用户日常的 Chrome profile 里，**登录一次长期有效**，下次跑基本不用再登。
- `browser_connect_plugin` 返回 `connected: false` 时，用 `browser_setup_plugin` 引导用户安装/连接扩展，然后继续。**不要退回内置浏览器**，也不要用 Node 脚本。

所有浏览器调用都用 `external_browser_*` 前缀；连接检查只做一次，不要每次操作前重查。

---

## 1. 区服：国服（固定）

不需要问区服，固定走国服：

| 项 | 值 |
|---|---|
| 页面 | `https://act.mihoyo.com/zzz/event/gacha-record/index.html` |
| 接口基址 | `https://act-api-takumi.mihoyo.com/event/nap_gacha_record` |
| region | `prod_gf_cn` |

国际服不在本 skill 范围内。用户明确要求国际服时，才把域名换成 `act.hoyolab.com` / `sg-act-public-api.hoyolab.com`。

## 2. 打开页面并判断是否已登录

`browser_navigate` 到上表页面，然后 `browser_snapshot`（或 `browser_evaluate` 读 `document.body.innerText`）。

**两个实测坑，先看这里**：

- **页面卡在「加载中」→ 标签页在后台被节流了。** 只看到 `加载中 100%` 和一段小程序提示、`innerText` 只有二三十字时，不要以为页面坏了：先 `tabs` 列出标签页，`activate` 切到前台，Vue 才会渲染出「登录」按钮和统计区。别用刷新解决。
- **`browser_evaluate` 里不要写正则。** 脚本要经过两层字符串转义，`\s` / `\d` 会被吃成 `s` / `d`，正则静默失配（表现为"页面明明有 UID 却匹配不到"）。判断用 `innerText.indexOf('UID')` + `slice`，或直接读 `body > pre` 里的 JSON。

判断：

- 文本里有 `UID` + 6 位以上数字 → **已登录，跳到第 5 步**。
- 文本里有「登录后可查看账号的历史调频统计数据」+ 一个「登录」按钮 → 未登录，走第 3 步。

## 3. 点「登录」，把二维码画到对话流里

登录框是跨域 iframe，DOM 读不到，**只能截图**。所以流程是：点按钮 → 等二维码 → 截图 → 贴进对话 → 交接。

1. `browser_click` 点「登录」。按钮初始可能是 `disabled`（账号 SDK 还没初始化完）；报 "Click target is disabled" 时**不要连点**，等 2–3 秒、重新 snapshot 后再点一次。
2. **登录框默认是「短信登录 / 密码登录」，不是扫码。** 扫码入口是左上角一个约 32px 的小图标（class `qr-login-btn--wrapper`，hover 才显示"扫码登录"气泡），它藏在跨域 iframe 里。
   - 先试 `browser_snapshot({ selector: 'iframe' })`，看能不能拿到「扫码登录」的可点节点；
   - 拿不到就让用户点一下左上角那个图标（一步操作，比纠结坐标快），然后继续。
3. 等二维码渲染出来：页面正文会收缩到约 20 字，出现一个 **130×130 px 的 `<img>`**，文案「打开米游社/游戏/云游戏App，扫一扫登录」。
4. 截图：能拿到二维码 `img` 的 ref 就截该元素；否则整页截图（1280 宽下二维码约 130px）。
5. **把二维码用动态 UI 画进对话流，不要只给文件链接。** 先加载 `dynamic-ui` skill，再用 `PureShowWidget`（`mode` 留空走 inline）画一张「扫码登录」卡片；图片必须内嵌成 base64，不能引用本地路径。
   - 裁图 + 压到最小：二维码是黑白模块，转 1-bit PNG 后 296×296 只有约 1.3 KB（base64 约 1.8 KB），塞进 widget 几乎不占上下文。

     ```bash
     python3 - <<'PY'
     from PIL import Image
     import numpy as np, base64, io
     im = Image.open('/abs/login.png').convert('RGB')
     g  = np.array(im.convert('L')); dark = g < 120
     h, w = dark.shape
     rows = dark[:, int(w*.2):int(w*.8)].sum(axis=1)          # 二维码是一片高密度暗块
     m = rows > rows.max()*.8
     y0, y1 = int(np.argmax(m)), int(len(m) - np.argmax(m[::-1]))
     cols = dark[y0:y1].sum(axis=0); m = cols > cols.max()*.8
     x0, x1 = int(np.argmax(m)), int(len(m) - np.argmax(m[::-1]))
     c = im.crop((x0-18, y0-18, x1+18, y1+18)).convert('1')   # 留 18px 静区
     b = io.BytesIO(); c.save(b, 'PNG', optimize=True)
     print(c.size, base64.b64encode(b.getvalue()).decode())
     PY
     ```
   - 裁歪了就按截图里的 `IMG 130x130 @ (x,y)` 直接手写坐标，别反复试。
   - `widget_code` 结构：`<style>`（token）→ 卡片（白色 plate 里放 `<img src="data:image/png;base64,...">`，显示约 200px）→ 不需要 `<script>`。
   - **二维码只认当次截图。** `data/_verify/` 下的任何历史截图都是过期演示图，禁止复用；卡片上必须写清"HH:MM 截取"，用户一眼能判断是不是旧的。
   - **二维码那块必须保持纯白底和静区，不要跟着深色主题反色**（写死一个 `--qr-plate:#FFFFFF`，这是唯一允许不跟主题走的颜色），否则扫不出来。
6. 配一句话："请用米游社 App 扫码，二维码约 2 分钟失效"。
7. 紧接着调用 `browser_waiting_for_user_interaction`（必须独立调用，不能包在 Exec 里），reason 写："请扫码登录，完成后点继续"。

> 二维码过期或用户扫不到时，重新截一次再画一张，不要让用户去浏览器里找。
> `PureShowWidget` 不可用时（没加载 `dynamic-ui` 或工具不可调），退回 `image(截图结果)`，别退成文件链接。

## 4. 确认登录成功

轮询 `document.body.innerText`（每次间隔 3–5 秒，最多约 2 分钟），命中任一即视为成功：

- 出现 `UID` + 6 位以上数字
- 出现「总调频次数」「调频资源总览」等已登录文案

扫码确认后页面通常 10–20 秒内**自己刷新**成统计页（实测 12 秒），不需要手动 reload，也不要重复点登录。

一直不成功就回第 3 步重贴二维码，不要靠反复刷新页面来"催"它。

## 5. 取 uid 与 region

region 不在页面上显示，但会出现在页面自己发出的请求里：

1. 用 `browser_network_requests` 找 URL 含 `/api/zzz/index` 的请求，读它的 `uid`、`region` 查询参数。
2. 找不到（例如打开时就已登录、请求发生在记录之前）→ **只 reload 一次**，再读一次 network。
3. 仍找不到 → uid 用页面显示的 UID，region 国服按 `prod_gf_cn` 兜底，并在结果里注明"region 为兜底值"。

## 6. 逐个接口取数

固定顺序：`index` → 6 个频道的 `hist_pool_stat` → 6 个频道的 `cur_pool_stat`，两次请求之间停 300–500ms。

```
{api}/api/zzz/index?uid={uid}&region={region}
{api}/api/zzz/hist_pool_stat?uid={uid}&region={region}&gacha_type={t}&vers={v1,v2,...}
{api}/api/zzz/cur_pool_stat?uid={uid}&region={region}&gacha_type={t}
```

- `{t}` 依次取 `2, 3, 102, 103, 1, 5`（独家 / 音擎 / 独家重映 / 音擎回响 / 常驻 / 邦布）。
- **`vers` 必须用该频道自己的 `type_stats[].has_data_vers`，且单次最多 10 个。** 拿所有频道的并集、或一次塞 20 个版本，接口会返回 `-400005 参数错误`（已实测）。
- 版本数超过 10 时分片：按版本号降序每 10 个切一片，逐片请求，再把各片的 `data.list` 合并去重。页面自己只拉最近 8 个版本，分片才能拿到更早的历史。

**取数方法**：`browser_navigate` 直接跳到接口 URL（浏览器自动带登录 cookie），再 `browser_evaluate` 取正文：

```js
const p = document.querySelector('pre');
const t = p ? p.innerText : document.body.innerText;
return JSON.parse(t);
```

> - `browser_evaluate` 禁止发起网络请求，所以只能"导航到 URL 再读页面"，不能页内 `fetch`。
> - 工具返回会带一行 `Browser View ID: ...` 前缀，解析 JSON 前要先截到第一个 `{` 或 `[`。
> - 建议在新标签页里导航，读完就关，避免把用户的主页面留在裸 JSON 上。
> - 单个响应 `len` 在 1–8 KB 量级；如果某次返回明显变短，先看 `retcode`。

## 7. 落盘

每拿到一段就立刻用 Write 写到 `data/` 下（别攒到最后，避免中途丢数据）：

```
data/meta.json
data/index.json
data/cur_pool_stat_<t>.json
data/hist_pool_stat_<t>.json
```

- 写之前先 `JSON.parse` 校验，并要求 `retcode === 0`；`retcode` 为 `-100` 说明登录失效，回第 3 步。
- `meta.json` 至少含：`schema`（`zzz-stats/v1`）、`server`、`uid`、`region`、`fetched_at`、`versions`、`source`。
- JSON 原样保存，不要改字段名、不要转时间格式。

## 8. 校验

用这条等式判断数据是否取全了：

```
len(hist_pool_stat_<t>.data.list[].cur_records 之和) + len(cur_pool_stat_<t>.data.list[].cur_records 之和)
  ==  index.type_stats 里同频道的 s_count
```

- 6 个频道逐一比对；对不上就说明分片漏了版本，回第 6 步补。
- `index.total_s_count` **不含邦布**（实测 96 条 S 记录里，非邦布 62 条正好等于 `total_s_count`），别拿它当"全部 S"。
- `index.total_gacha_count` 应与页面显示的总调频次数一致。
- 向用户回报一句："已保存到 `data/`，覆盖 x.y → x.y 版本，共 N 抽 / M 金"。

## 失败处理

| 现象 | 处理 |
|---|---|
| 扩展 `connected: false` | `browser_setup_plugin` 引导安装扩展；不要退回内置浏览器 |
| 页面卡在「加载中」 | 标签页被节流，`tabs` + `activate` 切前台 |
| 点登录报 `Click target is disabled` | 账号 SDK 未就绪，等 2–3 秒重试一次，不要连点 |
| 二维码没出现 | 登录框默认是短信登录，要点左上角 32px 的扫码图标；点不到就请用户点一下 |
| 用户说二维码扫不到 | 在动态 UI 里把二维码放到 ≥200px 且保持纯白底；还不行就改截登录框元素（`ref`），别截整页缩略图 |
| 登录后页面一直不出数据 | 让用户确认账号已绑定《绝区零》角色；仍不行才 reload 一次 |
| 接口返回 `-100` | 登录态失效，回第 3 步重新扫码 |
| 接口返回 `-400005 参数错误` | 十有八九是 `vers` 一次给了超过 10 个，或用了不属于该频道的版本；按第 6 步分片重来 |
| 接口返回非 0 且非 -100 | 原样把 `retcode` / `message` 报给用户，不盲目重试 |
| `browser_network_requests` 里没有 `index` 请求 | 先 reload 一次；仍没有就用页面 UID + region 兜底 |
| 页面改版、接口路径变了 | 重新看 `index_*.js` 里的 `/api/zzz/*` 路径，更新本文件与 `references/api.md` |

## 数据产物

```
data/
├── meta.json                 # 区服、UID、拉取时间、覆盖版本
├── index.json                # 6 个频道的汇总统计
├── cur_pool_stat_2.json      # 当前卡池（按频道）
└── hist_pool_stat_2.json     # 历史卡池 + 每金记录（按频道）
```

字段说明见 `references/api.md`。

## 安全说明

- 该页面只认登录 cookie，URL 里没有 authkey；因此本方案不会产生任何可被复用的抽卡凭证链接。
- **不要尝试"导出 cookie 再 curl"**。`document.cookie` 只能看到 `ltuid_v2` / `account_id_v2` / `mi18nLang` 这类标识，真正的鉴权凭证 `ltoken_v2` / `cookie_token_v2` 是 HttpOnly；CDP 的 `Storage.getCookies` 虽然读得到，但那等于把**完整账号凭证**落盘——它能做的远不止看抽卡，风险比 authkey 高一个量级。用浏览器代发请求就够了。
- "登录一次、后续免登录"靠的是用户自己 Chrome 里的会话，不需要额外存 cookie；`retcode:-100` 才是真的过期。
- 取到的数据会经过对话上下文，本身不含 cookie。
- 用户要求清理时，删除 `data/` 即可。

## 下一步：报表

采集完成后按 `references/report-rules.md` 生成 HTML 报表（指标公式、配色分档、tooltip 文案、称号与标签计数、十连多金归属、头部布局、首屏单屏 + 第二屏抽卡详情、截图验证要求），照此执行，不要重新发明。骨架如下：

- **首屏**：标题行（昵称 | 大标题 | UID 胶囊 | 隐私开关）+ 5 格 KPI；主图面板标题固定 `抽卡总览`（15px/700），右上灰色小字 `N 个 UP · N 抽`；UP 成本堆叠柱 + 累计不歪率折线，1440×900 / 1280×800 首屏无滚动、图例单行。
- **大标题**按每 UP 均查 `report-rules.md` §4.1 的 10 档（≤62.5 终极无敌至尊欧皇 … >125 终极无敌至尊非酋，保留薛定谔的非欧 / 超级至尊非酋 / 万里挑一至尊欧皇）。不歪率只是强相关，不能当判档依据。
- **第二屏抽卡详情**：6 个频段标签（独家 / 音擎 / 常驻 / 邦布 / 复刻角色 / 复刻音擎），按版本分组、版本号写在左方括号左侧；行 = 图标 + 横条（≤ 均值绿 `#2E8F45`，> 均值红 `#FF5F6D` + 斜纹）+ 紧贴柱体右侧的「歪」章；整页纵向铺开，不设内部滚动。
- **「显示真实抽数」**：默认不勾；勾上后把歪的抽数并进下一个 UP、只留 UP 行，十连后出的副金并回同一轮；常驻频段禁用。
- **行悬浮 tip**：自绘深色气泡（不用原生 `title`），逐金写 `名字 / vX · 出金时间 / 距上一金 N 抽 · UP|歪`；合并写 `本轮 N 抽 ＝ UP a + 歪 b` 与 `歪出：名字 b 抽`，无歪写 `本轮 N 抽 · 无歪`。
- 报表需要显式表达"运气好"的维度：`record_time` 同秒 且 `sort` 差 ≤ 9 的两金算**十连多金**（判定依据见 `references/api.md`），单独计次，不要折算成普通出金。
- 报表产物：`report.html` + `assets/charts.js` + `assets/avatars/` + `assets/items/`，依赖本地 ECharts 与字体，不联网、不用 CDN。
- 图标缓存：`assets/avatars/`（角色圆头像）与 `assets/items/`（角色/音擎/邦布方图标）随 skill 自带，生成报表时先复制缓存，缺的 `item_id` 才下载并写回；下载失败用 `assets/items/_fallback.png` 兜底，不要裂图、不要引用 CDN。
- 需要 UIGF/CSV 导出时再按 `references/api.md` 的字段自行组织，当前未实现。
