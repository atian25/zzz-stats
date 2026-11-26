# zzz-stats

[![skills.sh](https://skills.sh/b/atian25/zzz-stats)](https://skills.sh/atian25/zzz-stats/zzz-stats)

**《绝区零》抽卡记录分析与报表** · 一个 Agent Skill

跟你的 Agent 说：

> 安装 https://github.com/atian25/zzz-stats 这个 skill，并帮我运行，提取绝区零抽卡记录

也可以自己装：`npx skills add atian25/zzz-stats`

---

把《绝区零》官方「调频统计工具」的数据抓下来，生成一份**首屏一屏可读**的抽卡报表，主图下方附六频道抽卡详情。

这是一个 Agent Skill（`zzz-stats`）：扫码登录 → 抓官方接口 → 落本地 JSON → 一条命令出图。
**不绑定任何特定的浏览器工具**：会话里有自带浏览器就用它，
有 Playwright 就用 Playwright，都没有才由零依赖 CDP 自己起本机 Chrome。
核心只需要两个能力——**打开页面** 和 **在页面里执行 JS**。

![报表预览](docs/preview.png)

## 能做什么

- **采集**：6 个频道（角色、音擎、常驻、邦布等）的总抽数、S 数、UP 数、当前垫抽，以及每一金的物品、稀有度、是否 UP、消耗抽数、时间戳、频道内序号。
- **报表**：`抽卡总览` 主图 = 每轮 UP 成本堆叠柱 + 累计不歪率折线，柱顶摞角色头像（歪出的在上）、十连双金标记、悬浮 tip、事件标签，可折叠主图方便截图；1440×900 / 1280×800 首屏无滚动。
- **垫抽进度**：详情正文里、最新版本组第一行——金色问号方块 + 绿色斜纹条「已垫 58 抽」，切频段自动跟着换；剩 ≤ 10 抽变红，悬浮看还差多少与上一个 S 是谁。保底抽数按频段配在 `config/report.json`。
- **抽卡详情**：第二屏按 6 个频道列出每一金的横条，条长 = 抽数、绿/红 = 欧非、红章 = 歪，可切换标签；左侧方括号按版本分组；整页铺开不内滚；勾「真实抽数」把歪的成本并进 UP。
- **口径可配**：称号分档、标签规则、配色、文案、保底抽数全在 `config/report.json`；颜色经 CSS 变量注入、标题文案在构建时替换模板，**改配置就真的生效**，不用碰代码。
- **成本口径不吃垫抽**：每金 / 每 UP 均按「官方总抽 − 当前垫抽」算，和官方 `avr_up_count` 对得上（常驻 65.8 而不是 72.2）。
- **图标离线且内嵌**：角色、音擎、邦布图标随仓库带一份 64px 缓存，构建时 base64 内嵌进 HTML；产物是**真正自包含的单文件**，单独发给别人也能正常显示。同一张图按内容哈希只嵌一次（产物 ~2 MB，不是 3.7 MB）。缺图用占位图兜底，不裂图、不引 CDN。
- **图标自动同步**：接口每条记录都带图标 URL，`node skills/zzz-stats/scripts/sync-icons.mjs` 会自动补下新角色/音擎/邦布的图，下载即裁成 64px，不用手动找图。

## 支持哪些客户端

DeepSeek Harness、Codex、Trae、豆包工作，以及任意支持 Agent Skill 的客户端。

跑起来之后，agent 会自己打开官方页面、把二维码交给你扫、抓完数据出报表。
**你只需要扫码这一步。**

### 国服 / 国际服

`--region prod_gf_us` 这类参数不只是改 query —— 页面与接口基址会整套切到 hoyolab 域，
登录 iframe 的 host 判定也跟着切。自定义域名用 `--api <url> --page <url>` 覆盖。

### 扫码有两种节奏

| 档位 | 适用 | 你的操作 |
|---|---|---|
| **A（默认）** | 会话支持后台任务 | 扫一次码，然后什么都不用做 |
| **B（降级）** | 只能一次性执行 | 扫码后回来跟 agent 说一声 |

登录有两条路，agent 会先问你要哪种：

- **扫码**（默认）：装过米游社 App，扫一下最快
- **短信验证码**：`--login=sms`，没装 App 也能用。你不用碰终端——
  在对话里把手机号和收到的验证码告诉 agent 就行，它替你填进官方登录框

登录态存在浏览器 profile 里，之后再跑通常不用重新扫码。

## 克隆仓库开发或运行服务

需要 Node.js ≥22 和 pnpm 12。在仓库根安装整个 workspace，再运行服务或测试：

```bash
pnpm install --frozen-lockfile
node packages/server/serve.mjs --host 127.0.0.1
# 不需要浏览器的 13 个测试文件
pnpm test
# 全部 15 个测试文件；另外需要 Chrome，可通过 CHROME_PATH 指定
pnpm test:all
```

仓库使用 pnpm workspace 和本地 SDK 链接，不支持在仓库根用 `npm install` 代替；它不会安装各子包依赖。
测试入口串行运行，浏览器验收自动用 fixtures 构建临时报表，不依赖现有 output，也不访问日常 Chrome 的 9222。

## 手动跑一遍

若使用完整仓库，先执行上面的根目录安装。通过 `npx skills add` 单独安装的 skill，则只在该 skill 目录执行 `pnpm install`（也支持 `npm install`），不需要克隆仓库。

```bash
# 1) 国服默认纯 Node 扫码；浏览器通道才需要 Chrome 或 Playwright
node skills/zzz-stats/scripts/collect.mjs

# 2) 出图
node skills/zzz-stats/scripts/build-report.mjs --data output/<账号名>/data   # → output/<账号名>/report.html
```

> 采集层是独立的 npm 包 [@atian25/zzz-stats-sdk](https://www.npmjs.com/package/@atian25/zzz-stats-sdk)，
> 国服纯 Node 扫码需要 Node.js ≥22 和已安装的包依赖；浏览器通道另需 Chrome，缺图同步另需 Pillow。
> 报 `ERR_MODULE_NOT_FOUND` 时先按安装方式补依赖，不要开始登录。

**一个账号一个目录，数据与报表在同一个目录里。** 采集完成后产物长这样：

```
output/<账号名>/
├── data/            # meta.json / index.json / *_pool_stat_*.json
└── report.html      # 自包含单文件报表
```

目录名取**昵称**（登录后从页面读；读不到就退回 UID），做文件系统安全化后使用。
同账号重跑 = 覆盖同一个目录。**用户拿走 `output/<账号名>/` 这一个目录就能直接部署**，不用自己配对。
`output/` 下有多份且没写 `--data` 时构建会报错退出（不猜，猜错只会生成一份「数字属于别人」的报表）。

**数据落在你的项目目录，不落在 skill 目录。** 脚本把两个根目录分开：`SKILL_DIR` 是 skill 本体
（`config/`、`assets/`，只读），`WORK_DIR` 是数据落点（默认 `process.cwd()`，可用 `--cwd` 指定）。
所以装到 `.agents/skills/zzz-stats/` 后，在自己项目里跑 `node <skill>/scripts/collect.mjs`，
`output/` 就长在自己项目下——不会被 skill 升级覆盖，也不会误提交进 skill 仓库。

仓库自己开发期的测试数据在 `fixtures/`，所以克隆下来直接跑
`node skills/zzz-stats/scripts/build-report.mjs --data fixtures/baseline` 就能出基线报表
（产物仍落 `output/<数据集昵称>/report.html`，不会往 `fixtures/` 里写）。

改完代码要验收时，两档尺寸的截图一条命令出齐（复用本机 Chrome，不需要 Playwright）：

```bash
node scripts/screenshot.mjs                                   # → docs/shots/ 1440x900 + 1280x800
node scripts/screenshot.mjs --privacy 2                       # 对外发的图先点全打码
node scripts/screenshot.mjs --chart 音擎                       # 截频段 tab 切过去之后
node scripts/screenshot.mjs --filter 2                        # 截版本过滤生效之后
node scripts/screenshot.mjs --html p.html --out-dir /tmp/x     # 指定产物与输出位置
node scripts/screenshot.mjs --preview --html output/<账号名>/report.html   # → docs/preview.png（固定高度 2x）
node scripts/screenshot.mjs --preview --preview-height 1400 --html output/<账号名>/report.html   # 覆盖固定高度
```

`--html` 不传时会在 `output/*/report.html` 里找唯一的那个；有多份会报错退出，不猜（截错账号的图比失败更糟）。

两档图是**验收**用的（看首屏装不装得下、图例有没有折行）；`--preview` 出的是**对外展示**用的头图，
1440 逻辑宽、DPR 2、**固定高度**。当前实测 `2880×2382`（逻辑高 1191）。

`--preview` 按**固定高度**截，不再整页截：内容全在，超出部分天然不在图里，两栏受同一高度约束。
名义高度默认 1200（`--preview-height <n>` 可覆盖），实际会**自动吸附**到最近的「不切半行」位置（上下都试，取离名义值最近的）。

改前两版都不对，一并记在这里：

| 版本 | 做法 | 问题 |
|---|---|---|
| 最早 | 整页原样截 | 详情列表铺满 16 个版本组，图高 **4342px**，README 上一条细长条 |
| 上一版 | `--detail-versions 2` **隐藏后 14 个版本组** | **那是改内容**：图里只剩 2 个组、右栏却完整 25 行，两栏被修成不同深度。用户原话纠正：「抽卡详情和代理人汇总都是按固定高度截图即可，不是让你过滤抽卡详情」 |
| 现在 | **固定高度截图**，判据用行盒 | 内容一个不少，截到高度就停。名义 1200 → 实测吸附到 **1191**，图 `2880×2382` |

**页面本身没改成定高滚动**（用户早前明确要求「不要定高吧，抽卡详情多的话就直接在页面下面」），
这是**截图范围**的固定高度，`.detail-body` / `.detail-list` 的 CSS 一行没动。

吸附的原因：左栏行高 26、右栏行高 34，两栏行底边**交集实测为空**（绳匠A 41 行对 25 行、共享底边 0 个），
不存在「天然对齐两栏」的高度。但**交集为空不等于没有干净切点**：左栏相邻行之间有 **3px / 5px** 间隙
（41 行里 3px 25 处、5px 15 处），右栏间隙恒 0、步长恒 34，所以「右栏某行底边恰好落进左栏行间隙」的高度就是干净的。
脚本因此不做公式推导，而是从名义高度上下逐像素校验「没有任何左栏行 / 右栏行横跨它」，取离名义值最近的安全值。

这种高度**很稀疏**：绳匠A 在两栏都有行的区间（919–1769，851 个整数高度）里只有 **6 个**干净点（0.71%），
绳匠B 是 **5 个 / 817**（0.61%）；1000–1400 区间内绳匠A **只有 1191**、绳匠B **只有 1055 / 1259**。
（按整页算会数出 1011 个，那是假象——其中 918 个落在详情区上方的空白里，那里根本没有行可切。）

**量几何前会断言页面视口高 == 截图视口高（900）**，不等就中止：行盒坐标是排版的产物，
而排版随视口高变化（同一份产物整页高 1000 视口 2271、900 视口 2171）。
拿错视口的坐标判断切点会得出**相反**的结论——真实踩过：按 1000 量会以为「两栏没有共同安全切点」，
其实 900 下 1191 本来就是干净的。

**量不到几何 / 行盒选择器量到空 / 上下都找不到安全切口，一律中止且不写文件**，
不会静默按名义值硬截：那会安静地出一张切了半行的图，而尺寸自检只比尺寸、永远拦不住它。
实测 1191 下左栏 9 行（末行底 1189，余 2px）、右栏 8 行（末行底 1191，余 0px）、
4 个完整版本组（v3.3 / v3.1 / v3.0 / v2.7）。

这张图以前是手工截的，代码改了它不会跟着变，README 上就挂着一张和实际产物对不上的截图，
现在统一由脚本出，别手截。

`--preview` 的隐私按数据集来源分两条路，判据是产物里的 `report.meta.synthetic`：
严格布尔 `true` 的数据集（`fixtures/` 里那些名字本来就是编的）**不打码**，其余一切**强制全打码**并断言。
**没有标记一律当真实数据**——忘了给新数据集写标记，只会让图难看一点，不会漏真名。

数据集之间完全平级：`fixtures/baseline/` 与 `fixtures/multigold/` 各是一套完整数据，
出图时用 `--data` 切换，不需要重新登录采集也能验证生成环节。

短信登录把手机号当参数传，验证码在短信到达后写入约定文件：

```bash
node skills/zzz-stats/scripts/collect.mjs --login=sms --phone=13xxxxxxxxx
# 收到短信后，另开一个终端（路径固定在 output/ 根，与账号无关）：
echo 123456 > output/sms-code.txt                   # 读一次就删，登录成功即清
```

想让浏览器显示出来、自己看着扫，加 `--headed`；想锁定零依赖方案，加 `--driver cdp`。

想复用自己日常 Chrome 的登录态（下次免扫码），就用带调试端口的 Chrome：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.zzz-chrome" &
node skills/zzz-stats/scripts/collect.mjs --cdp http://127.0.0.1:9222
```

在受限沙箱里 Chrome 自带的 sandbox 可能起不来，加一句环境变量即可：

```bash
ZZZ_CHROME_ARGS='--no-sandbox --headless=new' node skills/zzz-stats/scripts/collect.mjs
```

> `--driver cdp` 这条路只用 Node 内置模块（`node:fs` / `node:child_process` / 全局 `WebSocket` / 全局 `fetch`）直讲 CDP，
> **CDP 驱动不依赖 Playwright**。采集 SDK 使用 npm 的 `qrcode` 编码二维码，它是生产依赖，由包安装自动解析；不能把整套 skill 说成零 npm 依赖。

如果会话里已经有浏览器工具（任何能「在页面里执行 JS」的能力），
连脚本都不用跑：把 [`fetch-in-page.js`](skills/zzz-stats/scripts/fetch-in-page.js) 的内容当表达式执行，
再用 `node skills/zzz-stats/scripts/save-in-page-json.mjs` 落盘即可。取数逻辑本来就只是「1 次汇总 + 6 次当前池 + 若干次历史分片」。

## 目录结构

```
skills/zzz-stats/SKILL.md          # 入口：浏览器能力契约、采集流程、失败处理
skills/zzz-stats/config/report.json # 口径与文案的唯一来源：称号、标签、配色、KPI、频道、保底抽数
# 采集层是独立 npm 包 @atian25/zzz-stats-sdk，源码在 packages/sdk/，下面几行是它的内部分层
packages/sdk/collect.mjs           # 采集编排：登录 → 定 uid/昵称 → 按频道取数 → 返回 Map（不写盘）
packages/sdk/login-node.mjs        # 纯 Node 扫码登录（passport + Cookie）
packages/sdk/login-browser.mjs     # 浏览器登录：页面 iframe 扫码 / 短信
packages/sdk/transport-node.mjs    # 纯 Node 取数（act 接口直连）
packages/sdk/qr.mjs                # 二维码编码 → data URL
packages/sdk/drivers.mjs           # 浏览器驱动适配层：playwright / cdp 两套实现，接口一致
packages/sdk/qr-wait.mjs           # 换码通道 + 二维码计时
packages/sdk/docs/api.md           # 接口与字段说明（含十连多金判定、完整性等式）
packages/sdk/test/test-sdk-transport.mjs  # 采集层用例（49 项，不需要 skill 目录）
packages/server/serve.mjs          # 本地 Web 服务：浏览器里扫码 → 取数 → 出报表
skills/zzz-stats/scripts/build.mjs # 报表渲染器：files + cfg → 单文件 HTML
skills/zzz-stats/scripts/collect.mjs       # 采集外壳：参数 → 调 SDK → output/<账号名>/data/*.json
skills/zzz-stats/scripts/sync-icons.mjs    # 按接口里的 icon URL 自动补齐缺失图标，下载即裁 64px（需 Pillow）
skills/zzz-stats/scripts/fetch-in-page.js  # 只借「页内执行 JS」一个能力的取数脚本（无 Node 环境也能用）
skills/zzz-stats/scripts/save-in-page-json.mjs # 把上面那段脚本的结果落成 output/<账号名>/data/
skills/zzz-stats/scripts/build-report.mjs  # 出图外壳：output/<账号名>/data + config → output/<账号名>/report.html
skills/zzz-stats/scripts/datasets.mjs      # 账号目录名与 output/ 结构的共用实现（五个脚本共用一份）
skills/zzz-stats/scripts/image-server.mjs  # 二维码只读图片服务（白名单只服务 login-qr.png）
skills/zzz-stats/scripts/verify-cleanup.mjs # 凭据临时文件清理（登录成功即删）
skills/zzz-stats/test/                     # skill 的用例（7 个，随 skill 分发，可在装好的 skill 里跑）
scripts/screenshot.mjs     # 开发期验收与 README 预览图：1440x900 / 1280x800 两档（复用本机 Chrome）
scripts/preview-privacy.mjs # 截图用的隐私判定纯函数（与 screenshot.mjs 同层，不随 skill 分发）
skills/zzz-stats/assets/report/            # 报表模板（template.html / charts.js / charts.css）
skills/zzz-stats/assets/report/icons/      # 图标唯一一套 64px（avatars/ 圆形 + items/ 方形），构建时 base64 内嵌
skills/zzz-stats/assets/vendor/echarts.min.js # ECharts 5.6.0（随仓库分发，不用 CDN）
docs/report-rules.md # 报表口径与呈现约定（规范层，维护者读）
fixtures/baseline/          # 开发期基线数据集（对外展示用这份，UID 与昵称均已脱敏）
fixtures/multigold/         # 开发期测试数据集（双金 + 三金分档用，不对外截图）
AGENTS.md                   # 开发期铁律：改哪类东西要同步什么、哪些口径不许动
```

报表右上角带仓库链接（`config/report.json` 的 `copy.repo` 可改），方便拿到图的人反查生成方式。

> 产物是 `output/<账号名>/report.html`，**自包含单文件**：数据、ECharts、用到的图标全部内嵌，
> 可以单独发给别人直接打开，不依赖 `assets/` 目录；跟同目录的 `data/` 一起拷走就是一个完整账号包。

## 报表口径

| 指标 | 定义 |
|---|---|
| UP 轮 | 从上一金之后到该 UP 的抽数；`off` = 期间非 UP 的 S 消耗，`up` = 之后到 UP，`total = off + up` |
| 每 UP 均 | (角色池总抽 − 当前垫抽) / UP 数（含歪成本，不含还没结算的垫抽） |
| 不歪率 | 50/50 胜场 / 总 UP 轮数（保底获得的 UP 不计胜场） |
| 平均每金 | (总抽 − 当前垫抽) / S 数（各频道按自己算） |
| 垫抽 | 官方 `next_s_cur_times`，含在总抽里但还没出金，所以要减掉 |
| 欧 | 直出，或 `total ≤ 该账号每 UP 均`（歪了但更省也算欧） |
| 极欧 | `total ≤ 40` 抽（可配） |

同一发十连里后出的非 UP 金归到**同池 UP 那一轮**，仍算直出——这样既不会把下一位误判成「先歪」，总抽也始终等于官方值。

## 称号与标签

称号只看「角色池每 UP 均（含歪）」，基准 62.5 × 1.5 = 93.75 抽。10 档定义在 [`config/report.json`](skills/zzz-stats/config/report.json) 的 `titles.tiers`，按 2026-11 收集的 12 条工坊样本拟合，不是人群百分位；不歪率只是强相关，不能当判据。

| 每 UP 均 | 称号 |
|---|---|
| ≤ 62.5 | 终极无敌至尊欧皇 |
| ≤ 80 | 万里挑一至尊欧皇 |
| ≤ 90 | 欧气满满大欧皇 |
| ≤ 95 | 欧非守恒 |
| ≤ 99 | 欧气附体小欧皇 |
| ≤ 105 | 欧气不足小非酋 |
| ≤ 110 | 薛定谔的非欧 |
| ≤ 117 | 超级至尊非酋 |
| ≤ 125 | 千里挑一大非酋 |
| > 125 | 终极无敌至尊非酋 |

标签同样是配置驱动的（`tags.rules`）：`欧气附体`、`运势极佳`、`时运不济`、`代理人 K 连 UP ×N`、`代理人 K 连歪 ×N`、`十连双金 ×N`、`似非实欧 ×N`。条件不满足就不出现。

## 扫码刷新限流

二维码是对方登录接口下发的，所以刷新是**纯手动、有上限**的：

- 只在用户主动要求时才重新取图，**脚本里没有任何定时器或自动循环**
- 单次会话最多重取 3 次，两次之间至少隔 5 秒
- 到上限就停下并提示排查，不会继续空转

「换一张」有两条通道，**并行生效、互不影响**：终端里按 <kbd>r</kbd>，或由 agent 写
`output/qr-refresh` 这个信号文件。不要把它们当成二选一 —— 采集进程挂在终端里时，
代跑的 agent 同样发不了按键，它只能写文件。

用户如果去忙别的，脚本就停在等待中，不会在后台反复请求。

## 数据与隐私

- 只取官方页面的三个响应体：`index`、`cur_pool_stat`、`hist_pool_stat`；接口见 [packages/sdk/docs/api.md](packages/sdk/docs/api.md)。
- **不索取账号密码、验证码、cookie、token**，登录由用户自己扫码完成；脚本不读 cookie、不存请求头。
- 数据只落本地 `output/<账号名>/`（`output/` 已 gitignore），不上传；仓库里不含任何账号数据。
- 报表头部自带隐私开关：点 UID 旁的眼睛，在「全显示 → 仅打码 UID → 昵称与 UID 全打码」三态间循环；**对外截图请先切到全打码**。
- 页面：`https://act.mihoyo.com/zzz/event/gacha-record/index.html`
- 接口基址：`https://act-api-takumi.mihoyo.com/event/nap_gacha_record`

## 说明

非官方工具，数据来自米哈游公开活动页接口；页面或接口改版可能导致失效，处理方式见 `SKILL.md` 的「失败处理」。
