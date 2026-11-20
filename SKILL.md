---
name: zzz-stats
description: 采集《绝区零》调频（抽卡）数据并生成 HTML 报表。当用户提到「绝区零抽卡记录 / 调频记录 / 抽卡统计 / 保底 / 出金率 / 导出抽卡数据 / 看看我抽得怎么样」时使用：用任意可用的浏览器能力打开官方「调频统计工具」，让用户自己登录（扫码 / 短信验证码两种方式，先问用户选哪种），抓官方三个统计接口存成本地 JSON，再用一条命令生成「首屏单屏 + 抽卡详情」报表。不依赖特定宿主的浏览器工具名。
---

# 绝区零调频数据采集与报表

采集用户账号的调频数据 → 存成本地 JSON → 一条命令出 HTML 报表。

- **能拿到**：每个频道的总抽数、S 数、UP 数、UP 平均抽数、当前垫抽；每张卡池里**每一金**的物品 ID、名称、稀有度、是否 UP、消耗抽数、时间戳、频道内序号；覆盖版本范围。
- **拿不到**：4 星记录、逐抽记录、记录 ID。这些必须走游戏内 `getGachaLog` + authkey，不在本 skill 范围。

## 边界（必须遵守）

1. **绝不索取账号密码、验证码、cookie、token**。登录由用户自己完成（扫码）。
2. 不读取、不保存、不打印 cookie 与请求头。只取三个接口的**响应体**。
3. 除了「点一下登录按钮」和「点一下扫码图标」，不做任何自动化点击；不模拟抽卡、不改账号设置。
4. 数据只落本地 `data/`，不上传。

---

## 0. 浏览器：先看当前会话有什么能力

**不要假设存在某个具体工具。** 这个 skill 只需要 6 项能力，会话里有哪套就用哪套：

| 能力 | 语义 | 常见形态 |
|---|---|---|
| 打开页面 | 导航到 URL，能等条件成立 | `browser_navigate` / CDP `Page.navigate` / `moli fetch` / Playwright `goto` |
| 页内执行 JS | 在页面上下文跑 JS，支持 Promise | `browser_evaluate` / CDP `Runtime.evaluate` / `moli fetch --eval` / `page.evaluate` |
| 读写跨域 iframe | 枚举 frame、在 frame 内执行 | CDP `Page.getFrameTree`+`createIsolatedWorld` / Playwright `frameLocator` |
| 读网络（可选） | 列请求 URL | CDP `Network.*` / `moli --trace-network` / `page.on('request')` |
| 交图给用户 | 显示一张图 | 宿主图片组件 / GenUI / 存文件给路径 |
| 等等候 | 轮询直到条件成立 | 任何上面能力的组合 |

**优先级（从省事到兜底）：**

1. **会话自带的浏览器工具**（内建浏览器、moli、`browser_*`、宿主的 fetch 工具…）——有什么用什么，不要额外装东西
2. **Playwright**——环境里已经有就用，用 `channel:'chrome'` 驱动本机 Chrome，不额外下载浏览器
3. **零依赖 CDP**——前面都没有时的兜底，只用 Node 内置模块直连，自己起本机 Chrome

`scripts/collect.mjs` 已经实现了 2 和 3；如果你的会话属于情况 1，有两种用法：

- **简单**：只用会话自带的工具做「打开页面 + 扫码」，拿到登录态后，取数那一步仍然可以交给脚本（脚本支持 `--cdp` 连已开着的浏览器）
- **直接**：按下面 0.1 的 6 个方法写一个新的驱动文件，`collect.mjs` 不用改

```bash
node scripts/collect.mjs                 # 自动挑：有 Playwright 用它，没有用零依赖 CDP
node scripts/collect.mjs --driver cdp    # 锁定零依赖方案
node scripts/collect.mjs --cdp http://127.0.0.1:9222   # 连已开着的 Chrome，登录态可复用
node scripts/collect.mjs --headed        # 显示浏览器窗口，方便自己扫码
ZZZ_CHROME_ARGS='--no-sandbox --headless=new' node scripts/collect.mjs   # 受限沙箱
```

Playwright 装在 agent 自己的 profile 里也能被找到（自动搜索 `cwd` 祖先目录与 `~/.dsh/profiles/*`）；
也可以显式指定 `ZZZ_PLAYWRIGHT_PATHS=/path/to/node_modules`。

**本机完全没有浏览器、也没有浏览器工具时：** 请用户自己打开页面扫码导出，把 `data/` 里的 JSON 交给你；
**不要**要求用户去装浏览器插件。

### 0.1 换成别的浏览器实现时，只需对齐这 6 个方法

`scripts/drivers.mjs` 把浏览器能力收敛成一个非常小的接口，两个驱动都实现它。
如果某个 agent 有自带的内置浏览器，照着实现一份即可，**不用改 collect.mjs 的流程**：

| 方法 | 语义 |
|---|---|
| `open(url)` | 打开页面 |
| `evaluate(expr)` | 在主页面上下文执行 JS，支持返回 Promise |
| `waitFor(expr, ms)` | 轮询直到表达式为真 |
| `loginFrame()` | 拿到跨域登录 iframe 的句柄（内部要**轮询**，外层 iframe 挂上 ≠ frame 已就绪） |
| `evaluateInFrame(frame, expr)` | 在指定 frame 内执行 JS |
| `close()` | 收尾 |

**两条注意事项：**

- **点不动再找人。** 优先自动点：先按元素点（`element.click()` / `dispatchEvent`）。
  元素点不动时才退到坐标点击（有的实现只支持 `Input.dispatchMouseEvent`，会报
  `requires layout hit testing`）；坐标也不行，才请用户点一下。**顺序是自动 → 坐标 → 找人，别一上来就让用户动手。**
- **页内发请求。** 接口的 CORS 只放行 `act.mihoyo.com`，所以在**官方页面上下文里** `fetch`，
  不要新开 `about:blank` 或别的站点再发，那样会被拦。

---

## 1. 区服：默认国服

**默认走国服，不用追问**；只有用户主动说自己是国际服/亚服/美服等，才切换：

| | 国服（默认） | 国际服 |
|---|---|---|
| 页面 | `https://act.mihoyo.com/zzz/event/gacha-record/index.html` | `https://act.hoyolab.com/zzz/event/gacha-record/index.html` |
| 接口基址 | `https://act-api-takumi.mihoyo.com/event/nap_gacha_record` | `https://sg-act-public-api.hoyolab.com/event/nap_gacha_record` |
| region | `prod_gf_cn` | `prod_gf_jp` / `prod_gf_us` / `prod_gf_eu` / `prod_gf_sg`（按账号实际值） |

切换时用 `--region` 传 region，并把页面/接口基址换成上表右列。
国际服的实际 region 值从 `/api/zzz/index` 的请求参数里读，读不到时按账号所在服务器兜底，并在结果里注明。

## 2. 打开页面并判断是否已登录

用 C1 打开页面，等到 `main.page` 出现（`document.querySelector('main.page')`），再用 C2 读状态：

```js
(() => {
  const root = document.querySelector('main.page');
  const text = document.body.innerText || '';
  return {
    cls: root ? root.className : null,               // 含 logged-out 表示未登录
    loggedOut: root ? root.className.includes('logged-out') : null,
    hasUid: /UID/.test(text),
    textLen: text.length,
  };
})()
```

判断：

- `hasUid` 为 true → **已登录**，跳到第 5 步。
- `loggedOut` 为 true → 未登录，走第 3 步。
- `textLen` 只有二三十、看到「加载中 100%」→ **标签页被节流了**。切到前台（或给页面一个真实视口/焦点），Vue 才会渲染出登录按钮。不要靠反复刷新。
- `cls` 为 null 且上面三个都不成立 → 页面没挂载成功，再等或重新导航一次。

### 2.1 扫码后：自动检测，还是提示用户回复「已扫码」（A / B 档）

| 档位 | 判据 | 做法 |
|---|---|---|
| **A（优先）** | 会话**支持等待** —— 能把进程挂起来、完成后再回来读结果 | 用后台任务启动采集并**挂着等**。检测到扫码完成就自动继续，用户什么都不用说 |
| **B（降级）** | 会话只能**一次性执行**，进程一返回就结束 | 交付二维码时明确告诉用户：**扫完后回复一句「已扫码」**，收到后再跑一次续上（登录态在 profile 里，不会要求重扫） |

判据只有一条：**这个会话能不能挂着等进程**。能等就别让用户回话；不能等就老实说清楚。

```bash
# A 档：后台任务 + 等待，自动检测到扫码
node scripts/collect.mjs            # 默认 a

# B 档：一次性执行，提示用户回「已扫码」
node scripts/collect.mjs --wait=b   # 或 ZZZ_WAIT_MODE=b
```

## ⛔ 等待扫码：只许一种写法

**扫码完成后必须在 1 秒内被感知。** 这是硬指标，不是「尽量」。

### 唯一正确写法

```
1. 后台启动采集          → 拿到 job_id
2. 读日志取出二维码 URL   → 发给用户
3. job_output(job_id, wait: true)   ← 阻塞在这里，进程一退出立刻返回
```

`wait: true` 是**事件驱动**的：没有超时轮询、没有固定等待，
采集进程退出的那一刻调用就返回，然后你立刻在对话里汇报。

### 明令禁止

| 写法 | 为什么错 |
|---|---|
| `node collect.mjs &` + `sleep 30` | 固定盲等。用户 3 秒扫完，也要等到第 30 秒 |
| `sleep 5` 然后查日志，再 sleep 再查 | 更糟：查完就走开，扫完了你还在做别的事 |
| 查一次日志就结束本轮 | **最常见的错**。用户扫完，对话流一片空白 |
| 前台直接跑不加 `&` 又不等返回 | 工具调用被占满，扫码期间无法给用户任何反馈 |

**任何 `sleep N` 出现在扫码流程里，都是 bug。** 没有例外，没有「这次先这样」。

### 为什么这条要写得这么死

它已经反复出错 4 次，症状完全一样：**用户扫完码，对话流没有任何反应**，
用户以为没识别到，于是重复扫码、反复询问。根因从来不是检测失败 ——
日志显示每次都成功采到了 —— 而是 agent 用 `sleep` 代替了等待，
把自己变成了「过 N 秒才看一眼」的盲人。

写下规则还不够，必须把 `sleep` 当成明确的禁止项来对待。

| 宿主能力 | 怎么写 | 效果 |
|---|---|---|
| 有后台任务 + 等待 | 后台启动 → `job_output(wait: true)` | 进程一结束**立刻**返回 ✅ |
| 只能前台执行 | 直接前台跑，不加 `&` | 一直占着，直到进程退出 ✅ |
| 都没有 | 降级 B 档，让用户回复「已扫码」 | 明确告知，别假装在等 ✅ |

**两种档位都要给用户可见的回应。** 扫码那一刻用户是盯着屏幕的：

| 时刻 | 对话里要出现 |
|---|---|
| 检测到扫码完成 | 「✅ 登录成功，正在取 6 个频道的数据…」 |
| 取数完 | 一句话汇总：UID / 总抽数 / 校验结果 |
| 全部结束 | 报表路径 + 关键指标，明确「完成」字样 |

**不要只打终端日志就算数**——用户不看终端。也不要闷头跑完才一次性汇报，
中段那几秒正是用户最没底的时刻。

**二维码卡片要紧凑**：只放「二维码图片 + 一行文字」。不要用 keyvalue 逐行罗列时间，
一项两行会把卡片撑得很高，白占屏幕。那一行文字**按档位写**：

> A 档：`15:34:21 生成 · 15:36:21 失效 · 扫完自动继续`
> B 档：`15:34:21 生成 · 15:36:21 失效 · 扫完回我一句「已扫码」`

两种档位都**必须传同一个 `--profile`**，否则 B 档第二次运行会丢登录态（Playwright 默认用临时 profile）。

## 3. 点「登录」，把二维码交给用户

### 3.1 先问一句：扫码还是短信？

| 方式 | 前提 | 怎么跑 |
|---|---|---|
| **扫码（默认）** | 用户装了米游社 App | `node scripts/collect.mjs` |
| **短信验证码** | 没装 App，或手机不在身边 | `node scripts/collect.mjs --login=sms` |

**必须先问**：不要假设用户装了米游社。一句话确认即可——
「用米游社 App 扫码，还是收短信验证码？」

## 输入通道：用户在对话里说，agent 送进进程

**用户不会操作终端。** agent 开终端跑脚本，是因为自己需要那个进程；
用户面对的只有对话框。所以脚本**不能**停下来等 stdin —— 那是个永远不来的输入源。

短信登录的两个值，都走「agent 转交」：

| 值 | 怎么给进程 | 说明 |
|---|---|---|
| 手机号 | `--phone=13xxxxxxxxx` | agent 在对话里问，拿到后直接传参 |
| 验证码 | 写入 `<data>/_verify/sms-code.txt` | 短信到了才知道码，文件是最顺的通道 |

`--phone-file=<路径>` 和 `--code=<码>` 也支持，看哪种方便。
验证码文件**读一次就删**，不在磁盘留底；格式不对只提示、不退出，等下一个。

三条硬规则：
- 「获取验证码」**只点一次**，绝不自动重试（频繁请求会触发风控）。
- 验证码约 60 秒失效，agent 拿到就要立刻写入，别攒着。
- 脚本只把值填进官方表单，不代填、不猜、不落盘（除验证码文件的瞬时中转）。

### 短信表单长什么样（改代码前必读）

登录框是 Element UI，几个不写下来必然踩的点：

| 元素 | 选择器 | 注意 |
|---|---|---|
| 手机号输入框 | `input[placeholder*="手机号"]`，`maxlength=11` | 只收 11 位 |
| 验证码输入框 | `input[placeholder*="验证码"]`，`maxlength=6` | — |
| 区号 | `.area-code` 文本 `+86` | **写死的，没有下拉**，所以只支持国内号 |
| 协议勾选 | `input[type=checkbox]` | **不勾会卡在校验上**，必须在点发送前勾上 |
| 发送按钮 | 文本含「获取验证码」 | 未填手机号时是 `disabled` |
| 提交按钮 | 文本精确等于「登录」 | 同上 |

**填值必须用原生 setter + 事件，直接赋值 `el.value = x` 无效**（Element UI 读的是内部状态）：

```js
(() => {
  const el = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('手机号'));
  if (!el) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '13xxxxxxxxx');
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()
```

**表单是异步渲染的**：刚拿到 frame 时 DOM 里往往还没有这些 input。
必须**轮询等它出现**（等 ~10 秒），查一次就判「页面结构变了」是错的。

登录判定沿用 §4 的口径。提交后最多等 60 秒；仍无登录态就报「验证码错误或需要滑块验证」，
**不要重复提交、也不要重新发短信**。

只有**用户明确说自己在本机命令行手动跑**时，才会走 stdin 提问；
非交互环境下没给值会立刻报错说明，不会挂住。

扫码阶段的「换一张二维码」同理：终端里按 `r` 只对本地手动跑有效，
agent 代跑时写 `<data>/_verify/qr-refresh` 这个信号文件触发。

登录框是**跨域 iframe**（`user.mihoyo.com/login-platform`），外层 DOM 读不到，必须用 C3。

1. 用 C2 按元素点「登录」按钮。按钮可能 `disabled`（账号 SDK 未初始化）：报 disabled 就等 2–3 秒重试**一次**，不要连点。

2. 用 C3 等到登录 frame 出现，在 frame 内执行 JS：

   ```js
   // 在登录 frame 内
   ({ hash: location.hash, hasQrBtn: !!document.querySelector('.qr-login-btn--wrapper') })
   ```

3. **登录框默认是「短信登录」，不是扫码。** 要切到扫码：点 `.qr-login-btn` 这个图标（默认 32px，hover 才显示「扫码登录」气泡）。
   点不动就先试坐标点击，再不行才请用户点一下。

   **判断当前处于哪个模式，只认 `location.hash`，不要靠图片尺寸猜：**

   | hash | 模式 |
   |---|---|
   | `#/login/captcha` | 短信登录（默认落在这里） |
   | `#/login/qr` | 扫码 |

   踩过的坑：早先按「有没有 ≥120px 的图片」判断，但**短信页里本来就有一张 232×80 的横幅图**，
   于是误判成「已在扫码模式」，打印了一个根本不存在的二维码路径——用户拿着扫，扫半天没反应。
   正确的判据是 hash，再叠加「图片近似正方形」作为二次确认：

   ```js
   (() => {
     const qr = [...document.images]
       .filter(i => (i.src || '').startsWith('data:image'))
       .map(i => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.src }))
       .find(i => i.w >= 120 && i.h >= 120 && Math.abs(i.w - i.h) <= 8);   // 近似正方形
     return { hash: location.hash || '', hasQr: !!qr, qr };
   })()
   ```

   实测真二维码 **260×260**；登录框里另有一张 60×60 的 logo 也是 data URL，靠上面的尺寸条件滤掉。
   切模式时首轮可能报 `no-target`（图标还没进 DOM），**多等几轮再判定**，别一次就报错。


4. **二维码是 data URL，直接读，不要截屏裁图。** 切到扫码后，frame 里会出现一张二维码 `<img>`：

   ```js
   (() => {
     const imgs = [...document.images].filter(i => i.src.startsWith('data:image'));
     const qr = imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))[0];
     return qr ? { src: qr.src, size: [qr.naturalWidth, qr.naturalHeight] } : null;
   })()
   ```

   注意滤掉登录框里那张 60×60 的 logo（同样是 data URL）：按 **宽高 ≥ 120 且近似正方形** 筛。
   实测真二维码是 200×200 ~ 260×260。只有拿不到 data URL（比如二维码画在 canvas 上）时才退回截图。

5. **把二维码交给用户。先探测能力，再按探测结果降级。**

   不要假设任何宿主的组件名。先问自己三句话，落到哪一档就用哪一档：

   | 探测 | 结论 |
   |---|---|
   | 能把二维码**连同按钮/倒计时一起渲染成一块可交互的 UI**？ | 走 A 档 |
   | 只能把图片**内联显示在对话里**？ | 走 B 档 |
   | 只能把图片**存成文件**给路径？ | 走 C 档 |

   **A 档：动态 UI（宿主有 GenUI / 富组件 / 卡片渲染能力）**

   渲染一张「扫码登录」卡片，必须包含：二维码、截取时刻、失效时间、**倒计时**、**刷新按钮**。

   **二维码一律给图片 URL，不要把图形塞进对话。**

   同一张 260×260 二维码，三种交付方式的代价（已实测）：

   | 方式 | 对话里的字符量 | token 成本 | 结论 |
   |---|---|---|---|
   | **图片 URL**（`<image src="http://127.0.0.1:PORT/x.png">`） | ~60 | **~10** | ✅ 唯一采用 |
   | SVG 源码内联 | 7361 | ~2100 | ❌ **已废弃** |
   | base64 塞 `<image src>` | ~8200 | 组件丢弃 | ❌ 不支持 |

   **差 200 倍。** SVG 内联不仅贵（刷新 3 次就是 6000+ tokens 白烧），
   而且在流式输出里要等文本传完才开始渲染——用户先盯着一个灰块等半天。
   这个方案已经废弃，**不要再捡回来**。

   `collect.mjs` 内置了一个**只读图片服务**，采集时自动起、结束自动关：

   ```
   [zzz] 二维码图片服务：http://127.0.0.1:64262/（仅本机、只读、取完即关）
   [zzz] 二维码图片地址：http://127.0.0.1:64262/login-qr-20261120100855-1.png
   ```

   把日志里那行 **`二维码图片地址`** 原样放进图片组件的 `src`。服务的三条约束：

   - 只监听 `127.0.0.1`，外网访问不到
   - 只服务 `.png`，且路径锁死在二维码目录内（挡目录穿越）
   - 端口由系统分配（`listen(0)`），不会撞车；采集结束由 `finally` 关闭

   如果日志里**没有** `二维码图片地址`（服务没起来，例如环境受限），按下面降级：

   | 顺序 | 做法 |
   |---|---|
   | 1 | 宿主自己的文件路由（注意别把含 UID 的 `data/` 整体暴露） |
   | 2 | 给 PNG 文件路径，让用户自己打开 |

   ⚠️ **`data:` / base64 塞进 `<image src>` 基本都不 work。** 多数富组件渲染器会丢弃
   `data:` 和 `file:` 协议（DSH GenUI 的 `image` 组件就明确不支持）。

   - **有效期按 120 秒**倒计时，顶部写清 `HH:MM 截取` 与失效时刻。
   - 倒计时归零 → 卡片切到「已过期」态，刷新按钮变为可用。**只改展示，不要自动去取新图。**
   - 刷新按钮要能**原地更新同一张卡片**（而不是每次刷新都新发一条消息）——用宿主支持的
     原地更新 / 面板（例如 DSH GenUI 的 `panel: true`、组件上的 action）来实现。
     **这个能力是可选的**：宿主不支持原地更新就退回「重新发一张卡片」，不要为此去猜私有 API。

   **B 档：只能内联贴图**

   直接显示二维码图片（宿主支持 base64 内联就内联；只吃文件路径就先落盘再引用），
   并在消息里写清「`HH:MM` 截取，约 2 分钟后失效，过期告诉我我再换一张」。

   **C 档：只能给文件**

   存成 PNG 并给出路径，明确让用户去打开它扫；同样要给出截取时刻和失效时间。

   **三档共同要求：**

   - **只认当次拿到的图。** `data/_verify/` 下的历史截图一律禁止复用。
   - **换图必须换文件名。** 覆盖同名 PNG 时，浏览器/图片组件/CDN 都可能继续显示旧图，
     用户扫到的是一张已经作废的码。用 `login-qr-<时间戳>.png` 这种唯一名，
     不要靠 header 去赌缓存。
   - **刷新后必须重置计时起点。** 换到新码却还拿旧 `issuedAt` 算过期，新码一生成就被判失效——
     这个 bug 会让用户永远扫不到有效码，且只在「过期→刷新→继续等」路径下才显形。
   - **绝对不要做自动循环刷新。** 用户可能正好去忙别的事、没看对话流，
     你的定时器会在后台反复请求登录二维码——那是在锤对方的登录接口，有触发风控/封禁的风险，
     而且用户回来只看到满屏废弃的二维码。刷新**只能由用户主动触发**，并遵守第 7 步的限流。
   - 用户说扫不到时，先调大显示尺寸、确认白底静区；还不行再换一张。
   - **算好时间再发。** 二维码只有 120 秒，agent 从截图到渲染完卡片可能已过去几十秒。
     发出前确认剩余有效期，剩不到 60 秒就先换一张再发，别让用户拿到一张快死的码。

6. 告诉用户「请用米游社 App 扫码，约 2 分钟失效」，然后**停下来等用户回话**——不要轮询到超时再问。
   用户说扫不到/过期时，重拿一张再渲染，不要让用户自己去浏览器里找。

7. **刷新限流（硬约束）。** 二维码是对方登录接口下发的，频繁重取有风控风险：

   - 只在用户**明确要求**（「过期了」「刷新」「扫不到」）或用户点了卡片上的刷新按钮时才重取
   - **单次会话最多重取 3 次**；到上限就停下，让用户检查网络/换浏览器，不要继续重试
   - 两次重取之间至少间隔 **5 秒**，不要连发
   - 用户没有回应时**不要自行重取**：宁可停下来等，也不要空转
   - 如果连续两次都立刻失效，多半是登录态或风控问题，直接告诉用户，不要再刷

   > 没有 C3 时的降级：请用户在浏览器里自己点「登录」→ 点左上角扫码图标 → 扫码。你从第 4 步接着做。

## 4. 确认登录成功

用 C2 轮询（每 3–5 秒，最多约 2 分钟），命中任一即成功：

- 出现 `UID` + 6 位以上数字
- 出现「总调频次数」「调频资源总览」等已登录文案

扫码确认后页面通常 10–20 秒内**自己刷新**成统计页，不需要手动 reload，也不要重复点登录。一直不成功就回第 3 步重拿二维码。

## 5. 取 uid 与 region

用 C4 找 URL 含 `/api/zzz/index` 的请求，读它的 `uid` / `region` 查询参数。

- 找不到（例如打开时就已登录、请求发生在监听之前）→ **reload 一次**再读。
- 仍找不到 → uid 用页面显示的 UID，region 按 `prod_gf_cn` 兜底，并在结果里注明「region 为兜底值」。

## 6. 逐个接口取数

顺序：`index` → 6 个频道的 `hist_pool_stat` → 6 个频道的 `cur_pool_stat`，两次请求之间停 300–500ms。

```
{api}/api/zzz/index?uid={uid}&region={region}
{api}/api/zzz/hist_pool_stat?uid={uid}&region={region}&gacha_type={t}&vers={v1,v2,...}
{api}/api/zzz/cur_pool_stat?uid={uid}&region={region}&gacha_type={t}
```

- `{t}` 依次取 `2, 3, 102, 103, 1, 5`（独家 / 音擎 / 独家重映 / 音擎回响 / 常驻 / 邦布）。
- **`vers` 必须用该频道自己的 `type_stats[].has_data_vers`，且单次最多 10 个。** 用所有频道的并集、或一次塞 20 个版本，接口会返回 `-400005 参数错误`。
- 版本数超过 10 时分片：按版本号降序每 10 个切一片，逐片请求，再把各片的 `data.list` 合并去重。页面自己只拉最近 8 个版本，分片才能拿到更早的历史。

**取数方式：在官方页面的上下文里 `fetch`。** 一次导航，后面全部页内请求，比「导航到接口 URL 再读 body」快一个数量级：

```js
// 在 act.mihoyo.com 页面内执行：只有这个源被接口的 CORS 放行
const BASE = 'https://act-api-takumi.mihoyo.com/event/nap_gacha_record/api/zzz';
const qs = `uid=${uid}&region=${region}`;
const get = async (path, extra = '') => {
  const url = `${BASE}${path}?${qs}${extra ? '&' + extra : ''}`;
  const res = await fetch(url, { credentials: 'include' });
  return res.json();                       // { retcode, message, data }
};

await get('/index');                                       // 汇总
await get('/cur_pool_stat', 'gacha_type=2');               // 当前卡池
await get('/hist_pool_stat', 'gacha_type=2&vers=3.3,3.1');  // 历史（versions 自己分片）
```

> 若宿主用 `browser_evaluate` 这类会包一层字符串的工具，把上面的脚本写成**文件**再传（C2 的「长脚本走文件」）。
> 只有在无法页内 fetch 时才退回「导航到接口 URL + 读 `document.body.innerText`」；那条路径记得先截到第一个 `{`，并关掉临时标签页。

### 6.1 两条路线，按会话能力选

**路线 A：跑脚本**（会话里有命令行、能起浏览器）

```bash
node scripts/collect.mjs
```

**路线 B：只借两个能力**（会话里有浏览器工具，但跑不了/不想跑 Node 脚本）

取数逻辑本身很简单，只要你能「打开页面」+「在页面里执行 JS」：

1. 用会话自带的工具打开官方页面，让用户扫码登录
2. 把 `scripts/fetch-in-page.js` 的**整个文件内容**作为表达式执行
3. 把返回的 JSON 交给 `node scripts/save-in-page-json.mjs` 落盘（或你自己拆成 `data/` 那几个文件）

```bash
node scripts/save-in-page-json.mjs --in result.json   # 或 echo '<json>' | node scripts/save-in-page-json.mjs
```

这条路不依赖 Playwright、不依赖 CDP、不要求本机开调试端口——**只要有「页内执行 JS」这一个能力就够**。
`fetch-in-page.js` 会自己处理频道顺序、`vers` 分片、去重和 `retcode` 校验。

> 两条路线产出完全一致，都会走同一个 `build-report.mjs`。
> 差别只在「谁来驱动浏览器」：A 由脚本驱动，B 由会话自带的工具驱动。

**建议直接跑 `scripts/collect.mjs`**，它把 A 路线都包好了；只有在用 B 路线时才需要手动粘脚本。

## 7. 落盘

**数据写到当前工作区的 `zzz-stats/data/`，不要写进 skill 自己的目录**（skill 升级会覆盖，也容易误提交）。

```
data/meta.json
data/index.json
data/cur_pool_stat_<t>.json
data/hist_pool_stat_<t>.json
```

- 写之前校验 `retcode === 0`；`-100` 说明登录失效，回第 3 步。
- `meta.json` 至少含：`schema`（`zzz-stats/v1`）、`server`、`uid`、`region`、`fetched_at`、`versions`、`source`，以及 **`nickname`**。
- 昵称不在任何接口里，只能从页面 DOM 文本读（登录后标题处的名字）。读不到就留空，报表会显示 `—`。
- JSON 原样保存，不要改字段名、不要转时间格式。

## 8. 校验

```
sum(cur_records[].count) + type_stats[].next_s_cur_times == type_stats[].total_count
```

逐频道比对。左边是「已出金抽数 + 当前垫抽」，右边是官方总抽数——**它校验的是抽数，金数对得上但记录缺抽也会在这里露出来**。`scripts/build-report.mjs` 会自动跑这条并报警。

另外两条容易踩的：

- `index.total_gacha_count`（实测 3714）与 `total_s_count`（实测 62）**都不含邦布**。六个频道相加是 5375 / 96。报表里两个口径要分开写清楚。
- `sort` 是**频道内跨池连续**的全局序号（各频道各自从 1 开始），不是账号全局、也不是池内序号。`count` 恒等于相邻两条的 `sort` 差。

## 9. 出报表：直接用模板，不要重新发明

```bash
node scripts/build-report.mjs                          # 读 data/，写 output/report.html
node scripts/build-report.mjs --data data --out output/report.html
```

> **参数两种写法都支持**：`--out output/x.html`（空格）和 `--out=output/x.html`（等号）。
> 这条专门记下来，因为早期两个脚本都只认空格形式，传等号会被**静默忽略、悄悄用默认值**——
> 不报错、不提示，你以为写到了 A，实际写在 B。`collect.mjs` 的 `--login=sms` 和
> `build-report.mjs` 的 `--out=` 都栽过。改参数解析时，两种形式都要覆盖。

输出 `output/report.html`（默认路径，已被 `.gitignore` 忽略；换用 `--out` 可改）：
**真正的单文件**——数据、ECharts、以及用到的图标全部内嵌，
可以直接发给别人、单独打开，不需要附带 `assets/` 目录。
控制台会打印关键指标与校验告警——**把这些告警当失败处理，不要带着告警交付**。

**默认不要读 `references/report-rules.md`。** 模板已经实现全部规则，一条命令就是完整产物。
只有当下面任一情况成立时，才去读那份规范：

- 用户要**定制版式**，模板给不了
- 你要**改口径 / 改配色 / 改标签逻辑**
- 模板跑出错误，需要判断是数据问题还是实现问题

### 三层分工（改东西前先认层）

| 层 | 位置 | 改什么 |
|---|---|---|
| **配置** | `config/report.json` | 称号分档、标签阈值与去重、配色值、文案、图例、频道定义、隐私规则。**90% 的调整都在这层** |
| **实现** | `scripts/build-report.mjs` + `assets/report/` | 口径算法与版式。改这层要同步 `report-rules.md` |
| **资源** | `assets/report/icons/`、`assets/avatars/`、`assets/items/` | `icons/` 是 64px 压缩版，**构建时内嵌进 HTML 用的就是它**；`avatars/` 与 `items/` 是 96px 原图，供重新生成 `icons/` |
| **规范** | `references/report-rules.md` | 记录「为什么这样算、为什么这样画」以及踩过的坑。**不要为了改行为去改它**；它是给维护者看的 |

改配置不需要读规范；改实现必须先读规范、改完再回来同步。

**新增角色/音擎图标后要重跑一次压缩**（否则报表里那张图会用占位图）：

```bash
python3 -m pip install pillow      # 只需一次
node scripts/make-icons.mjs        # assets/{avatars,items}/ 96px → assets/report/icons/ 64px
```

`make-icons.mjs` 会把头像做圆形透明蒙版、物品保持方形，边长统一缩到 64px。
报表构建时把这些 64px 图 base64 内嵌进 HTML——**不缩就会让产物从 3.7 MB 涨到 6 MB+**。

## 失败处理

| 现象 | 处理 |
|---|---|
| 没有任何浏览器能力（C1/C2） | 直接说明缺什么，不要硬试 |
| 拿不到跨域 iframe（无 C3） | 让用户自己在浏览器点登录 + 扫码，从第 4 步接手 |
| 页面卡在「加载中」 | 标签页被节流，切前台或给真实视口 |
| 点登录报 `Click target is disabled` | 账号 SDK 未就绪，等 2–3 秒重试一次，不要连点 |
| 二维码没出现 | 登录框默认短信登录，要点 `.qr-login-btn` 图标；点不到请用户点 |
| 用户说扫不到 | 二维码放到 ≥200px 且保持纯白底；改用 frame 内 `img` 的 data URL |
| 坐标点击报 `requires layout hit testing` | 说明该实现不支持坐标输入：改回按元素 click |
| 页内 fetch 报 CORS | 必须在 `act.mihoyo.com` 页面上下文里请求 |
| 接口返回 `-100` | 登录态失效，回第 3 步重新扫码 |
| 接口返回 `-400005 参数错误` | `vers` 超过 10 个或用了不属于该频道的版本，分片重来 |
| 接口返回非 0 且非 -100 | 原样把 `retcode` / `message` 报给用户，不盲目重试 |
| 页面改版、接口路径变了 | 看 `index_*.js` 里的 `/api/zzz/*` 路径，更新本文件与 `references/api.md` |
| 误报「已在扫码模式」，用户扫了没反应 | 用 `location.hash` 判断，别用图片尺寸 —— 短信页有张 232×80 的横幅会骗过尺寸判断 |
| 换图后新码立刻显示「已过期」 | 刷新时忘了重置计时起点（`issuedAt`），新码还在用旧时间算 |
| 用户扫的还是上一张废码 | 二维码覆盖了同名文件，浏览器/组件缓存了旧图；改成带时间戳的新文件名 |
| 用户说「扫了但没反应」，其实早跑完了 | 进程结束时没有可见反馈；见 §2.1「两种档位都要给用户可见的回应」 |
| 等了半天才有回应 | 用 `sleep N` 等扫码了；应让等待跟着进程走（`job_output` + `wait`），不要定时轮询 |
| 短信表单「找不到」 | 表单异步渲染，要轮询等 DOM 出现；别查一次就判失败 |
| 短信字段填不进去 | 直接赋 `el.value` 无效，Element UI 需要原生 setter + `input`/`change` 事件 |
| 短信一直提交不了 | 协议 checkbox 没勾；未勾选时提交按钮卡住 |
| 短信收了验证码却登录失败 | 验证码约 60 秒失效；也确认区号只有 `+86`（页面写死，不支持境外号） |
| 参数传了没生效 | 检查两种写法都支持：`--k v` 和 `--k=v`，早期只认前者会静默忽略 |

## 数据产物

```
data/
├── meta.json                 # 区服、UID、昵称、拉取时间、覆盖版本
├── index.json                # 6 个频道的汇总统计
├── cur_pool_stat_2.json      # 当前卡池（按频道，6 个）
├── hist_pool_stat_2.json     # 历史卡池 + 每金记录（按频道，6 个）
└── _verify/
    ├── login-qr-<时间戳>-<序号>.png   # 当次二维码（每次换图都是新文件名，防缓存）
    ├── qr-refresh                    # 写入即触发的「换一张」信号（无终端时用）
    └── sms-code.txt                  # 短信验证码中转，读一次就删
```

`data/` 整体被 `.gitignore` 忽略。

字段说明见 `references/api.md`，口径与呈现见 `references/report-rules.md`。

## 安全说明

- 该页面只认登录 cookie，URL 里没有 authkey；因此本方案不会产生任何可被复用的抽卡凭证链接。
- **不要尝试「导出 cookie 再 curl」**。`document.cookie` 只能看到 `ltuid_v2` / `account_id_v2` 这类标识，真正的鉴权凭证 `ltoken_v2` / `cookie_token_v2` 是 HttpOnly；CDP 的 `Storage.getCookies` 虽然读得到，但那等于把**完整账号凭证**落盘，风险比 authkey 高一个量级。用浏览器代发请求就够了。
- 「登录一次、后续免登录」靠的是用户自己 Chrome 里的会话；`retcode:-100` 才是真的过期。
- **`data/` 必须被 `.gitignore` 忽略**，里面有 UID 和每一金的记录。
- **手机号 / 验证码不进代码、不进文档、不入库。** 它们只由用户在对话里提供，agent 转交时
  走命令行参数或一次性文件；验证码文件读完即删。写测试、写示例一律用占位符。
- **二维码图片服务是临时的。** 只绑 `127.0.0.1`、只服务 `.png`、路径锁死在二维码目录，
  采集结束由 `finally` 关闭。**不要**改成 `0.0.0.0`、**不要**把整个 `data/` 挂出去
  （里面有 UID 和每金记录）、**不要**让它常驻。
- **不要在对话里回显完整手机号**，需要提示时打码（`134****0891`）。
