# AGENTS.md — 改这个仓库的 agent 读这里

这是**开发期**约定：给要改 `skills/zzz-stats/scripts/`、`assets/`、`config/` 的 agent 看。
`SKILL.md` 是**运行期**说明书（给宿主 agent 采集抽卡数据用），两边各管一边，不要把开发规则写进 SKILL.md。

## 开发期验收

- **被测 skill 必须在独立 session 或 sub agent 里跑**，不要在正在写它的那个会话里跑。
  - **怎样才算独立**：改 `skills/zzz-stats/scripts/` / `assets/` / `config/` 的那个会话只负责改，验证另开一个会话
    或 sub agent 去跑。同一个会话里「我在写它」和「我在用它」两套语义会互相污染。
  - **为什么**（这次真实发生过的，不是假设）：写 skill 的会话在 06:38:05 才 `turn/end: aborted`，
    但它在 06:36:11 和 06:37:19 还在往仓库写 `scripts/build-report.mjs` 和 `config/report.json`，
    留下一个跑不起来的半成品——`evaluateTags()` 引用了从未定义的 `groupBars()`，直接 ReferenceError。
    而且那几轮它自己的判断已经被两套语义带偏，绕了很大一圈才定位到根因是 SKILL.md §0
    把「采集期找浏览器」和「开发期截本地图」混成了一个入口。
  - **验证完怎么交接**：验证会话把结论带回来（exit code、实际渲染结果、像素/对比度实测值），
    改的会话据此决定是否提交；**两边不要各留一半改动**。
- 截图走 `node skills/zzz-stats/scripts/screenshot.mjs`（默认出 1440×900 与 1280×800 到 `docs/shots/`）。
  **不要**按 SKILL.md §0 的浏览器优先级去现拼 Chrome 命令行——那是采集期「找能扫码登录的浏览器」的语义，
  跟「截一张本地 HTML 的图」是两件事。`--user-data-dir` 脚本里已焊死，别再踩。
- **README 预览图走 `node skills/zzz-stats/scripts/screenshot.mjs --preview`，不要手截。**
  出的是 `docs/preview.png`：1440 逻辑宽、DPR 2、**固定高度**（当前实测 `2880×2382`，逻辑高 1191）。
  **固定高度截图，不是过滤内容**——用户原话「抽卡详情和代理人汇总都是按固定高度截图即可，
  不是让你过滤抽卡详情」。内容全在，截到高度就停，两栏受同一约束。
  名义高度默认 1200，`--preview-height <n>` 可覆盖；实际值会自动吸附到最近的「不切半行」位置（上下都试，取离名义值最近的）。
  **判据是行盒**（`getBoundingClientRect` 的整行，当前落盘实现就是这套）。
  两栏行底边**交集为空**（左栏行高 26 / 右栏 34，共享底边实测 0 个），所以「取两栏各自最近底边的较小值」那种写法是错的
  （1189 只保证左栏完整，它横跨右栏 1157~1191 那行）。但**交集为空不等于没有干净切点**：左栏相邻行之间有 3px / 5px 间隙
  （41 行里 3px 25 处、5px 15 处），右栏间隙恒 0、步长恒 34，「右栏某行底边落进左栏间隙」的高度就是干净的。
  这种高度**很稀疏**：绳匠A 在两栏都有行的区间（919–1769，851 个整数高度）里只有 **6 个**干净点（0.71%），
  绳匠B 是 **5 个 / 817**（0.61%），1000–1400 区间内**只有 1191**（绳匠B 只有 1055 / 1259）——
  必须逐像素搜索，不能靠公式算。（按整页算会数出 1011 个，那是假象：918 个落在详情区上方没有行的空白里。）
  **量几何前断言页面视口高 == 截图视口高（900）**，不等就中止：行盒坐标随视口高位移
  （同一份产物整页高 1000 视口 2271、900 视口 2171），拿错视口的坐标会得出相反结论。
  **量不到几何 / 行盒选择器量到空 / 上下都找不到安全切口，一律中止且不写文件**，
  不许静默按名义值硬截——那会安静地出一张切了半行的图，而尺寸自检永远拦不住。
  反向验证过的两条中止路径：`safeAt` 恒假 → 报「上下都找不到切口」且 exit 1、不写文件；
  选择器改错 → 报「没量到内容」中止。
  **注意：另有一版把判据改成了「墨迹信封」（文本 `Range.getClientRects` + `img` + 有背景/边框的块，
  每行合成一个信封），它**没有**合进 master，只存在于分支 `backup/ink-envelope-176a153`（提交 `176a153`）。
  那一版量出来是 1192 / 图 `2880×2384`，与当前行盒版的 1191 / `2880×2382` **只差 1px，两版都是零半行**。
  master 上落盘的是行盒版，文档里的数字（1191 / 2382 / 安全点 92）与它一致——**别按备份分支那版去改 master 的文档**。
  要切换判据的话，先把实现 cherry-pick 进来、重出预览图，再改文档，别反过来。
  **页面本身不定高**，只改截图范围，别去动 `.detail-body` / `.detail-list` 的 CSS。
  历史：曾用 `--detail-versions N` 隐藏后面的版本组，那是改内容、两栏深度不一致，已整个删除。
  隐私按数据集来源分流：产物里 `meta.synthetic === true`（`fixtures/` 里的模拟数据）**不打码**，
  截图前反向断言昵称/UID **不含** `*`；其余一切**强制打码到 2**，断言 `eye=2` 且昵称/UID 含 `*`。
  **没有标记一律当真实数据**（fail-safe），两条分支断言不过都中止、不写文件。
  以前这张图是手工截好随仓库带的，代码一路改而图停在旧版——很长一段时间里 README 上那张
  还是黄色折线、带「黄线＝累计不歪率」尾注、右轴 60% 的旧版本，没有任何东西会提醒你它过期了。
- **`SKILL.md` 里引用这张预览图必须用绝对 URL，不能用 `docs/preview.png` 这种相对路径。**
  skills.sh 的 skill 页是把 `SKILL.md` 的正文直接渲染出来的，相对路径在那里解析不到仓库文件，
  图会显示成坏链。所以写的是
  `https://raw.githubusercontent.com/atian25/zzz-stats/master/docs/preview.png`。
  默认分支是 `master` 而不是 `main`，写错分支同样 404。改图之后不需要动这行 URL，同名覆盖即可。
- **headless 的 `--window-size` 有 500px 最小宽度，窄屏验收必须靠 CDP 设备模拟。**
  脚本已改成 `Emulation.setDeviceMetricsOverride`，并在收尾自检里比对「页面自报 `innerWidth`」与标称宽度，
  不等就报 `⚠️ 不符` 并退 1。别退回 `--screenshot` + `--window-size` 的老写法：
  那样传 `--width 390` 截出来的是 500px 视口**裁掉右边**的图，尺寸看着对、内容却是假的。
  这个坑真实发生过——「窄屏过滤条被裁」一度被当成 CSS bug，其实是假视口造成的。
- **产物是「一个账号一个目录」：`output/<账号名>/{data/,report.html}`。**
  不传 `--out` 时产物落在**数据集目录的上一级**、名字固定 `report.html`。
  运行期数据集目录是 `output/<账号名>/data/`，所以 `--data output/<账号名>/data` → `output/<账号名>/report.html`。
  用户拿走 `output/<账号名>/` 这一个目录就能直接部署（数据 + 报表在一起），不用自己判断哪些文件配哪份报表。
  名字**不再带数据集后缀**（`report-<数据集名>.html` 已废弃），因为账号目录已经区分开了。
- **`--data fixtures/baseline` 时也不能往 `fixtures/` 里写产物。** 那种数据集不在 `output/` 结构里，
  改取该数据集 `meta.json` 的昵称，落到 `output/<昵称>/report.html`（昵称拿不到就用目录名）。
  过时的写法（`output/report.html`、`output/report-<数据集名>.html`）都不要再回来。
- 不要为了截图去 `session_search` 追截图里的外部链接或部署环境，与本次改动无关。

## 数据集（开发期就是 fixtures/）

`data/` 和 `output/` 是**用户运行期**的落点，落在用户自己的工作目录；仓库自己开发期的
测试数据在 `fixtures/`，跟 skill 本体分开。用户原话：「开发期，对我们来说就是一个 fixtures 目录的测试」。

- `fixtures/<数据集名>/` 一份数据集一个目录，`fixtures/baseline/` 与 `fixtures/multigold/` 平级，
  **这两个目录入库**（它们是开发基线，不是运行期产物）。
- 出图与采集都用 `--data` 显式指定：`--data fixtures/baseline`。
- **运行期兜底只认 `output/<账号名>/data/`，绝不认旧 `data/`，也绝不认 `fixtures/`。**
  不传 `--data` 时脚本只扫 `output/*/data/index.json`：恰好一份就用它，多份报错退出，
  没有就报「找不到数据集」。
  这条踩过：兜底一度写成依次看 `data/` → `fixtures/`，结果用户项目里只要有 `fixtures/` 目录
  （前端项目极常见）就会被读走，生成一份「数字看着正常但来自别的数据集」的报表。
  每扩大一处兜底就多一种这类事故，**别再往回加**。
  本仓库开发时靠 `--data fixtures/xxx` 显式指定，那条路不受兜底规则影响。
- **账号名安全化只有一份实现**：`skills/zzz-stats/scripts/datasets.mjs`。
  collect / save-in-page-json 用它决定**往哪写**，build-report / sync-icons / screenshot 用它决定**去哪读**。
  五处各写一遍必然漂移，而漂移的后果不是报错，是「写得进去、读不出来」。
- **fixtures 里的数据必须脱敏后再入库。** 这是公开仓库：`meta.json` 的 `uid` 是假值
  （`10000001` / `10000002`），昵称也用**中性占位名**（「绳匠A / 绳匠B」，不要写真实昵称）。真实 UID 永不入库——
  采集脚本写出的原始 `data/` 带真 UID，那整份目录在 `.gitignore` 里。
- **`baseline` 是对外展示基线，`multigold` 是测试数据。** README 头图（`docs/preview.png`）、发布说明、
  任何人看得到的图一律用 `fixtures/baseline` 出；`fixtures/multigold` 只用来验证多金分档（双金 + 三金，
  见 `report-rules.md` §8.1），**不拿来截图对外**。它的数字不好看是正常的，不代表报表有问题。
- **开发期验证一律在仓库外跑，不要把运行期产物落在仓库里。**
  实跑扫码、出报表这类验证要在仓库之外的临时目录（`--cwd /tmp/xxx`）做；
  如果图省事在仓库根直接跑，就会生成 `output/<账号名>/` 和 `.chrome-profile/` ——
  前者含真实 UID 与每金记录，后者缓存里还有登录态，两者虽然都在 `.gitignore` 里，
  但都是真实账号的凭据性残留，留在开发机上没有任何好处。
  **验证完清掉真实账号的残留**：`rm -rf .chrome-profile` + 删掉 `output/<真实账号名>/`，再
  `grep -rl "<真实UID>" .` 确认零命中。要留下看的产物就留在仓库外，不要顺手 `git add`。
- **但用 `fixtures/` 构建的产物不要删——它是交付给用户看的那份。**
  本机跑着 `python3 -m http.server 8899`（根目录 = 仓库根），用户点开的地址就是
  `http://127.0.0.1:8899/output/绳匠A/report.html`。删掉 `output/` 这个地址立刻 404，
  用户看到的就是「url 挂了」（真实发生过两次，都是我提交前 `rm -rf output` 导致的）。
  判据是**数据来源**，不是目录名：`fixtures/*` 构建出来的（`meta.synthetic === true`、
  uid 是 `1000000x`）可以留在 `output/` 里持续服务；真实采集出来的必须清。
  清理时**避开 `output/`**，要清临时文件就清 `docs/`、`/tmp`、`.chrome-profile`。
  每次改完源码**立刻重建一次**（`--data fixtures/baseline`），让地址始终是最新版——
  不要攒到最后一次性构建，那样用户中途刷新看到的是旧版或 404。
  用户原话：「删。回头我们开发期的时候，你在 fixture 目录搞」——开发期要的是 `fixtures/`，
  不是在自己仓库里产出一份运行期目录。

## 目录分层：skill 与用户工作目录

**这条改错过一次，改之前先看懂。** 脚本里有两个根目录，不要合并：

| 常量 | 指向 | 干什么 |
|---|---|---|
| `SKILL_DIR` | 脚本上一级，即 `skills/zzz-stats/` | **只读**。读 `config/report.json`、`assets/**`（模板/charts/图标/echarts）。图标缓存 `assets/report/icons/` 也写这里（它随 skill 发布） |
| `WORK_DIR` | `--cwd` 优先，否则 `process.cwd()` | **读写**。`output/`（账号目录 + 凭据临时文件）、`docs/`、`.chrome-profile/` 全相对它算 |

早期全用 `const ROOT = resolve(HERE, '..')`，把两者当同一个。skill 装到 `.agents/skills/zzz-stats`
之后跑构建，数据与产物会写进 skill 自己的目录——既被 skill 升级覆盖，`.gitignore` 的根锚定
规则也管不到，**含 UID 的抽卡记录会变成可提交状态**。改脚本时别再退回单根目录。

`--cwd` 必须同时支持 `--cwd value` 与 `--cwd=value` 两种写法，跟其他参数一样。

## 改动的分工

- 改口径 / 阈值 / 称号 / 文案 / 配色 → 只改 `skills/zzz-stats/config/report.json`。
- 改算法（口径）→ `skills/zzz-stats/assets/report/core.js`，并同步 `references/report-rules.md`。
  **纯 JS，Node 与产物里的浏览器跑同一份源码**（产物里是它的构建期转换版，见
  `lib/core-inline.mjs`），不许出现 `node:` / `process` / `fs` / `require` / `import.meta`
  （`test-core-pure.mjs` 会 grep）。**只**有 `scripts/build-report.mjs` 这一个外壳（build 内核在 `lib/build.mjs`），
  口径**不许写在外壳里** —— 写进去就只在构建期生效，产物里现算的那份没有。
  改完除了 `test-core-pure.mjs`，还要跑 `test-report-browser.mjs`：转换环节坏了 Node 端毫无反应。
- 改视觉 → `skills/zzz-stats/assets/report/charts.{js,css}` / `assets/report/template.html`，
  并同步 `references/report-rules.md` §2–§6 **和 `SKILL.md` 的「产物里有哪些交互」表**
  （那是宿主 agent 读的唯一入口，漏了等于用户看不到新行为）。
- 改了 `config/report.json` 或 `assets/report/icons/` → **不用再跑任何清单脚本**（那两份静态副本
  已随粘贴面板一起删除，见下），重跑构建即可：配色与文案在构建期注入，图标在构建期编码内嵌。
- **「改配置就生效」是硬约定**：不要在 CSS / JS 里另写一份硬编码色值。
- **算法进 `lib/`，命令行只做外壳。** 分层见 `skills/zzz-stats/lib/index.mjs` 文件头：
  `lib/collect.mjs`（采集编排）、`lib/build.mjs`（出 HTML）、
  `lib/login-node.mjs`（`loginByQrNode` / `collectViaNode`）、
  `lib/login-browser.mjs`（`loginByQrBrowser` / `collectViaBrowser`）、
  `lib/transport-node.mjs`（纯 Node 取数的 transport 实现）、`lib/qr.mjs`。
  `scripts/collect.mjs` / `scripts/build-report.mjs` 只解析参数、调 SDK、落盘、打日志、定退出码。
  四条别破坏：
  - **SDK 不写盘**（只返回 `files: Map` / `html`），落盘位置是外壳的决定；
  - **SDK 不读 `process.argv`、不调 `process.exit`**；`buildReport()` 的 `fatal` 是返回数组；
  - **口径不许写在外壳里**，写进去就只在构建期生效，产物里现算的那份没有；
  - **SDK 不做降级**。登录/取数各有 node 与 browser 两个并列函数，各管各的、只抛错，
    **不 catch、不重试、不判断该不该换一条路**。「node 失败就切 browser」这种策略只在
    `scripts/collect.mjs` 里（判据是「用户有没有显式传 `--transport`」）。服务端将来可能
    策略完全不同，写进 SDK 就等于替所有调用方做了决定。`test-lib-transport.mjs` 会拦。
- 改 `lib/login-node.mjs` / `lib/transport-node.mjs` → 那是**私有接口的逆向结论**
  （`x-rpc-app_id` / cookie 名 / `game_biz`）。改了会静默失败（回业务错误码，不是「接口不存在」）。
  出问题按这个顺序怀疑：app_id → cookie 名 → game_biz。别先怀疑网络。
- **`scripts/serve.mjs` 是「第三个外壳」，规则同上：只调 SDK、不改 SDK。**
  本地 Web 服务（`node skills/zzz-stats/scripts/serve.mjs`，默认 `0.0.0.0:3000`），
  浏览器里走完「扫码 → 取数 → 出报表」，产物仍落 `output/<账号名>/{data/,report.html}`。
  五条约束，改之前先看：
  - **单文件、只用 `node:http`、前端 HTML 全内联、不加任何 npm 依赖**——它是「让人亲手试一次」，
    不是产品化服务端，装依赖/拆静态目录都会带来安装步骤与版本漂移；
  - **走纯 Node 路（`transport: 'node'`）且服务里不降级**，失败把真实错误显示在页面上；
    降级策略仍然只在 `scripts/collect.mjs`；
  - **凭据不进日志、不进 SSE**（ticket / Cookie / set-cookie），页面上只出现二维码图片本身；
  - **落盘顺序与两个 CLI 一致**：先写 14 个原始响应，再构建；**校验通过之后才写 `report.html`**；
  - **`lib/build.mjs` 内嵌的原始 JSON 必须用 `fileMap`，不能用入参 `files`。**
    入参可能是 Map，而 `JSON.stringify(map)` 是 `{}` —— 构建全绿、Node 口径也对，
    只有打开产物才崩（`Cannot read properties of null (reading 'type_stats')`）。
    CLI 一直传对象，所以这个 bug 只在服务/用例传 Map 时显形，是 `serve.mjs` 的浏览器验收抓到的。
- 任何改动后跑 §8 回归基线与 §9.3 验收，确认控制台数字与截图。

## 改完必须回填文档与模板

**产物不入库，只改产物等于没改。** `output/` 整个在 `.gitignore` 里（账号目录、`report.html`、
凭据临时文件全在它下面），它只是本次构建的
临时结果；真正沉淀下来、下一个人接着用的是仓库里的这四类文件：

| 文件 | 管什么 |
|---|---|
| `SKILL.md` | **运行期**说明书：宿主 agent 拿到这份 skill 后，怎么向用户描述产物、怎么做采集 |
| `references/report-rules.md` | **规范与理由**：口径、验收数字、踩过的坑，维护者读 |
| `AGENTS.md` | **开发期铁律**：改哪类东西要同步什么、哪些口径不许动 |
| `assets/report/template.html` + `charts.{js,css}` | **模板本身**：DOM 结构、内联脚本、样式 |

每次改完，逐项过一遍：本次改动涉及的行为，这四类里有没有对应描述？
没有就补，过时的就改。特别是 `SKILL.md` 的「产物里有哪些交互」表——
**它是宿主 agent 读的唯一入口**，写不全就等于用户永远看不到这个功能。

`template.html` 目前不含标签/高亮逻辑（那些都在 `charts.js` 里），改视觉时先确认
要不要动它，别默认「模板肯定不用改」。

**反面案例**：有一段时期 README 的预览图和文档都停在旧版——折线还是黄色、图例还带
「黄线＝累计不歪率」尾注、右轴还是 60%，而代码早就改成红绿蓝三档、图例四条的固定宽度、
右轴固定 100%。代码改了、产物看着也对了，但没有任何东西提醒「文档里的描述已经过期」，
直到有人对着 README 问「截图没更新」。**只改代码不回填文档，症状就是这样：
本地打开是对的，别人照文档理解全是错的。**

## 凭据性临时文件：用完即删

`output/` 根下有三个**凭据性临时文件**（固定名，登录成功那一刻必须清掉）：

| 文件 | 是什么 |
|---|---|
| `login-qr.png` | 二维码截图，**还能被扫**（扫了只提示失效，但图本身是登录码） |
| `sms-code.txt` | 短信验证码中转，明文 |
| `qr-refresh` | 换图信号 |

**为什么在 `output/` 根，而不是账号目录里**：账号名要等登录成功、甚至采集完才知道（昵称只能从页面读），
而二维码在**登录之前**就得落盘。挂在账号目录下就没有确定路径可写。
它们的生命周期也确实是「登录前」，跟账号数据不是一回事。

三条铁律：

1. **登录成功即删**，不等采集跑完。后面还要跑 6 个频道，没理由让作废的登录码在盘上多躺几十秒。
2. **失败路径也删**。`finally` 兜住「登录失败/采集抛错」；**Ctrl-C / kill 必须靠显式信号处理**——
   async `main()` 的 `finally` 在 SIGINT 下**根本不执行**（实测过），指望它就会留下二维码。
   信号回调里只用同步 API，不要 await。
3. **只删这三个固定文件名，永不删目录、不递归。** `output/` 里同时装着账号目录
   （`output/<账号名>/data/` 含 UID 与每金记录），删目录就是删用户数据。
   `--keep-verify` 只给排障用，默认关。

**固定文件名 + `?t=` 破缓存**：盘上是固定名（覆盖写），靠图片服务 URL 里的
`?t=<毫秒>-<序号>` 破缓存。`?t=` 要带单调序号，只有毫秒时间戳时同一毫秒内连取两次会拿到相同 URL
（实测过），那等于没破缓存。

**换图的入口有两条，必须并行生效，不许写成二选一。** 终端按键 `r` 与信号文件
`output/qr-refresh` 是**互相独立的通道**，任一命中就刷新。这里出过一个只在特定环境组合下
才显形的 bug：早先 `collect.mjs` 写成

```js
if (stdin.isTTY) { stdin.on('data', onKey) }          // 只有 TTY 听按键
if (!stdinRaw && existsSync(REFRESH_SIGNAL)) {...}    // ← 有 TTY 就永远不查信号文件
```

而 agent 代跑的典型场景正好落在缝隙里：**进程挂在终端里（有 TTY），但 agent 没法往那个 TTY 发按键**，
它只能写文件 —— 写下去没有任何人读，日志还在打「仍在等待…」，白等几十秒才被人工发现。
所以 TTY 与否**只允许影响提示文案**，不能参与判断；判断逻辑现在集中在
`scripts/qr-wait.mjs` 的 `takeRefreshRequest()`，它的签名里根本没有 `stdinRaw`（这是刻意的：
这个参数一旦回去，两条通道就会重新退化成二选一）。回归用例：
`node skills/zzz-stats/scripts/test-qr-wait.mjs`（75 项，含「TTY 场景下信号文件必须生效」，
并**真实执行** `waitForLogin()` 循环本体——零件测与真跑缺一不可）。

TTY 下 `setRawMode(true)` 会关掉终端行编辑，**每个**按键都会进 `data` 事件。所以 `isRefreshKey()`
只认单个 `r`/`R`（严格相等，不是「包含 r」）：方向键的 `\x1b[A`、粘贴进来的 `rr`、回车都不能触发刷新，
否则用户随便敲个键就把二维码换掉了。

**等待循环本体必须能被真实执行地测，所以它整个搬进了 `qr-wait.mjs` 的 `waitForLogin()`**，
`collect.mjs` 只做接线（stdin、驱动、日志、保存函数都靠参数注入）。这不是为了「架构好看」：
抽这段时手滑删掉了 `let wantRefresh` 的声明，**`node --check` 一声不响**（赋值未声明变量是运行时
ReferenceError，语法合法），而我当时手写的仿真 harness 又只模拟了循环的一部分——
「语法检查过了」差点被当成「改对了」。用例 #12–#16 现在直接调 `waitForLogin()` 本体。

清理逻辑在 `skills/zzz-stats/scripts/verify-cleanup.mjs`，图片服务在 `.../image-server.mjs`，
扫码等待期的刷新通道与二维码计时在 `.../qr-wait.mjs`，
**单独成文件是为了能在不启动浏览器的情况下测**。扫码采集需要人扫、CI 跑不了，
但「删干净 / 幂等 / 不误删账号目录」「白名单只服务一个文件 / `?t=` 每次不同」这些可以对着假文件验证。
改这两段逻辑时先跑用例再改：

```bash
node skills/zzz-stats/scripts/test-verify-cleanup.mjs   # 27 项，不需要浏览器、不联网
node skills/zzz-stats/scripts/test-image-server.mjs      # 25 项，只起一个 127.0.0.1 临时端口
node skills/zzz-stats/scripts/test-qr-wait.mjs           # 75 项，刷新通道 + 真实等待循环
node skills/zzz-stats/scripts/test-preview-privacy.mjs   # 53 项（output/ 在场时 55 项），--preview 的隐私分流（见下）
node skills/zzz-stats/scripts/test-lib-transport.mjs    # 19 项，lib/ 四个并列入口 + 「降级只在 CLI」纪律 + Map/对象两种入参产物一致
node skills/zzz-stats/scripts/test-core-pure.mjs         # 47 项，core.js 纯度 + 转换规则 + 面板已删 + 图标资产
node skills/zzz-stats/scripts/test-report-browser.mjs    # 30 项，需要 chrome；产物现算的 __REPORT__ 与 Node 口径逐字段相同
```

`test-report-browser.mjs` 默认用 `file://` 打开产物，**不需要起静态服务**；
`--data fixtures/multigold --report output/绳匠B/report.html` 可以跑第二份数据。
它会断言「产物里浏览器现算的 report 与 Node 对同一批 fixtures 算出的对象逐字段相同
（连 `icons` 的值都相同，只归一化 `generatedAt`）」，以及产物里 0 处 `/*__` 残留、
内嵌 JSON 与磁盘数据集逐键一致。

**这套用例抓到过一个结构计数抓不到的真 bug**：ECharts 量到 `display:none` 的容器、
画出 0×0 空画布——`#chart svg` 计数仍是 1，图却全白。所以它同时断言容器与 svg 的**像素尺寸**。

**产物里那三段脚本的顺序不能动**（原始 JSON → core+引导 → charts.js），
且**不许**把中间那段改成 `type="module"` / `await import()` / `fetch`：
charts.js 会早于 `__REPORT__` 执行、静默 return，页面全白而 console 干净。详见 `report-rules.md` §6.8。

**`--preview` 的隐私分流也是安全相关的**：`synthetic: true` 的数据集不打码、其余强制打码。
判错一次就是把真名截进公开仓库，所以判定逻辑单独在 `preview-privacy.mjs` 里，用例
`test-preview-privacy.mjs` 对着假数据逐条断言（含 `"true"` 字符串、`1`、缺失等坏写法
一律往安全那边倒）。**改这段先跑用例**。

用例文件在 `skills/zzz-stats/scripts/`，**新增清理范围或改了白名单就照它们的形状补一条**，不要只靠肉眼。

## 不许改的口径（改之前先问用户）

这几条是用户明确定死、并且**已经被改错/改回去过**的，改动前必须确认：

- **不歪率折线始终是全局累计**，版本过滤只缩柱子、**不重算折线**。
- **两个坐标轴都固定**：右轴 0~100%（`numbers.axisWinRateMax`），左轴按频道取保底×2（`numbers.axisPullsMax`）。
  不要退回按数据自适应的写法。构建时已加自动断言（见 `report-rules.md` §9.3）：
  坐标轴退化会让**构建失败（退出码 1）且不写出产物**，不是只打告警——看到 `✖ 没有真正读取 CFG.numbers.axis*` 就是有人把读取删掉了。
- **横坐标版本号画在「线里面」**（轴与横线之间），多柱版本横线 + 两端竖虚线并真正居中，单柱版本不画任何线。
- 图例固定 4 条，行尾尾注已删（`copy.legendTail` 不再存在，不要加回来）。
- 折线三档颜色是红/绿/蓝（与柱体同语义的提亮版），不是灰。
- **折线必须带深色描边**（`colors.winRateHalo`）：同段画两遍、先粗后细，彩色线 1.4px、描边 4.6px。
  描边宽度**不能收窄到 3px**——每侧只剩 0.8px 属亚像素，抗锯齿会把它和柱色混掉，实测等于没加。
  提亮版压同色柱只有 1.31~2.30:1，没有描边这层就低于 3:1。

## 提交

- commit message 不带 `Co-authored-by`、`Generated with`、`🤖` 之类标记。

- **看到不是自己写的改动或提交，先当成自己的。** 这个仓库常有同一任务的多条后台分支并行写同一批文件
  （`charts.css` 被几条分支轮流改、断点被改成 760/799 又改回 720，都真实发生过）。
  先看 `git log --format="%H %ci %s"` 的提交时间和内容，对不对得上自己刚派下去的任务；对上就直接接着收尾。
  别停下来反复盘问「是不是另一个 Bot 在写」——实测过几次，查到最后都是自己的后台任务链；
  真拿不准先看时间戳和内容，别把「并发」当结论往上报。
  收尾以实测验证过的那个版本为准，重复的分支停掉再提交。
