# 采集 SDK 接口与实现状态

状态：五名公共接口、宿主策略剥离、人工操作复验、事件与取消已落地。历史审计基准为 `1c8d7aa`（2026-11-25）；CDP host/协议透传、专用 target 与自启进程关闭已补齐，剩余限制见下文。

## 1. 定位与最终公开面

SDK 负责官方调频统计数据的登录、取数和二维码编码，支持 Node.js >=22、ESM。使用者不需要安装 skill，不读取报表配置、模板或宿主 profile。

**只公开根入口的五个名字：**

```js
import {
  collectData, login, collect, encodeQrDataUrl, SdkError,
} from '@atian25/zzz-stats-sdk';
```

| 名字 | 契约 |
|---|---|
| `collectData(options)` | 登录并取数，返回完整结果 |
| `login(options)` | 只登录，返回 session |
| `collect(options)` | 用已有 session 取数，不重新登录 |
| `encodeQrDataUrl(text)` | 异步返回 PNG data URL 字符串，SDK 包住 qrcode |
| `SdkError` | 结构化错误类型 |

目标 package exports **只有一条 `.`**：

```json
{ "exports": { ".": "./index.mjs" } }
```

不再有 `./qr`、`./drivers`、`./transport` 或 `./qr-wait`。根入口使用显式导出名单，不用 `export *`。

`qrcode` 是 SDK 的生产依赖，随正常包安装自动解析，**使用者不用单独安装或 import qrcode**。它不是可选 peer，也不要求使用者找 vendor 路径。

SDK 不保存采集产物、二维码或短信中转文件，不监听 stdin，不读 argv，不退出进程。浏览器自身可能写 profile；目录位置、保留与删除归调用方，不由 SDK 猜测。

## 2. 基线审计（1c8d7aa，已过时）

以下是 `1c8d7aa` 的历史快照，不描述已修改工作区。该基线包为 `@atian25/zzz-stats-sdk@0.1.0`，`private: true`；各项状态按本轮实现标记。

- 基线根入口 **18 个导出**：collectData、collectFiles、buildMeta、sortVersionsDesc、chunk、MAX_VERS、REQUEST_GAP_MS、loginWithQr、resolveGameUid、cookiesFromSetCookie、loginByQrNode、collectViaNode、loginByQrBrowser、collectViaBrowser、closeBrowserSession、createNodeTransport、encodeQrDataUrl、dataUrlToBuffer。**已修复：根入口恰好五名，见 §1。**
- 基线 package exports 有根、`./qr`、`./drivers` **三条**。**已修复：只保留根入口一条。**
- 基线 drivers 文件 export LOGIN_FRAME_RE、findChrome、chromeArgs、openDriver。**已修复：仅为内部模块导出，无包子路径出口。**
- 基线 browser 登录文件额外 export smsLogin、loginFlow、collectWithBrowser，以及重复再导出的 MAX_VERS。**已修复：旧 collectWithBrowser 已删除，其余不属于公共入口。**
- 基线 transport 文件额外 export ACT_API、nowIso。**已修复：nowIso 已删除，ACT_API 留作内部协议常量。**
- 基线 QR 等待文件 export REFRESH_SIGNAL_FILE、isRefreshKey、refreshChannelHint、expiredRefreshHint、createQrClock、createRefreshInput、waitForLogin，但没有包子路径出口。**已修复：终端工具与提示已删除，计时和等待机制留在内部。**

基线发现的问题与处理状态：

1. collectData 已接受 options 对象，但字段平铺、职责交叉，要求整份 cfg，实际只需频道表。**已修复：SDK 内置协议表，不再接收报表 cfg。**
2. 顶层 onQr/onProgress/encodeQr 等，与 browser 内 input/purge/sms/saveQrFile 混用；qrVendorPath 在基线前已删除。**已修复：公共参数分层，宿主策略兼容分支已摘掉。**
3. Node 登录返回的 uid 是米游社账号 ID，gameUid 才是游戏 UID；Node 取数的 uid 又指游戏 UID。**已修复：公共 session 明确使用 gameUid，身份字段只读；旧命名仅留内部。**
4. Node 完整流程返回顶层 meta，files 不含 meta.json；browser 完整流程把 meta.json 插入 files，没有顶层 meta。browser 独立取数则两边都有。**已修复：公共结果统一顶层 meta，files 不含 meta.json。**
5. 六频道实际是 13 个响应键，加 meta 才是 14，旧注释“14 个键且不含 meta”计数不准确。**已修复：契约明确为 13 个响应键与单独 meta。**
6. Node onQr 会 await，browser onQr 不会；内部 loginFlow 的 persistQr 默认值依赖外层修正。**已修复：两通道均 await onQr({dataUrl})，persistQr 已删除；browser 可省略回调。**
7. 大多失败为普通 Error，部分取数错误带 retcode，没有统一 code。**部分修复：公共错误经 SdkError 收口，HTTP、JSON、必要字段、页面与短信等已知场景补齐分类；不承诺已覆盖所有真实上游失败。**
8. cur 请求的宽泛 catch 会把任意错误转为空数据。**仍存在：保留容错，catch 外检查取消以阻止后续动作；见 §6.3。**
9. 登录/取数不自动换 Node/browser，但默认驱动可从 Playwright 启动失败退回 CDP。**仍存在（有意保留）：驱动可用性回退不等于登录/采集通道降级。**
10. CDP 只读取 URL 的 port，实际连 localhost；可能导航已有标签页，close 只断开连接，不结束自己启动的 Chrome。**已修复：透传 URL 的 host/port/协议，默认 host 为 127.0.0.1；只创建和关闭自己的 target；只终止自己 spawn 的进程，SIGTERM 后 SIGKILL 兜底并等待退出，取消启动也收尾。借入 Chrome 不终止。**

仍保留的限制：cur 容错如上；CDP 连接已断开或创建请求无响应时无法保证删除远端 target，已发浏览器副作用不可撤销；等待窗口未统一，Node QR 默认 180000ms、browser QR 默认 600000ms、SMS 登录态窗口 60000ms。

## 3. 名字收敛与内部边界

| 原名字或类别 | 目标处理 | 理由 |
|---|---|---|
| loginByQrNode / loginByQrBrowser / 草案 loginBrowser | 对外合并为 `login` | 方式和通道用参数选择，不在函数名里混用维度 |
| collectViaNode / collectViaBrowser | 对外合并为 `collect` | 由 session 判定通道，避免调用错入口 |
| closeBrowserSession | 对外改为 `session.close()` | 会话自己表达关闭能力，不再加根导出 |
| encodeQrDataUrl | 根入口保留 | SDK 包装 qrcode，使用者不需要单独装库 |
| dataUrlToBuffer | 内部保留，不公开 | 测试/内部转换不增加公共 API |
| openDriver | 内部，不公开工厂 | browser 通道通过 options 注入驱动或启动参数 |
| createNodeTransport / collectFiles | 内部，不给子路径 | 纯采集测试在仓库内直接 import 内部模块 |
| loginWithQr / resolveGameUid / cookiesFromSetCookie | 内部 | passport 流程零件、角色解析和特定 Cookie 白名单 |
| buildMeta | 内部 | 数据集 schema 组装细节 |
| chunk / sortVersionsDesc / nowIso | 内部 | 数组、版本格式和时间工具，无独立公共业务价值 |
| MAX_VERS / REQUEST_GAP_MS / ACT_API | 内部 | 协议限制、间隔和默认端点，不制造额外导出承诺 |
| LOGIN_FRAME_RE / findChrome / chromeArgs | 内部 | DOM 匹配与浏览器发现细节，通过 browser 参数表达环境输入 |
| createRefreshInput / isRefreshKey / REFRESH_SIGNAL_FILE | 内部，不公开 | 刷新缓冲、终端键位与文件名不是采集协议 |
| refreshChannelHint / expiredRefreshHint | 不公开 | 提示文案由调用方负责，不纳入机器契约 |
| createQrClock / waitForLogin | 内部 | 登录超时和刷新行为通过 login options 表达 |
| smsLogin / loginFlow / collectWithBrowser | 内部 | 页面流程零件与内部组合，不再公开重复入口 |

内部模块可为测试保留 export；这不等于 npm 包公共接口。测试不为了访问内部实现新增 package exports。

## 4. 两个维度与参数

```js
{
  channel: 'node' | 'browser', // 执行通道，默认 node
  login: {
    method: 'qr' | 'sms',     // 登录方式，默认 qr
  },
}
```

| 执行通道 | QR | SMS |
|---|---|---|
| node | 支持国服 | 不支持，**联网前 INVALID_ARGUMENT** |
| browser | 支持 | 支持，当前限国服 +86 |

region 表示游戏区服，channels 表示采集的调频频道列表，不与执行通道 channel 混用。不存在按通道命名一个函数、按方式命名另一个函数的公共接口。

### 4.1 目标类型草图

```ts
type Region = 'prod_gf_cn' | 'prod_gf_jp' | 'prod_gf_us' | 'prod_gf_eu' | 'prod_gf_sg';
type ExecutionChannel = 'node' | 'browser';
type GachaChannel = { id: string; enum: string; label: string };
type Dependencies = {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  encodeQr?: (text: string) => Promise<string>;
};
type ProgressEvent = {
  stage: 'login' | 'collect' | 'done';
  status: 'started' | 'qr-issued' | 'scanned' | 'confirmed' | 'expired'
    | 'qr-unavailable' | 'refresh-denied' | 'manual-action-required'
    | 'sms-sent' | 'sms-submitted' | 'channel-start' | 'channel-done' | 'completed';
  message?: string; // 诊断文字，不作为状态判断依据
  channelId?: string;
  ttlMs?: number; // qr-issued 的协议估计，不是保证的服务端有效期
};
type CommonOptions = {
  region?: Region;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
  log?: (message: string) => void;
  dependencies?: Dependencies;
};
type QrEvent = { dataUrl: string };
type LoginInput = {
  requestPhone?: (context: { signal?: AbortSignal }) => string | Promise<string>;
  requestCode?: (context: { signal?: AbortSignal }) => string | Promise<string>;
  takeRefreshRequest?: () => { refresh: boolean } | Promise<{ refresh: boolean }>;
  subscribeRefresh?: () => (() => void);
  requestManualAction?: (context: { reason: string; signal?: AbortSignal }) => void | Promise<void>;
};
type LoginOptions = {
  method?: 'qr' | 'sms';
  onQr?: (event: QrEvent) => void | Promise<void>; // node 必传；browser 可选
  input?: LoginInput;
  pollMs?: number;       // Node QR 2000 / browser QR 3000
  maxWaitMs?: number;   // Node QR 180000 / browser QR 600000，不统一缩短
  maxRefresh?: number;  // browser QR 当前默认 3
  minRefreshGapMs?: number; // browser QR 当前默认 5000
};
type SessionBase = {
  readonly channel: ExecutionChannel;
  accountId: string | null;
  readonly gameUid: string;
  nickname: string | null;
  readonly region: Region;
  close(): Promise<void>;
};
type NodeSession = SessionBase & {
  channel: 'node';
  cookieHeader: string; // 敏感，不进入日志、报表或 SSE
};
type BrowserSession = SessionBase & {
  channel: 'browser';
  // 浏览器上下文由 session 内部持有，不要求调用方读 drv/page/browser 私有字段
};
type Session = NodeSession | BrowserSession;
type BrowserOptions = {
  driver: BrowserDriver | DriverOptions; // 参数注入，不公开驱动工厂
};
```

Region、Session、BrowserDriver 等是类型草图，不增加运行时导出。browser 不可靠获得米游社账号 ID 时 accountId 为 null，不用游戏 UID 冒充。

### 4.2 三个业务入口

```ts
login(options?: CommonOptions & {
  channel?: ExecutionChannel;
  login?: LoginOptions;
  browser?: BrowserOptions;
  endpoints?: { page?: string };
}): Promise<Session>;

collect(options: CommonOptions & {
  session: Session;
  channels?: GachaChannel[];
  endpoints?: { api?: string };
}): Promise<CollectionResult>;

collectData(options?: CommonOptions & {
  channel?: ExecutionChannel;
  login?: LoginOptions;
  browser?: BrowserOptions;
  channels?: GachaChannel[];
  endpoints?: { api?: string; page?: string };
}): Promise<CollectionResult>;
```

- collectData 内部组合 login 与 collect，选定通道后失败不自动换路。
- 已有 session 直接调用 collect；collectData 不再增加 session 分支，避免登录参数与已有会话冲突。
- collect 从 session.channel 选择通道，不再接第二个 channel；session.region 是权威来源，显式 region 不一致时拒绝。
- 无效参数先于联网、浏览器启动和短信动作报 INVALID_ARGUMENT；node+sms 即使其他参数也有问题，仍须在任何 I/O 前拒绝。
- Node 当前仅国服，其他区服报 UNSUPPORTED_REGION，不猜国际服 passport。browser 支持的 region 名字不代表本轮已实测国际服。
- channels 默认 SDK 内置六频道协议表，不接报表 cfg；显式列表需非空、id/enum 唯一且为支持的官方值。
- browser 通道通过 browser.driver 注入现有驱动或启动参数。SDK 不猜 HOME、宿主 profile 或祖先依赖目录，官方 page/api 按 region 默认选择。
- node 通道的 login/collectData 必须传 login.onQr 函数，因为纯 Node 没有窗口展示二维码；未传在联网前抛 INVALID_ARGUMENT。browser 通道可以不传，用户在可见窗口里直接扫码。collect 只取数，不需要 onQr。
- 不接受 purge/saveQrFile/qrUrlFor/persistQr/waitMode 等文件、TTY 或宿主任务策略。调用方负责展示与凭据中转文件清理。

### 4.3 session.close() 与所有权

- login 成功返回的 session 由调用方在 finally 中 close；collect 不关闭借入的 session，可重复取数。
- Node session.close() 无浏览器资源可释放，但统一幂等地标记会话关闭；关闭后不能再 collect。
- browser session.close() 关闭 SDK 创建的页面/连接/进程，不关闭调用方借给 SDK 的外部 driver 或用户浏览器；调用方自有 driver 仍由调用方释放。
- collectData 无论成功、失败、取消都清理本次自己创建的 session/资源；借入 driver 的生命周期仍归调用方。
- login 失败清理本次自建资源，不把失败会话交给调用方收尾。
- close 不删除 profile、不撤销已经下发的 Cookie，也不是服务端登出。NodeSession 里的凭据仍需调用方保密。
- 已有 Cookie 可按 NodeSession 结构传给 collect，不额外公开构造工厂；调用方提供 close 方法，管理其凭据引用。SDK 验证必要字段，凭据有效性在请求时判断。自建 Node session 不在 SDK WeakMap 中，关闭状态由调用方负责；close 应清空 cookieHeader 或主动阻止再次 collect。SDK 返回的 session 则由内部关闭标记阻止复用。整个 session（含方法/浏览器连接）不能靠 JSON 序列化恢复。

### 4.4 等待、输入、事件

**保持当前不同通道的等待默认值，不统一为 3 分钟：**

- Node QR：maxWaitMs 默认 180000（3 分钟）。
- browser QR 等待循环：maxWaitMs 默认 600000（10 分钟）。
- browser SMS：现有提交后登录态检测窗口为 60000（1 分钟），不是 QR 等待默认值；本轮不悄悄改成另一个值。

maxWaitMs 是整体扫码等待上限，**不是单张二维码有效期**。当前 Node deadline 从二维码回调结束后开始，browser 从等待循环开始，尚不覆盖所有页面准备/回调耗时；本轮保留计时起点，不声称全操作统一超时。调用方可用 signal 限制包括准备和回调在内的整次操作。

- input 只取得手机号/验证码、消费刷新请求、订阅退订和人工操作，不携带文件路径、TTY 或清理文案。requestManualAction 的 reason 为 `login-frame-unavailable`；返回后必须重新检测登录态，超时仍失败，回调确认不是登录证明。
- requestPhone/requestCode 在 browser+sms 且尚未登录时依次调用；缺必须回调报 INPUT_REQUIRED。不自动读短信，不重复发送验证码。
- takeRefreshRequest 非阻塞取走当前请求；多通道同轮合并。subscribeRefresh 同步返回退订函数，注册后成功/失败/取消均恰好退订一次。
- 当前 browser QR 只响应人工刷新，过期不自动重取，受次数和间隔限制。**Node 刷新当前未接线，列为后续能力，不将统一入口等同于新增 Node 刷新实现**；传入 Node 不支持的刷新参数要明确拒绝，不静默忽略。
- onQr 保留回调形式，不改成返回值或拆两步；payload 严格只有 `{ dataUrl: string }`。不携带 file/url/ticket，也不携带 issuedAt/expiresAt/sequence。首次和人工刷新读到二维码时均调用同一回调，调用方用本次 dataUrl 更新图片即可，无需额外序号字段。
- node 必须传 login.onQr，缺失在联网前报 INVALID_ARGUMENT；browser 可以省略，在可见窗口扫码。onQr/onProgress 返回 Promise 时统一 await；异常包装为 CALLBACK_FAILED，并释放 SDK 自己拥有的资源。
- progress 使用上述固定 stage/status，不解析中文消息。Node 可观测 scanned/confirmed；browser 只发实际检测得到的 confirmed，不凭空推测 scanned。qr-issued 提供协议估计 ttlMs，onQr 仍只有 dataUrl，且先 await onQr 再发 qr-issued。server 据 progress 设置展示倒计时。
- log/progress 不含 Cookie、ticket、手机号、验证码、完整页面快照或原始响应。二维码本身是凭据，只交 onQr。
- signal 用于取消网络、响应体读取、轮询、driver 等待和输入回调，报 ABORTED。取消后不再启动后续动作；已发送的浏览器操作、短信及不配合的外部回调副作用不能撤销。借入 driver 不关闭；自建 Playwright 迟到的创建结果会清理。自建 CDP 启动取消会等待自启进程退出；target 创建结果迟到时仍尝试关闭。远端连接中断时无法保证删除 target，不宣称取消能撤销所有副作用。
- 每请求超时与全流程取消属于代码对齐的待落实项，不能仅包装错误就声称永不挂起；本轮不新增统一的等待期限。

## 5. browser 参数与内部测试

不存在公开 openDriver。DriverOptions 只是 browser.driver 的参数形态：

```ts
type DriverOptions =
  | { kind: 'playwright'; chromium?: object; playwrightModule?: string;
      profile?: string; headless?: boolean; args?: string[] }
  | { kind: 'cdp'; cdpUrl: string }
  | { kind: 'cdp'; executablePath: string; port: number;
      profile: string; args?: string[] };
```

- Playwright 可正常模块解析，也可显式 chromium/模块注入，不搜索宿主路径，不自动装包或下载浏览器。使用者只在选 Playwright 通道适配时准备其浏览器能力，与 qrcode 自动随 SDK 安装无关。
- 显式 Playwright/CDP 启动失败应报错，不静默改选驱动或接入别人会话。
- CDP 目标行为是按完整 http/https URL 连接、新建专用 target、不导航用户已有标签页；close 断开外部连接、只结束 SDK 自己创建的 target/进程。
- 启动模式的 port/profile 明确给出；占用时报错，不静默复用。profile 不删除。
- BrowserDriver 注入契约为 kind/version，以及 open(url)、evaluate(expression)、waitFor(expression, timeoutMs)、loginFrame()、evaluateInFrame(frame, expression)、close()。它是注入类型，不是根入口导出；需在代码对齐时补类型和最小 fake 示例。
- 自定义 driver 的实际清理由其实现负责；SDK 只能按拥有/借用规则调用。

CDP host/port/协议、专用 target 与自启进程所有权已实现。仍未兑现的是所有驱动启动行为均严格抛错（Playwright 的 channel:chrome 仍有内部回退）；CDP HTTP 路径前缀与 URL 内凭据不作为连接能力承诺。

createNodeTransport/collectFiles 和 fake transport 契约全部内部化。纯采集测试在仓库内直接 import 内部模块，使用三个 endpoint 的假响应执行真实采集算法；测试不读 skill/server、不为了测试开放子路径。独立 tarball 使用者验证通过五个公共 API，不依赖包内部文件布局。

## 6. 返回值与数据完整性

collectData/collect 统一返回：

```ts
type ApiResponse = { retcode: 0; message?: string; data: Record<string, unknown> };
type ChannelSummary = Record<string, {
  label: string; pulls: number; sCount: number; golds: number;
}>;
type CollectionResult = {
  gameUid: string;
  nickname: string | null;
  region: Region;
  files: Map<string, ApiResponse>;
  summary: ChannelSummary;
  meta: {
    schema: 'zzz-stats/v1'; server: 'cn' | 'os'; uid: string;
    region: Region; nickname: string | null; fetched_at: string;
    versions: string | null; source: string; channels: ChannelSummary;
    total_gacha_count: number; total_s_count: number;
    total_counts_exclude_bangboo: true;
  };
};
```

公开 session/result 用 gameUid；meta.uid 为兼容现有数据集 schema 保留，仍指游戏 UID，不是米游社账号 ID。

### 6.1 files 键与顺序

files 不含 meta.json，不带路径前缀，value 是 JSON 对象。顺序保证：index.json 在前，再按 channels 给定顺序，每频道先 cur_pool_stat_<id>.json，后 hist_pool_stat_<id>.json。默认采集顺序是 2、102、3、103、1、5；这只约束 SDK 返回 Map，不约束报表布局。消费者按自身展示配置重排是正常行为，SDK 不读取报表颜色、保底或显示顺序。

键数 **1 + 2 × 频道数**，默认六频道 **13**，加单独 meta 才是 **14**。

| id | enum | label |
|---|---|---|
| `2` | `GACHA_TYPE_CHARACTER_UP` | 独家频段 |
| `102` | `GACHA_TYPE_CHARACTER_RETURN` | 独家重映 |
| `3` | `GACHA_TYPE_WEAPON_UP` | 音擎频段 |
| `103` | `GACHA_TYPE_WEAPON_RETURN` | 音擎回响 |
| `1` | `GACHA_TYPE_PERMANENT` | 常驻频段 |
| `5` | `GACHA_TYPE_BANGBOO` | 邦布频段 |

index/成功 cur 保留响应字段；hist 按本频道版本降序、每次最多 10 版本分片合并，按 gacha_type|version|start_ts|end_ts 去重，保留首次出现顺序。无历史版本生成空 hist，不承诺重排每金记录。

### 6.2 meta 与 Map

meta 是 SDK 汇总的账号/采集描述，files 是官方响应或合并结果，始终分开。历史上 CLI 落盘会补 meta，但 server 内存直通曾漏补，导致昵称/UID 丢失；这条必须是文档契约，不能让人看源码猜。

外壳需要完整数据集时：

```js
const dataset = new Map([['meta.json', result.meta], ...result.files]);
const jsonObject = Object.fromEntries(dataset);
```

JSON.stringify(Map) 得到 {}，不能直接序列化 Map。返回后数据归调用方，SDK 不继续修改。默认总数来自官方 index，不因 channels 子集改写其“不含邦布”口径。

### 6.3 cur 容错：本轮保留，严格化待验证

**本轮不移除 cur 的宽泛 catch，不要求非零 retcode 一律抛出完整采集。** 当前行为：cur 请求抛错时记录提示，生成 retcode=0、data.list=[] 继续；index/hist 的失败仍抛错。

fixtures 的 103（音擎回响）样本是 **retcode=0 且 list=[]**，证明的是成功空响应，不证明“无数据必然报错”。现有注释“接口会报错”没有这份 fixture 的证据，不能据此拍板容错或严格化。

待另行验证：真实无数据时有哪些响应、是否存在明确业务码；网络/HTTP/凭据失败被 cur 吞掉会否隐藏数据缺失，以及应该如何区分。拿到证据并确认策略后再改变行为。

因此本版 CollectionResult **不承诺所有 cur 请求都成功，也不把返回 13 键当作采集完整性的证明**。这是保留的已知风险，不新增 warnings/strict 开关来扩大本轮接口。

## 7. 错误契约

对实际向外抛出的 SDK 失败统一 SdkError；§6.3 已吞掉的 cur 错误仍不会自动变成对外异常。本轮不能宣称所有网络/鉴权失败必然抛出。

```ts
class SdkError extends Error {
  code: ErrorCode;
  stage: 'validate' | 'login' | 'collect' | 'driver' | 'qr' | 'callback';
  retcode?: number;
  httpStatus?: number;
  endpoint?: string; // 路径名，不含凭据查询
  cause?: unknown;   // 本地诊断，可能含敏感信息，不可自动转发
}
```

| code | 含义 |
|---|---|
| INVALID_ARGUMENT | 参数错误，含 node+sms，I/O 前拒绝 |
| UNSUPPORTED_REGION | 该执行通道尚未实现指定区服 |
| INPUT_REQUIRED | 短信或人工操作缺输入回调 |
| AUTH_EXPIRED | 明确未登录证据，如 retcode=-100 |
| ROLE_NOT_FOUND | 已登录但无指定区服游戏角色 |
| NETWORK_ERROR / HTTP_ERROR | 连接失败 / 非 2xx |
| UPSTREAM_ERROR | 无法精确分类的上游业务码，不猜成凭据失效 |
| INVALID_RESPONSE | 非 JSON、缺必要字段、未知登录状态 |
| LOGIN_TIMEOUT / REQUEST_TIMEOUT | 登录等待 / 单操作超时 |
| BROWSER_UNAVAILABLE / BROWSER_PAGE_CHANGED | 浏览器不可用 / 官方页面结构不符 |
| ABORTED | 调用方取消 |
| CALLBACK_FAILED | 外部回调失败，cause 留原错 |
| QR_ENCODING_FAILED | 编码失败；空文本等参数错误归 INVALID_ARGUMENT |

code 是机器契约，message 不是。缺 Cookie 的 Confirmed 响应属 INVALID_RESPONSE，不伪装成 AUTH_EXPIRED；二维码过期可发 progress.status=expired，不把未知业务错误猜成过期。

公共 message/log/progress 脱敏，cause 不自动进入 SSE/JSON/用户消息；第三方回调原始错误可能包含秘密，包装时只在 cause 保留，不直接拼进公开文字。

## 8. 公共接口示例（真实登录需调用方提供交互）

完整国服扫码采集：

```js
import { collectData, SdkError } from '@atian25/zzz-stats-sdk';
try {
  const result = await collectData({
    channel: 'node',
    login: { method: 'qr', onQr: async ({ dataUrl }) => displayQr(dataUrl) },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  await saveDataset(Object.fromEntries([['meta.json', result.meta], ...result.files]));
} catch (error) {
  if (!(error instanceof SdkError)) throw error;
  handleError(error.code);
}
// displayQr/saveDataset/handleError 均由调用方提供。
```

分步 browser 登录和取数：

```js
import { login, collect } from '@atian25/zzz-stats-sdk';
import { chromium } from 'playwright-core'; // 只有选择此浏览器适配时才由调用方准备

const session = await login({
  channel: 'browser',
  browser: { driver: { kind: 'playwright', chromium, headless: false } },
  login: { method: 'qr' }, // 也可 method:'sms' 并提供 input 回调
});
try {
  const result = await collect({ session });
  useResult(result);
} finally {
  await session.close();
}
```

已有 Node Cookie，不重新扫码：

```js
import { collect } from '@atian25/zzz-stats-sdk';
const session = {
  channel: 'node', accountId: null, gameUid: '10000001',
  nickname: null, region: 'prod_gf_cn', cookieHeader: secretCookie,
  async close() { this.cookieHeader = ''; },
};
try {
  const result = await collect({ session });
  useResult(result);
} finally {
  await session.close();
}
// 自建 session 由调用方负责失效/关闭状态；无额外导出工厂。
```

二维码接口，**不单独安装 qrcode**：

```js
import { encodeQrDataUrl } from '@atian25/zzz-stats-sdk';
const dataUrl = await encodeQrDataUrl('login-content');
// 可直接赋给图片 src；无 dataUrlToBuffer 公共接口。
```

二维码为 PNG、M 纠错、四模块静区，尺寸随内容变化，不保证固定像素。内部转换的校验测试不改变公共面。

## 9. 上游协议与能力边界

保留原文档采集协议结论：国服来源为 2026-11-19 的真实请求；本设计轮不做扫码/登录/国际服实测。

- [国服活动页](https://act.mihoyo.com/zzz/event/gacha-record/index.html)、[国际服活动页](https://act.hoyolab.com/zzz/event/gacha-record/index.html) 为客户端渲染页面。
- [国服取数基址](https://act-api-takumi.mihoyo.com/event/nap_gacha_record/api/zzz)、[国际服取数基址](https://sg-act-public-api.hoyolab.com/event/nap_gacha_record/api/zzz)。Cookie 鉴权，query 带游戏 uid/region，无 authkey/page/end_id。
- /index 的 type_stats 含 gacha_type/total_count/s_count/has_data_vers/next_s_cur_times；多数字段为数字字符串。
- /cur_pool_stat 的 data.list 为卡池，一个版本可能多个池。
- /hist_pool_stat 按本频道 has_data_vers，每请求至多 10 个版本；-400005 为参数错误。
- cur_records 是每金一条，含物品、时间、抽数、is_up；count 为距上一金抽数，record_time 是 Unix 秒，sort 为频道内跨池序号。
- new_s_max_times 是 UI 展示区间，不是硬保底；next_s_cur_times 是当前垫抽。
- index 总抽数/总 S 不含邦布，不等于六频道简单相加。
- 不提供 4 星/逐抽明细/记录 ID；与游戏内 getGachaLog/authkey 是不同数据源。
- 私有接口/DOM 可随上游改版失效；存在国际服域名不代表已经实测通过。

## 10. 版本、评审与后续验收

SDK 已公开发布到 npm，当前版本为 0.1.2（以 package.json 为准）。五个根导出、单一 package export、channel/login.method、session.close 与独立 meta/gameUid 已落地；不再把这些已完成的契约列为下一版计划。

每次公开发布前必须验证独立 tarball、五个根 API、子路径拒绝、qrcode 随包正常安装、类型/示例、登录与纯采集、错误/取消/所有权、许可证。Playwright 为可选环境能力，不自动下载浏览器。0.x 不兼容变更升 minor，兼容修复升 patch；1.0 后公共契约破坏升 major。

自评保留风险：

- 简化导出不等于消除 driver 的注入复杂度，需补最小适配示例和类型；不因此重新公开工厂或子路径。
- session.close 的拥有/借用语义必须实测，关闭进程不等于删 profile 或退出服务端登录。
- 自建 Cookie session 的有效性和关闭标记由调用方负责，SDK 不能用类型证明 Cookie 有效。
- 两个通道等待时长不同是保留行为，不能在实现时用统一默认值误缩 browser 等待。
- cur 容错仍可能隐藏缺失，先记录与验证，不把“严格采集”列成本轮已批准修改。
- Node 刷新有意不支持；CDP host/协议、专用 target 与自启进程关闭已实现；取消不能撤销已发操作，远端 target 在断连时无法保证清理，不因一个 login 入口就假定所有资源均可撤销。

回归与后续验收应持续覆盖（自动化通过不代表真实扫码、短信和国际服均已验收）：

1. 根导出精确五个名字，exports 一条，全部子路径拒绝；纯 SDK 测试不依赖 skill/server。
2. login 的 node+qr/browser+qr/browser+sms 路径；node+sms 联网前 INVALID_ARGUMENT；命名不混方式与通道。
3. collect 只用已有 session，collectData 组合两动作，失败不换路；close 幂等、成功/失败/取消所有权正确。
4. gameUid 与账号 ID 不混，13 响应键与独立 meta、插入顺序和 Map 序列化统一。
5. 分片边界与去重、无历史、cur 成功空列表；**保留现有 cur 容错回归，严格化另行验证。**
6. Node QR 3 分钟/browser QR 10 分钟默认值及计时起点不误改；短信检测窗口单独记录。
7. QR/SMS 回调真执行，async 回调 await，browser 刷新合并/限流/退订与结构化错误。
8. tarball 内二维码可编码解码，使用者无单独 qrcode 安装步骤；内部工具测试直接 import 内部模块，不加出口。

本轮只做设计文档修订，不把目标签名、历史测试或原有扫码实测当作新接口已实现。
