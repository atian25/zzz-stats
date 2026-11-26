# @atian25/zzz-stats-sdk

《绝区零》调频记录的采集 SDK：登录、六个频道的取数、二维码编码。Node.js ≥22，纯 ESM，不依赖本仓库的其他部分。

```bash
npm install @atian25/zzz-stats-sdk
```

`qrcode` 是生产依赖，随包自动安装；使用时不需要单独装，也不需要 import 它。

## 五个导出

```js
import {
  collectData, login, collect, encodeQrDataUrl, SdkError,
} from '@atian25/zzz-stats-sdk';
```

| 名字 | 作用 |
|---|---|
| `collectData(options)` | 登录并取数，返回完整结果 |
| `login(options)` | 只登录，返回 session |
| `collect(options)` | 用已有 session 取数，不重新登录 |
| `encodeQrDataUrl(text)` | 把文本编成 PNG data URL |
| `SdkError` | 带 `code` 的结构化错误 |

包的 exports 只有根入口一条，没有子路径。

## 完整流程

纯 Node 通道没有窗口展示二维码，所以必须传 `onQr`，在那里把二维码给用户看。

```js
import { collectData } from '@atian25/zzz-stats-sdk';

const result = await collectData({
  channel: 'node',
  login: {
    onQr: async ({ dataUrl }) => {
      // dataUrl 就是二维码本身，也是凭据，只交给用户，不要写进日志
      await showQrToUser(dataUrl);
    },
  },
  onProgress: (event) => {
    console.log(event.stage, event.status); // 只按 stage/status 判断，不解析 message
  },
});

console.log(result.nickname, result.gameUid);
```

`onQr` 在 `login` 里，不在顶层；`onProgress`、`signal`、`log` 则在顶层。

浏览器通道可以让用户直接在可见窗口里扫码，`onQr` 可以省略：

```js
const result = await collectData({
  channel: 'browser',
  browser: { driver: { kind: 'playwright', headless: false } },
});
```

## 登录与取数分开

要在同一个会话上反复取数时，用 `login` 加 `collect`。`collect` 不关闭借入的 session，由调用方在 `finally` 里关。

```js
import { login, collect } from '@atian25/zzz-stats-sdk';

const session = await login({
  channel: 'node',
  login: { onQr: async ({ dataUrl }) => showQrToUser(dataUrl) },
});
try {
  const first = await collect({ session });
  const second = await collect({ session });
} finally {
  await session.close();
}
```

`collectData` 则会清理它自己创建的 session，成功失败都一样。

## 返回什么

```js
{
  gameUid,   // 游戏 UID，不是米游社账号 ID
  nickname,
  region,    // 默认 prod_gf_cn
  files,     // Map<string, ApiResponse>，13 个键
  summary,   // 各频道的抽数、金数汇总
  meta,      // 数据集 schema、抓取时间、总数等
}
```

`files` 不含 `meta.json`，也不带路径前缀，值就是接口返回的 JSON 对象。键数固定是 `1 + 2 × 频道数`，默认六个频道即 13：`index.json` 在最前，然后按频道顺序先 `cur_pool_stat_<id>.json`、后 `hist_pool_stat_<id>.json`。

SDK 不写盘。要落成文件、渲染报表，都由调用方决定文件名和目录。

## 两个维度

通道和登录方式是两回事，用参数选，不是两套函数名：

```js
{ channel: 'node' | 'browser', login: { method: 'qr' | 'sms' } }
```

| 通道 | 二维码 | 短信 |
|---|---|---|
| `node` | 支持（国服） | 不支持，联网前就报 `INVALID_ARGUMENT` |
| `browser` | 支持 | 支持（国服 +86） |

`node` 当前只支持国服 `prod_gf_cn`，其他区服报 `UNSUPPORTED_REGION`。

注意 `channel` 是执行通道，和 `region`（游戏区服）、`channels`（要采集的频段列表）不是一回事。

## 取消与超时

传 `signal` 可以取消整次操作。取消会中断网络请求、轮询和输入回调，但已经发出去的浏览器操作和短信无法撤回。

```js
const ac = new AbortController();
setTimeout(() => ac.abort(), 5 * 60_000);

await collectData({ channel: 'node', login: { onQr }, signal: ac.signal });
```

扫码等待的默认值按通道不同，是有意保留的，没有统一：Node 二维码 180 秒，浏览器二维码 600 秒，浏览器短信登录态检测 60 秒。`maxWaitMs` 是整体等待上限，不是单张二维码的有效期。

## 错误

所有已知失败都会收口成 `SdkError`，带 `code` 和 `cause`：

```js
import { collectData, SdkError } from '@atian25/zzz-stats-sdk';

try {
  await collectData({ channel: 'node', login: { onQr } });
} catch (error) {
  if (error instanceof SdkError) {
    console.error(error.code); // INVALID_ARGUMENT / ABORTED / UNSUPPORTED_REGION ...
  }
  throw error;
}
```

参数错误在联网前就抛，不会先发请求再报错。

## 它不做什么

- 不保存采集结果、二维码或凭据中转文件，不监听 stdin，不读 argv，不退出进程
- 不读报表配置、模板、宿主 profile 或本仓库的其他文件
- 不在登录失败时自动换通道；`channel` 是显式选择
- 不会猜到某个浏览器进程是用户的，CDP 只操作自己创建的 target 和进程

## 完整契约

类型草图、每个参数的含义、13 个响应键、所有错误分类和已知限制，都在 [docs/api.md](docs/api.md)。

实现取舍与逐轮审计记录见 [docs/history.md](docs/history.md) 和 [docs/implementation-notes.md](docs/implementation-notes.md)。
