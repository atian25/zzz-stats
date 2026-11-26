# 采集拆分历史

各轮用例项数是当时实测快照，不统一改成今天的项数；当前测试列表与契约见本目录 AGENTS.md 和 api.md。

以下从旧报表规范迁出，保留当时验收数字用于追溯，**不是当前接口或开发指令**。旧路径、导出、cfg/transport 参数及后来撤销的约束以本目录现行文档为准。

### 第三轮：把「登录 + 采集 + 出报表」抽成 `lib/` SDK（2026-11-24）

前两轮解决的是**产物内部**（内嵌原料还是结果）。这一轮解决的是**代码复用**：
改前采集与出报表各自是一份千行脚本，算法和命令行混在一起，想从服务里复用只能整份复制。

| | 改前 | 改后 |
|---|---|---|
| 采集算法在哪 | `scripts/collect.mjs`（1027 行，含参数解析 / 落盘 / 信号处理） | `lib/collect.mjs` + `lib/login-*.mjs` + `lib/transport-node.mjs` |
| 出报表算法在哪 | `scripts/build-report.mjs`（1002 行，含读盘 / 写文件 / `process.exit`） | `lib/build.mjs` |
| 外壳还剩什么 | ——（本来就没有分层） | 参数、日志、目录、落盘、退出码、二维码图片服务、信号处理 |
| SDK 会不会写盘 | —— | **不会**。`collectData()` / `buildReport()` 只返回数据 |
| 取数路径 | 只有浏览器（页面内扫码 + 页内 fetch） | `node`（默认，纯 HTTP）/ `browser`（原路），节点失败自动降级并打一行 |

两条边界写在 `lib/index.mjs` 的文件头，改之前先读：

1. **SDK 只返回数据，不写盘。** 落盘位置、目录名、失败时写不写文件都是外壳的决定 ——
   服务里没有 `exit`，用例里不该落文件。
2. **SDK 不读 `process.argv`、不调 `process.exit`。** `buildReport()` 的 `fatal` 是
   **返回数组**而不是抛异常：外壳照旧打印 `✖` 再 exit 1，服务可以返回 422，用例能断言具体条目。

`files` 的键必须与 `output/<账号名>/data/` 下的文件名完全一致（14 个）。用 `Map` 保留插入顺序，
写出来的目录和改前一样。`buildReport()` 同时收 `Map` 与普通对象（Node 外壳读盘给对象）。

#### 纯 Node 那条路是逆向结论，不是公开 API

`lib/login-node.mjs` / `lib/transport-node.mjs` 里的常量（`x-rpc-app_id: cieb8o6xs1kw`、
`x-rpc-client_type: 4`、`x-rpc-game_biz: nap_cn`、`x-rpc-sdk_version: 2.57.0`、cookie 名、
`game_biz=nap_cn`）全部抄自官方页面当时的真实请求。**它会静默失败**：接口变了不会报
「接口不存在」，而是回一个业务错误码。出问题按这个顺序怀疑：

1. `x-rpc-app_id` —— 用 `unknown` 或旧值会一直 `-3005`「参数不合法」（看着像 cookie 坏了）
2. cookie 名（`cookie_token_v2` / `ltoken_v2` / …）—— 改名就登不上
3. `x-rpc-game_biz` —— `nap_cn` 只对应国服；国际服是另一套域名与 biz，本实现不做

另外两个数据流事实（当时排查成本极高，必须记住）：

- **token 不在 `data.tokens` 里**（永远空数组），在 `Set-Cookie` 响应头；且**只在第一次拿到
  `Confirmed` 的那次响应**里下发，再查一次就没了。所以必须在同一个响应里当场抓 set-cookie，
  不能「先返回再补查」。
- **游戏 UID ≠ 米游社账号 ID。** `game_uid` 要另查 `getUserGameRolesByCookie`；
  拿 `queryQRLoginStatus` 的 `user_info.aid` 去打游戏接口会一直 `-100`「请先登录」。
- 拼 Cookie 头时**排除 `aliyungf_tc`**（阿里云 CDN 的会话 cookie，与登录无关）。

实测（2026-11-24）：`loginWithQr()` 在真实网络下能拿到 ticket 并编出 320px 二维码，
轮询进入 `Created`。**扫码确认这一段需要人操作，没有自动化验证过** —— 这一点别在文档里
写成「已端到端验证」。

#### 降级：只在 CLI，SDK 不做

`--transport node|browser`，默认 `node`。node 失败（国际服 / 私有 header 失效）**自动降到
browser，并明确打一行说明为什么降级**。静默换路最难查：用户以为走的是纯 Node，
实际弹出一个浏览器要扫。`--transport node` 显式指定时**不降级**，失败就报错 ——
显式选择要能被信任。

**这条策略的位置是有讲究的：它只写在 `scripts/collect.mjs` 里，`lib/` 一个字都没有。**
SDK 暴露四个并列函数，各管各的、只抛错：

| 动作 | 纯 Node | 浏览器 |
|---|---|---|
| 登录 | `loginByQrNode({ onQr })` → `{ cookieHeader, uid, gameUid }` | `loginByQrBrowser({ headless, onQr })` → `{ uid, drv }` |
| 取数 | `collectViaNode({ cookieHeader, uid })` → `{ files, summary }` | `collectViaBrowser({ drv })` → `{ files, summary }` |

`collectData({ transport })` 保留着，但它只是「按你给的那条调对应那一个」，
**没有 switch 到另一条的逻辑、没有 catch、没有重试**。

为什么这么切：策略会随部署形态变 —— 服务那边将来可能只用浏览器、或 node 失败就整体报错
不降级。把策略写进 SDK，等于替所有调用方做了决定，而且调用方**再也没法知道**
「node 这条路其实失败了」（它只会看到成功）。

`packages/sdk/test/test-sdk-transport.mjs`（15 项，第 3、4 段）把这条钉成断言，其中关键一条是
「`transport=node` 失败时浏览器的扫码回调一次都不许被调到」。反向验证过：
在 SDK 的 node 分支里注入一个 `catch` 后改走 browser，用例立刻报红、exit 1。

CLI 的判据是「用户有没有显式传 `--transport`」。注意 `argOf()` 的默认值会掩盖这件事
（`argOf('transport','node')` 对「没传」和「传了 node」返回同一个字符串），
所以实现里取默认值 null、再自己补 `'node'`。

### 第八轮：目录重构——采集进 `packages/`，渲染器留在 skill（2026-11-25）

前三轮把算法从外壳里抽出来，但**全抽进了 `skills/zzz-stats/lib/`**。这一轮按一条判据重新分：
**它依赖 skill 资源吗？**

判据不是「名字里有没有 lib」。`build.mjs` 有 9 处读 `assets/report/template.html`、
`charts.{js,css}`、`core.js`、`icons/`、`assets/vendor/echarts.min.js` —— 它是**这份报表的渲染器**，
不是通用 SDK。采集那一边（登录、取数、二维码编码）**一次都没读过 `assets/`**。

| | 改前 | 改后 |
|---|---|---|
| 采集 | `skills/zzz-stats/lib/` | **`packages/sdk/`**（仓库根，与 skill 无关，可独立复用） |
| 报表渲染器 | `skills/zzz-stats/lib/` | **留在 `skills/zzz-stats/lib/`** |
| Web 服务 | `skills/zzz-stats/scripts/serve.mjs` + `assets/serve/` | **`packages/server/`**（`serve.mjs` 与前端三件套同目录） |
| 两个出口 | `lib/index.mjs` 一个 | `packages/sdk/index.mjs`（**没有** `buildReport`）+ `lib/index.mjs`（渲染） |

```
packages/sdk/                 采集层（不读 assets/）
  index.mjs                   统一出口 —— 没有 buildReport
  collect.mjs  login-node.mjs  login-browser.mjs  transport-node.mjs
  qr.mjs  drivers.mjs  qr-wait.mjs
packages/server/              本地 Web 服务
  serve.mjs  index.html  app.js  style.css
skills/zzz-stats/
  lib/                        报表渲染器（读 assets/report/**）
    index.mjs  build.mjs  core-inline.mjs  template-tokens.mjs
  assets/report/  assets/vendor/  config/  references/  scripts/
```

#### 配置的给法也跟着分开了，这是接口变更

`collectData({ cfg })` 的 `cfg` **变成必传**：采集层搬出 skill 之后，
`resolve(HERE, '..')` 在 `packages/` 下指向 `packages/`，猜不到 `config/report.json` 在哪。
不传就在入口抛一条说清原因的错误（**不兜底、不读环境变量**）。

`buildReport({ files, cfg })` 的 `cfg` **仍是可选**：渲染器就在 skill 里，
`SKILL_DIR = resolve(HERE, '..')` 天然正确。两个出口在这点上的不对称是刻意的，不是漏改。

#### `docs/preview.png` 缺失时的降级

`serve.mjs` 搬进 `packages/server/` 后，到仓库根多了一层。顺手修了老问题：
skill 被单独安装、或服务被拷到别处时，`docs/preview.png` 根本不存在。
早先直接 `join(REPO_DIR, 'docs/preview.png')` 读不到就 404，介绍页背景一片空白。

现在**有就正常服务 `/assets/preview.png`，没有就回 204**：前端背景自然留白、console 无 error，
启动横幅上打一行警告，不静默。

#### 为什么 `drivers.mjs` / `qr-wait.mjs` 跟着搬

不是为了「都在 packages 下」凑数：`login-browser.mjs` **静态依赖**这两个文件，
且它们自身都不读 skill 资源（`drivers.mjs` 用 `createRequire` 找 playwright，
`qr-wait.mjs` 的信号文件路径由入参给）。留在 skill 里会让 `packages/sdk/` 反向依赖 skill。

#### 验收（2026-11-25 实跑）

| 验收项 | 结果 |
|---|---|
| 七套用例 | **28 / 47 / 55 / 25 / 75 / 27 / 30** 全过（`test-lib-transport` 从 19 涨到 28，新增 9 条目录边界断言） |
| 两个入口能导入 | `packages/sdk/index.mjs` 导出 19 个符号、`'buildReport' in m === false`；`lib/index.mjs` 含 `buildReport` |
| 真构建两份产物 | `output/绳匠A/report.html` 2,318,338 字节、`output/绳匠B/report.html` 2,383,188 字节 |
| 占位符残留 `/*__` | 两份均 **0** |
| 服务静态资源 | `/` 200、`/assets/app.js` 200（`text/javascript`）、`/assets/style.css` 200、`/assets/preview.png` 200（681,185 字节）、`/favicon.ico` 204 |
| 路径穿越 | `/assets/../skills/zzz-stats/lib/build.mjs`、`/assets/../../packages/sdk/collect.mjs`、`/assets/%2e%2e/...` 等 **6 种写法全 404，源码 0 泄漏** |
| `/report` 不带 runId | `400`（不猜「最近一个」） |
| 前端验收 | **29/29**（二维码 320×320、遮罩、390 窄屏无溢出、console 0 error） |
| 多人隔离 | **24/24**（两码 994 / 1042 字符，各跳自己 runId，`output/` 全程 `绳匠A,绳匠B` 无新目录） |

> `test-lib-transport.mjs` 的 9 条新断言包括一条方向性的：
> 「把 `build.mjs` 复制回 `packages/sdk/` 会明确报红」——
> 反向验证过，不是靠「现在恰好没有那个文件」通过的。
> （该文件在第九轮已按层拆成两份，见下。）


### 第九轮：用例按层拆分，`api.md` 跟着采集走（2026-11-25）

第八轮的分层做完了，但**用例和文档还混在一起**：一份 `test-lib-transport.mjs` 里同时测采集与渲染，
`references/api.md` 记的是米游社接口逆向结论，却留在只该放「怎么出报表」的 `references/` 下。

| | 改前 | 改后 |
|---|---|---|
| 采集层用例 | `skills/zzz-stats/scripts/test-lib-transport.mjs`（28 项混在一起） | **`packages/sdk/test/test-sdk-transport.mjs`（15 项）** |
| 渲染层用例 | 同上 | **`skills/zzz-stats/scripts/test-render-contract.mjs`（13 项）** |
| 接口文档 | `skills/zzz-stats/references/api.md` | **`packages/sdk/docs/api.md`** |
| `references/` 还剩什么 | `api.md` + `report-rules.md` | 只留 `report-rules.md`（「怎么出报表」的规范） |

#### 拆分的判据：它读不读 `skills/zzz-stats/`

> 以下 cfg/encodeQr 注入与 15 项用例是拆分当时的历史记录。五名公共接口落地后，SDK 不再接受 cfg；编码器通过 dependencies 注入，SDK 契约测试已改为 49 项。CLI 迁移使用 channel + login.method，QR/TTY/文件刷新/凭据清理留在 skill，TTL 读取 progress。npm qrcode 已替代 skill 的 QR vendor，旧 vendor 目录已删除。

这是**可执行的**判据，不是「看着像哪层」：把 `packages/sdk/` 整个拷到别处、
父目录里没有 `skills/`，那份用例还能不能跑。

搬的时候撞到一个真实冲突：第 3 段原本 `readFileSync(join(SKILL_DIR,'config/report.json'))`
读 skill 的配置、还指 `assets/vendor/qrcode/core/qrcode.js`。**照搬过去就不是纯采集测试了。**
改法是让这两样都由用例自己给：

```js
const MIN_CFG = { channels: [] };                        // 内联最小 cfg
const fakeEncodeQr = async () => 'data:image/png;base64,FAKE';  // 接管编码，不碰 vendor
```

**断言判据一个字都没改**（还是 `/FAKE_NETWORK_DOWN|申请二维码失败/` 与「没走浏览器回调」），
只是让被测的东西不再依赖 skill 资源。这也顺带证明了 `collectData()` 的 `cfg` 与 `encodeQr`
确实是**注入式**的 —— 不传才报错，传了就完全不看 skill 目录。

#### 段号重编

原来有两段都叫「6」（`6. buildReport 收 Map` 与 `6. 目录边界`）。拆开后各自从 1 连续编：

- `test-sdk-transport.mjs`：1 四个并列入口 / 2 源码无换路痕迹 / 3 只调给定 transport / 4 国际服抛错 / 5 入口自检
- `test-render-contract.mjs`：1 Map 与对象等价 / 2 目录边界

#### 验收（2026-11-25 实跑）

| 验收项 | 结果 |
|---|---|
| `packages/sdk/test/test-sdk-transport.mjs` | **通过 15 / 失败 0** |
| `skills/zzz-stats/scripts/test-render-contract.mjs` | **通过 13 / 失败 0** |
| 合计 | **28**，与拆分前逐段对齐（15 + 13） |
| 采集测试独立性 | 拷到 `/tmp/sdk-only-probe/sdk/`（父目录只有 `sdk`、无 `skills/`）后跑，**仍是 15/0** |



