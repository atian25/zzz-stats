# zzz-stats

把《绝区零》官方「调频统计工具」的数据抓下来，生成一张**一屏可读**的抽卡报表。

这是一个 Agent Skill（`zzz-stats`）：扫码登录 → 抓官方接口 → 落本地 JSON → 按固定口径出图。

![报表预览](docs/preview.png)

## 能做什么

- **采集**：6 个频道（角色、音擎、常驻、邦布等）的总抽数、S 数、UP 数、当前垫抽，以及每一金的物品、稀有度、是否 UP、消耗抽数、时间戳、池内序号。
- **报表**：每轮 UP 成本堆叠柱 + 累计不歪率折线，双头像、十连多金标记、版本分隔、悬浮 tip、事件标签，1440×900 / 1280×800 单屏无滚动。
- **口径稳定**：所有数字以官方接口 + 频道 `gacha_count` 对齐，不做估算。

## 快速开始

跟你的 Agent 说：

> 安装 `https://github.com/atian25/zzz-stats` 这个 skill，并帮我运行

Claude Code、Trae、Codex、DeepSeek Harness 等支持 Agent Skill 的客户端都适用；Agent 会把仓库装进自己的 skills 目录并直接开始跑。手动安装也可以：

```bash
git clone https://github.com/atian25/zzz-stats.git ~/.claude/skills/zzz-stats
```

后续流程由 skill 接管：

1. Agent 驱动你自己的 Chrome 打开官方调频统计工具，把登录二维码画到对话里；
2. 你扫码，数据被抓到本地 `data/*.json`（不经过任何第三方服务）；
3. 需要报表时，按 [references/report-rules.md](references/report-rules.md) 生成 `report.html`。

## 报表口径

| 指标 | 定义 |
|---|---|
| UP 周期 | 从上一金之后到该 UP 的抽数；`off` = 期间非 UP 的 S 消耗，`up` = 之后到 UP，`total = off + up` |
| 每 UP 需 | 角色池总抽 / UP 数（含歪成本） |
| 不歪率 | 50/50 胜场 / 总 UP 轮数（保底获得的 UP 不计胜场） |
| 平均每金 | 总抽 / S 数（常驻、音擎、邦布按各自频道） |
| 欧 | 直出，或 `total ≤ 每 UP 均值`（歪了但更省也算欧） |
| 极欧 | `total ≤ 40` 抽 |

同一发十连里后出的非 UP 金，归到**同池 UP 那一轮**（总抽 +差值、仍算直出），不留给下一个 UP——这样既不会把下一位误判成「先歪」，总抽也始终等于官方 `gacha_count`。

配色：蓝 = 极欧（≤ 40），深绿 = 欧（> 40），亮红 = 非酋本发、深红 = 歪掉的抽数。

## 称号与标签

称号只看「角色池每 UP 均（含歪）」，基准 62.5 × 1.5 = 93.75 抽：

| 每 UP 均 | 称号 |
|---|---|
| ≤ 65 | 终极无敌至尊欧皇 |
| ≤ 75 | 万里挑一至尊欧皇 |
| ≤ 89 | 欧气满满大欧皇 |
| ≤ 100 | 欧气附体小欧皇 |
| ≤ 110 | 薛定谔的非欧 |
| ≤ 125 | 超级至尊非酋 |
| ≤ 150 | 千里挑一大非酋 |
| > 150 | 万劫不复大非酋 |

事件标签（按出现次数 ×N，悬浮看详情并联动高亮对应柱）：

- `欧气附体`（双金 ≥ 1 或极欧柱 ≥ 2）、`运势极佳`（最长连 UP ≥ 4）
- `代理人 K 连 UP ×N`、`代理人 K 连歪 ×N`（更长的一档另立标签）
- `十连双金 ×N`（不写人名）
- `似非不非 ×N`：先歪但总抽 < 每 UP 均值

## 数据与隐私

- 只取官方页面的三个响应体：`index`、`cur_pool_stat`、`hist_pool_stat`；接口见 [references/api.md](references/api.md)。
- **不索取账号密码、验证码、cookie、token**，登录由用户自己扫码完成；登录态留在用户自己的 Chrome profile 里。
- 数据只落本地 `data/`，不上传；仓库里不含任何账号数据。
- 报表头部自带隐私开关：点 UID 旁的眼睛，在「全显示 → 仅打码 UID → 昵称与 UID 全打码」三态间循环；对外截图请先切到全打码。
- 页面：`https://act.mihoyo.com/zzz/event/gacha-record/index.html`
- 接口基址：`https://act-api-takumi.mihoyo.com/event/nap_gacha_record`

## 目录结构

```
SKILL.md                    # skill 入口：采集流程、边界、失败处理
references/api.md           # 接口与字段说明（含十连多金判定）
references/report-rules.md  # 报表口径、配色、tooltip、称号、标签、单屏与验证
docs/preview.png            # 报表预览
```

## 说明

非官方工具，数据来自米哈游公开活动页接口；页面或接口改版可能导致失效，处理方式见 `SKILL.md` 的「失败处理」。
