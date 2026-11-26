# @atian25/mihoyo-api-sdk

米哈游游戏 SDK：**登录 + 各游戏抽卡记录采集**。不做渲染、UP/歪判定、保底或报表统计，不强求各游戏返回同一种数据结构。

当前版本 `0.0.1`、`private: true`，不发布 npm。不依赖旧 `@atian25/zzz-stats-sdk`，也不修改其消费者。

## 当前可用公共层

从 `index.mjs` 导入：

- `createDs({salt,isSign,body?,query?,now?,random?})`：生成 DS；body/query 是实际发出的字符串。
- `signedHeaders(profile, options)` / `PROFILES`：passport（client_type=3/X4/类型2）、查角色（2/K2/签名型）、authkey（5/LK2/签名型）。按接口选配置，不能共享全局盐和 client_type。
- `encodeQrDataUrl(text)`：PNG data URL，不落盘，依赖 qrcode 1.5.4。
- `loginByAppQr({deviceFp,deviceId?,onQr,onProgress?,signal?,pollMs?,maxWaitMs?,dependencies?})`：App 扫码轮询，返回 `{stoken,mid,aid}`。
- `parseSToken(data)`：解析 Confirmed 的 `data.tokens` 数组，严格取 `token_type === 1`，不是 `data.token.token`。
- `getRoles({credential,signal?,dependencies?})`：一次返回全部游戏角色的上游 list，不替调用方选角色。
- `generateAuthKey({credential,gameBiz,gameUid,region,signal?,dependencies?})`：返回敏感 authkey 字符串；游戏参数由适配器传入。
- `SdkError`：稳定 code，可带 retcode，不携带上游消息、URL、响应体或凭据。

```js
import { loginByAppQr, getRoles, generateAuthKey } from './index.mjs';

const credential = await loginByAppQr({
  deviceFp: deviceFingerprint, // 调用方提供；没有编造默认值
  onQr: ({dataUrl}) => showQr(dataUrl),
  signal,
});
const roles = await getRoles({credential, signal});
const role = await selectRole(roles); // 游戏 UID，不是米游社 aid
const authkey = await generateAuthKey({
  credential,
  gameBiz: role.game_biz,
  gameUid: role.game_uid,
  region: role.region,
  signal,
});
```

`dependencies` 支持 fetch/now/random；扫码另支持 sleep/encodeQr，用于无网络测试。二维码回调 await，progress 只包含 stage/status，不传 ticket/token。操作支持 AbortSignal；取消不能撤回已发出的请求或调用方回调。

`maxWaitMs` 是扫码循环的本地等待预算，**不是网络请求硬超时或已验证的官方二维码 TTL**；请求本身由调用方 AbortSignal 限制。Expired 状态立即报错，未实现自动刷新或重试。不会自动换登录通道。

## 协议与敏感数据

- 当前公共登录层只实现国服 App passport，供原神/星铁路线使用。web/createQRLogin 不提供该路线需要的 SToken；拿 ltoken 调 genAuthKey 已实测登录失效，不能互换。绝区零另走 web + Cookie，不需要 SToken 或 authkey。
- genAuthKey client_type 必须为5，2/4已实测失败；查角色则为2。signedHeaders 同时带 App UA、app_version=2.119.0、app_id 和 bbs_cn 标识。查角色缺 app_version 已真实复现 -10001；逐项删掉 UA/app_id/game_biz 本次仍 rc=0。genAuthKey 逐项删掉上述四个附加头本次均 rc=0，但保留已验证的完整配置，不能据此断言所有附加头可同时删除。
- 原神 getGachaLog 使用 Node 默认 UA 与显式 App UA 本次均 rc=0，采集保持现有默认 UA；星铁没有真实账号，不外推原神结果。passport 全套 App/设备头保持不变。本次未重新扫码。
- App Confirmed 同次响应提取 tokens 数组，mid/aid 是账号身份，不能冒充游戏 UID。
- 返回 credential/authkey 是显式登录与授权能力；它们是敏感凭据，调用方不得写日志、公开 JSON/HTML、SSE 或错误追踪。只在受控内存保存，用完释放引用；JavaScript 不保证内存物理擦除。

## 游戏适配器

`genshin`、`starrail`、`zzz` 均导出 `{game,login,channels,collect,endpoint,verification}`。原神/星铁的 login 包含 App 扫码、过滤本游戏角色与生成 authkey；绝区零 login 已独立实现 web 扫码与 Cookie 角色查询，不调用 App/SToken 登录。三游戏 collect 均已实现；新包已用现成 SToken 真实验证 getRoles → genAuthKey → 原神三频道分页采集；App 扫码尚未在本包重新实跑，星铁未真实验证。

两条路线分开：原神/星铁走 App → SToken → genAuthKey → 原始日志；绝区零保留 web → Cookie → act 聚合接口。绝区零 authkey 日志存在结构性数据缺失，替换聚合接口会让现有报表掉功能，因此不为统一授权方式牺牲数据。

- 原神：外部已真实验证 App → SToken → authkey → 301/302/200 日志；本包实现相同流程，不算 UP 或保底。
- 星铁：**未验证真实授权采集**，实现仅照原神形态，频道1/2/11/12/21/22。getLdGachaLog、21/22 与普通接口的关系仍待核验，不宣称完整记录覆盖。

原神/星铁用法：

```js
import { genshin, starrail } from './index.mjs';
const session = await genshin.login({
  deviceFp: deviceFingerprint,
  onQr: ({dataUrl}) => showQr(dataUrl),
  selectRole: roles => chooseRole(roles), // 多角色时必选，也可传 role 精确选择
  signal,
});
const pagesByChannel = await genshin.collect({ ...session, signal });
// pagesByChannel['301'] 是原样上游响应数组，包含终止空页，未合并/改写 list。
// starrail 使用相同签名，但未真实验证。
```

`login` 返回 `{authkey,role}`，role 保持上游原样；只匹配本游戏 game_biz，多角色没有选择器时报 ROLE_SELECTION_REQUIRED。`collect({authkey,role,channels?,maxPages?,intervalMs?,signal?,dependencies?})` 返回频道到原始响应数组，不套 records/summary/coverage 统计壳。默认每频道最多1000页、间隔350ms、每页20条；空页停止（短页不停止），末条字符串 id 作为下页 end_id。重复游标或达到上限抛错，不静默交付未完成采集。authkey 是敏感凭据，不能写入公开报表或日志。
- 绝区零：`loginMethod: 'web'`、`protocol: 'act-aggregate'`；使用 Cookie 调 `/index`、`/cur_pool_stat`、`/hist_pool_stat`，必须带官方活动页 Referer，缺失会返回 -100。`zzz.collect({cookie,gameUid,region?,channels?,signal?,dependencies?})` 已实现，返回 `{index,cur_pool_stat_<id>,hist_pool_stat_<id>}`（官方响应形状；hist 分片合并并按四元组去重），不生成统计或 meta。依次 index → 每频道 cur → hist，版本降序每片最多10个，请求间隔350ms；cur 失败空 list 兜底，取消和 hist 失败抛出。`channels` 是字符串 ID 数组，默认六频道；`dependencies` 支持 fetch/sleep。适配器登记 cn/os 基址，region 默认 prod_gf_cn；国际服未真实验收。web 登录已实现，Cookie 只在受控内存返回，不打印或落盘；旧包不动。

```js
import { zzz } from './index.mjs';
const session = await zzz.login({
  onQr: ({dataUrl}) => showQr(dataUrl),
  onProgress: event => showProgress(event),
  signal,
});
const aggregate = await zzz.collect({ ...session, signal });
```

`zzz.login` 返回 `{cookie,gameUid,region,nickname}`，游戏 UID 取 nap_cn/prod_gf_cn 角色而非账号 aid。可直接传 `zzz.collect(session)`；需额外取消参数时展开 session。每次 Confirmed 同一响应读取四项 Set-Cookie，不从 tokens 数组取 web 凭据，不再轮询补取。服务端 Expired 或本地约2分钟过期自动申请新码并再次 await onQr；默认整体预算10分钟，可传 `maxWaitMs`/`pollMs` 调整。预算不是网络硬超时，调用方可用 AbortSignal 限制请求；本轮 web 扫码仅假网络验收，未真实扫码。

## 测试

仓库根执行（不联网、不用真凭据）：

```sh
node --test packages/mihoyo-api-sdk/test/*.test.mjs
```

覆盖 DS 固定输入、接口配置、SToken 正误响应、真实轮询函数的假网络流程、角色/授权请求、取消/过期/超时、错误脱敏及适配器占位。假响应全部 FAKE 标记，不能冒充真实账号端到端验收。

包 manifest 声明 qrcode。本轮未修改根配置/锁文件；依赖编码验收在 output 下的新包隔离副本安装，后续正式接入依赖时由维护者统一生成 workspace 锁文件。仅 DS/解析/假网络测试不需要安装 qrcode。

## 尚不确定

设备指纹 deviceFp 的自动获取流程未提供，因此是必填输入。签名型六位随机字母数字、类型2六位随机整数采用常见 DS 形式，但随机值分布和 App 附加设备请求是否有更严格要求，仍需本包真实调用验证。新包已使用现成 SToken 真实验收查角色、生成 authkey 和原神采集；未真实重跑 App 扫码，因此不把假网络登录测试写成真实登录成功。
