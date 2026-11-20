# 官方调频统计接口（实测）

实测时间：2026-11-19，国服账号，浏览器登录态。
所有结论均来自真实请求与响应，未凭记忆填写。未验证项已标注。

## 页面

| 区服 | 页面 |
|---|---|
| 国服 | `https://act.mihoyo.com/zzz/event/gacha-record/index.html` |
| 国际服 | `https://act.hoyolab.com/zzz/event/gacha-record/index.html` |

页面是 Vue 客户端渲染，原始 HTML 只有约 6.8 KB 空壳，数据全部来自下列接口。

## 接口基址

| 区服 | 基址 |
|---|---|
| 国服 | `https://act-api-takumi.mihoyo.com/event/nap_gacha_record` |
| 国际服 | `https://sg-act-public-api.hoyolab.com/event/nap_gacha_record` |

鉴权方式：**登录 cookie**（`withCredentials`）。URL 中不含 authkey、不含签名参数。
未登录请求返回：

```json
{"data": null, "message": "Please log in to take part in the event (-100)", "retcode": -100}
```

## 1. 汇总：`GET /api/zzz/index`

```
?uid=<UID>&region=<prod_gf_cn|prod_gf_jp|prod_gf_us|prod_gf_eu|prod_gf_sg>
```

`data` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `total_gacha_count` | string | 账号总抽数 |
| `total_s_count` | string | 账号 S 总数 |
| `cur_ver` | string | 当前版本，如 `3.3` |
| `type_stats` | array | 6 个频道的统计，见下 |
| `cur_tickets` | array | 当前调频券，`{ticket_type, ticket_cnt}` |
| `cur_head_icon_url` | string | 头像 |
| `show_resource_bubble` | bool | UI 提示 |

`type_stats[]` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `gacha_type` | string | `GACHA_TYPE_CHARACTER_UP` / `_CHARACTER_RETURN` / `_WEAPON_UP` / `_WEAPON_RETURN` / `_PERMANENT` / 邦布（字符串值待确认） |
| `total_count` | string | 该频道总抽数 |
| `s_count` | string | S 数量 |
| `up_count` | string | UP 数量 |
| `avr_up_count` | string | UP 平均抽数 |
| `new_s_max_times` | number | 官方 UI 的「获得 S 级信号最多需要 N 次」区间值（实测 90 / 80 / 76 / 68）。**不是硬保底，也不等于历史最长出金间隔**（实测常驻频道该值为 32，而该频道最长出金间隔是 80），展示前请勿当保底用 |
| `next_s_cur_times` | number | 当前垫抽进度 |
| `has_data_vers` | array | 有数据的版本列表，可用于判断覆盖范围 |

## 2. 历史卡池 + 每金记录：`GET /api/zzz/hist_pool_stat`

```
?uid=<UID>&region=<REGION>&gacha_type=<1|2|3|5|102|103>&vers=3.1,3.0,2.7,...
```

- `vers` 为逗号分隔的版本列表，**必须取自该频道自己的 `type_stats[].has_data_vers`**，且**单次最多 10 个**。
  - 实测：一次给 20 个（跨频道并集）→ `{"retcode":-400005,"message":"参数错误"}`；按 10 个分片 → 正常。
  - 实测：给当前版本（如 `3.3`）不报错，只是返回 0 个池子——当前版本的数据在 `cur_pool_stat` 里。
  - 页面自己只请求最近 8 个版本（bundle 里 `historyPageSize` 默认 8、上限 10），要拿更早的历史必须自己分片。
- `gacha_type` 为数字，六个频道均实测：`2` 独家频段、`3` 音擎频段、`102` 独家重映、`103` 音擎回响、`1` 常驻频段、`5` 邦布频段。

`data.list[]` 每个元素是一个卡池：

| 字段 | 说明 |
|---|---|
| `gacha_type` | 卡池类型字符串 |
| `gacha_state` | `GACHA_STATE_ENDED` 等 |
| `version` | 版本号 |
| `start_ts` / `end_ts` | 起止时间（当前版本可能为 0） |
| `cur_item_list` | 当前 UP 物品（实测为空数组时仍可能是老池） |
| `cur_records` | **每一金一条**，见下 |

`cur_records[]` 字段（实测样本）：

| 字段 | 示例 | 说明 |
|---|---|---|
| `item_id` | `"1581"` | 物品内部 ID |
| `name` | `"蕾米埃尔"` | 名称 |
| `icon` | `https://act-webstatic.mihoyo.com/...png` | 图标 |
| `item_type` | `ItemType_Avatar` | 代理人 / 音擎 / 邦布 |
| `rarity` | `"S"` | 稀有度 |
| `is_up` | `true` | 是否 UP |
| `up_tag` | `"UP_TAG_NONE"` | UP 标记 |
| `count` | `"8"` | **距上一金的抽数**（不是池内累计）；跨池连续，等于相邻两条记录的 `sort` 差 |
| `record_time` | `"1785292144"` | **Unix 时间戳（秒）**。同一次请求（如一发十连）内的多条 S 共用同一秒 |
| `sort` | `"2348"` | **频道内跨池连续的序号**（每个频道各自从 1 开始，不是账号全局，也不是池内序号）；`count` 恒等于相邻两条的 `sort` 差 |

### 派生判定：十连多金

两条 S 记录同时满足 **`record_time` 相同（同秒）** 且 **`sort` 差 ≤ 9** 时，属于同一次十连请求里出的多个金，即"十连多金"。

- 依据：同一次请求返回的多条记录共用服务端同一个时间戳；`sort` 逐抽递增，差值就是两金之间隔了多少抽。
- 只看"同一分钟"会误判：实测 71 抽只用了 66 秒，一分钟内能塞进多次十连。必须先比同秒，再看 `sort` 差。
- 实测样本：`南宫羽(44) → 猫又(1)` 差 1 抽、两组时间戳完全同秒；`珂蕾妲(21) → 菲欧妮(3)` 差 3 抽，同样同秒。两条都属于同一发十连双金。
- 报表里应作为**"运气好"**的独立维度表达（如"十连多金 N 次"），不要和"小保底没歪"混为一谈。

## 3. 当前卡池：`GET /api/zzz/cur_pool_stat`

```
?uid=<UID>&region=<REGION>&gacha_type=<同上>
```

`data.list[]` 是**池子**，不是单条记录。实测字段（频道 2，版本 3.3，返回 2 个池子）：

| 字段 | 示例 | 含义 |
|---|---|---|
| `gacha_type` | `"2"` | 卡池类型 |
| `gacha_state` | `"GACHA_STATE_IN_PROGRESS"` / `"GACHA_STATE_ENDED"` | 进行中 / 已结束 |
| `version` | `"3.3"` | 版本号 |
| `start_ts` / `end_ts` | `1794369600` | 池子起止时间（Unix 秒，**这里是数字**） |
| `left_start_ts` / `left_end_ts` | `0` | 延长窗口，无则为 0 |
| `sup_lock_show` | `false` | UI 用 |
| `cur_item_list[]` | `[{...}]` | 本期 UP 物品，实测 2 条 |
| `cur_records[]` | `[{...}]` | 本期已出的 S 记录，字段同 §2 的 `cur_records[]` |

**注意**：`cur_pool_stat` 里**没有** `new_s_max_times` / `next_s_cur_times`——「当前垫抽」只存在于 `index` 的 `type_stats[]` 里。

一个版本可能返回 2 个池子（上半 + 下半），两者的 `cur_records` 都要统计。

## 4. 取数注意

- 页面发出的请求带 `uid` / `region`，这两个值由账号 SDK 注入，不在页面地址里。
- 请求靠 cookie 鉴权（`withCredentials`），URL 无 token；未登录返回 `retcode: -100`。
- **页内 `fetch` 可用**：在 `act.mihoyo.com` 页面上下文里请求会被 CORS 放行（该源已白名单），一次导航即可取完全部接口。在别的源里 fetch 会被拦。
- 旧路径「导航到接口 URL 再读正文」仍然有效（浏览器会自动带 cookie），只是慢；读正文时先截到第一个 `{`。
- **完整性等式**：`sum(cur_records[].count) + type_stats[].next_s_cur_times == type_stats[].total_count`（实测 6/6 频道成立）。
  它校验抽数而不只是金数，缺抽会立刻暴露。老等式「记录条数 == s_count」也成立，但抓不出「金数对、抽数缺」。
- `index.total_s_count` **不含邦布频段**：实测 96 条 S 记录，去掉邦布 34 条后正好等于 62。
- `index.total_gacha_count` **同样不含邦布**：实测 3714，六个频道相加是 5375。报表里这两个口径要分别标注。

## 能力边界

| 能力 | 是否支持 |
|---|---|
| 频道汇总、当前垫抽、官方 UI 的保底区间值 | 支持 |
| 每金的物品、时间、抽数、是否 UP | 支持 |
| 4 星 / 逐抽 / 记录 ID | 不支持 |
| 分页取全量明细 | 不支持（无 `end_id`/`page` 参数） |
| 覆盖范围 | 账号注册以来（`has_data_vers` 从 1.0 起） |

需要 4 星与逐抽记录时，只能走游戏内 `getGachaLog` + authkey（约 6 个月），与本接口是两套数据源。

### authkey 怎么来（已实测，2026-11-20）

**结论：authkey 能用登录 cookie 换出来，不需要 App 特权。** 之前误判成「浏览器拿不到」，
是因为找错了端点 —— `genAuthKey` 确实是米游社 App 的原生桥（`x("genAuthKey")`），
但账号 SDK 里另有一条**纯 HTTP** 路径：

```
POST https://passport-api.mihoyo.com/account/binding/api/genAuthKeyByCookieToken
Content-Type: application/json
x-rpc-source: v2.webLogin
（credentials: include，即带登录 cookie）

{"game_biz":"nap_cn","region":"prod_gf_cn","auth_appid":"webview_gacha","game_uid":"<uid>"}

→ {"retcode":0,"data":{"sign_type":2,"authkey_ver":1,"authkey":"SEx0c8Fq..."}}
```

拿到的 authkey 约 344 字符、有效期约 24 小时，直接拼进：

```
https://public-operation-nap.mihoyo.com/common/gacha_record/api/getGachaLog
  ?authkey_ver=1&sign_type=2&auth_appid=webview_gacha
  &init_log_gacha_type=1001&gacha_type=1001     ← 注意：绝区零用 1001/2001
  &page=1&size=20&end_id=0&lang=zh-cn&game_biz=nap_cn
  &authkey=<authkey>
```

**gacha_type 是两套编号**，别混：

| 用途 | 编号 |
|---|---|
| 活动页接口（本 skill 主力） | `1` 常驻 / `2` 独家 / `3` 音擎 / `5` 邦布 / `102` 独家重映 / `103` 音擎回响 |
| `getGachaLog`（第三方工具用） | `1001` 角色 / `2001` 音擎 |

实测返回：`retcode:0`，`list[].name` 为「兔能环」「菲欧妮」等真实记录。

**风险提示**：authkey 是可直接拉取抽卡记录的凭证（比 cookie 更直接）。
`collect.mjs --authkey` 只把它**打印到终端**，绝不写进 `data/` 或任何产物文件；
有效期约 24 小时，用完自然失效。

## 变更风险

- 三个接口均为活动页内部接口，无公开文档，随时可能改路径或字段。
- 页面改版时，先确认 `index` 请求是否仍存在，路径变了就同步更新本文件与 `SKILL.md`。
