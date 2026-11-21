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
  出的是 `docs/preview.png`：1440 逻辑宽、DPR 2、整页（当前实测 `2880×2838`，高度跟内容走），并强制打码到 2、
  截图前断言 `eye=2` 且昵称/UID 含 `*`（不通过就中止、不写文件）。
  以前这张图是手工截好随仓库带的，代码一路改而图停在旧版——很长一段时间里 README 上那张
  还是黄色折线、带「黄线＝累计不歪率」尾注、右轴 60% 的旧版本，没有任何东西会提醒你它过期了。
- **headless 的 `--window-size` 有 500px 最小宽度，窄屏验收必须靠 CDP 设备模拟。**
  脚本已改成 `Emulation.setDeviceMetricsOverride`，并在收尾自检里比对「页面自报 `innerWidth`」与标称宽度，
  不等就报 `⚠️ 不符` 并退 1。别退回 `--screenshot` + `--window-size` 的老写法：
  那样传 `--width 390` 截出来的是 500px 视口**裁掉右边**的图，尺寸看着对、内容却是假的。
  这个坑真实发生过——「窄屏过滤条被裁」一度被当成 CSS bug，其实是假视口造成的。
- **产物是「一个账号一个目录」：`output/<账号名>/{data/,report.html}`。**
  不传 `--out` 时产物落在**数据集目录的上一级**、名字固定 `report.html`。
  运行期数据集目录是 `output/<账号名>/data/`，所以 `--data output/天猪/data` → `output/天猪/report.html`。
  用户拿走 `output/<账号名>/` 这一个目录就能直接部署（数据 + 报表在一起），不用自己判断哪些文件配哪份报表。
  名字**不再带数据集后缀**（`report-<数据集名>.html` 已废弃），因为账号目录已经区分开了。
- **`--data fixtures/tianzhu` 时也不能往 `fixtures/` 里写产物。** 那种数据集不在 `output/` 结构里，
  改取该数据集 `meta.json` 的昵称，落到 `output/<昵称>/report.html`（昵称拿不到就用目录名）。
  过时的写法（`output/report.html`、`output/report-<数据集名>.html`）都不要再回来。
- 不要为了截图去 `session_search` 追截图里的外部链接或部署环境，与本次改动无关。

## 数据集（开发期就是 fixtures/）

`data/` 和 `output/` 是**用户运行期**的落点，落在用户自己的工作目录；仓库自己开发期的
测试数据在 `fixtures/`，跟 skill 本体分开。用户原话：「开发期，对我们来说就是一个 fixtures 目录的测试」。

- `fixtures/<数据集名>/` 一份数据集一个目录，`fixtures/tianzhu/` 与 `fixtures/joker/` 平级，
  **这两个目录入库**（它们是开发基线，不是运行期产物）。
- 出图与采集都用 `--data` 显式指定：`--data fixtures/tianzhu`。
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
  （`10000001` / `10000002`），昵称沿用「天猪 / joker」。真实 UID 永不入库——
  采集脚本写出的原始 `data/` 带真 UID，那整份目录在 `.gitignore` 里。
- **天猪是对外展示基线，joker 是测试数据。** README 头图（`docs/preview.png`）、发布说明、
  任何人看得到的图一律用 `fixtures/tianzhu` 出；`fixtures/joker` 只用来验证多金分档（双金 + 三金，
  见 `report-rules.md` §8.1），**不拿来截图对外**。它的数字不好看是正常的，不代表报表有问题。

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
- 改算法 → `skills/zzz-stats/scripts/build-report.mjs`，并同步 `references/report-rules.md`。
- 改视觉 → `skills/zzz-stats/assets/report/charts.{js,css}` / `assets/report/template.html`，
  并同步 `references/report-rules.md` §2–§6 **和 `SKILL.md` 的「产物里有哪些交互」表**
  （那是宿主 agent 读的唯一入口，漏了等于用户看不到新行为）。
- **「改配置就生效」是硬约定**：不要在 CSS / JS 里另写一份硬编码色值。
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

清理逻辑在 `skills/zzz-stats/scripts/verify-cleanup.mjs`，图片服务在 `.../image-server.mjs`，
**单独成文件是为了能在不启动浏览器的情况下测**。扫码采集需要人扫、CI 跑不了，
但「删干净 / 幂等 / 不误删账号目录」「白名单只服务一个文件 / `?t=` 每次不同」这些可以对着假文件验证。
改这两段逻辑时先跑用例再改：

```bash
node skills/zzz-stats/scripts/test-verify-cleanup.mjs   # 27 项，不需要浏览器、不联网
node skills/zzz-stats/scripts/test-image-server.mjs      # 25 项，只起一个 127.0.0.1 临时端口
```

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
