# AGENTS.md — 改这个仓库的 agent 读这里

这是**开发期**约定：给要改 `scripts/` / `assets/` / `config/` 的 agent 看。
`SKILL.md` 是**运行期**说明书（给宿主 agent 采集抽卡数据用），两边各管一边，不要把开发规则写进 SKILL.md。

## 开发期验收

- **被测 skill 必须在独立 session 或 sub agent 里跑**，不要在正在写它的那个会话里跑。
  - **怎样才算独立**：改 `scripts/` / `assets/` / `config/` 的那个会话只负责改，验证另开一个会话
    或 sub agent 去跑。同一个会话里「我在写它」和「我在用它」两套语义会互相污染。
  - **为什么**（这次真实发生过的，不是假设）：写 skill 的会话在 06:38:05 才 `turn/end: aborted`，
    但它在 06:36:11 和 06:37:19 还在往仓库写 `scripts/build-report.mjs` 和 `config/report.json`，
    留下一个跑不起来的半成品——`evaluateTags()` 引用了从未定义的 `groupBars()`，直接 ReferenceError。
    而且那几轮它自己的判断已经被两套语义带偏，绕了很大一圈才定位到根因是 SKILL.md §0
    把「采集期找浏览器」和「开发期截本地图」混成了一个入口。
  - **验证完怎么交接**：验证会话把结论带回来（exit code、实际渲染结果、像素/对比度实测值），
    改的会话据此决定是否提交；**两边不要各留一半改动**。
- 截图走 `node scripts/screenshot.mjs`（默认出 1440×900 与 1280×800 到 `docs/shots/`）。
  **不要**按 SKILL.md §0 的浏览器优先级去现拼 Chrome 命令行——那是采集期「找能扫码登录的浏览器」的语义，
  跟「截一张本地 HTML 的图」是两件事。`--user-data-dir` 脚本里已焊死，别再踩。
- **README 预览图走 `node scripts/screenshot.mjs --preview`，不要手截。**
  出的是 `docs/preview.png`：1440 逻辑宽、DPR 2、整页（当前实测 `2880×2838`，高度跟内容走），并强制打码到 2、
  截图前断言 `eye=2` 且昵称/UID 含 `*`（不通过就中止、不写文件）。
  以前这张图是手工截好随仓库带的，代码一路改而图停在旧版——很长一段时间里 README 上那张
  还是黄色折线、带「黄线＝累计不歪率」尾注、右轴 60% 的旧版本，没有任何东西会提醒你它过期了。
- **headless 的 `--window-size` 有 500px 最小宽度，窄屏验收必须靠 CDP 设备模拟。**
  脚本已改成 `Emulation.setDeviceMetricsOverride`，并在收尾自检里比对「页面自报 `innerWidth`」与标称宽度，
  不等就报 `⚠️ 不符` 并退 1。别退回 `--screenshot` + `--window-size` 的老写法：
  那样传 `--width 390` 截出来的是 500px 视口**裁掉右边**的图，尺寸看着对、内容却是假的。
  这个坑真实发生过——「窄屏过滤条被裁」一度被当成 CSS bug，其实是假视口造成的。
- **产物按数据集分开出，`output/report.html` 已废弃。**
  现在不传 `--out` 时默认写 `output/report-<数据集名>.html`（`--data data/tianzhu` → `output/report-tianzhu.html`），
  所以直接 `node scripts/build-report.mjs --data data/<账号>` 就是对的，不用再手写 `--out`。
  两份账号混用同一个文件名时，后一次构建会盖掉前一次，而两份报表只差数字、发错人不会有人发现——所以那个名字不再保留。
- 不要为了截图去 `session_search` 追截图里的外部链接或部署环境，与本次改动无关。

## 数据集

- `data/<账号>/` 一份数据集一个目录，`data/tianzhu/` 与 `data/joker/` 平级。
- 出图与采集都用 `--data` 指定；`data/` 下有多份且没写 `--data` 时构建**报错退出**，不猜。
- `data/` 整个目录在 `.gitignore` 里，含真实 UID，**永不入库**。
- **天猪是对外展示基线，joker 是测试数据。** README 头图（`docs/preview.png`）、发布说明、
  任何人看得到的图一律用 `data/tianzhu` 出；`data/joker` 只用来验证多金分档（双金 + 三金，
  见 `report-rules.md` §8.1），**不拿来截图对外**。它的数字不好看是正常的，不代表报表有问题。

## 改动的分工

- 改口径 / 阈值 / 称号 / 文案 / 配色 → 只改 `config/report.json`。
- 改算法 → `scripts/build-report.mjs`，并同步 `references/report-rules.md`。
- 改视觉 → `assets/report/charts.{js,css}`，并同步 `references/report-rules.md` §2–§6。
- **「改配置就生效」是硬约定**：不要在 CSS / JS 里另写一份硬编码色值。
- 任何改动后跑 §8 回归基线与 §9.3 验收，确认控制台数字与截图。

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
