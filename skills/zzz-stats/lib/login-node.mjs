/**
 * 纯 Node 扫码登录 —— 全程不开浏览器。
 *
 * ## 这是私有接口，不是公开 API
 *
 * 本文件里的每个常量（app_id / client_type / game_biz / sdk_version / 请求头）
 * 都是从官方 passport 页面的实际请求里抄下来的**逆向结论**，不是你写的那种带文档、
 * 带版本号的接口。风险很具体：
 *
 *   - 官方改一版前端，`x-rpc-app_id` 就可能换值 → 症状是**一直返回 -3005「参数不合法」**，
 *     而不是报「接口不存在」。看着像 cookie 坏了，实际是一个头不对。改前先核对这一条。
 *   - `game_biz`（`nap_cn`）对应《绝区零》国服；国际服是另一套域名与 biz，本文件**只做国服**。
 *   - cookie 名（`cookie_token_v2` / `ltoken_v2` / …）是米游社那套 SSO 的名字，改名就登不上。
 *   - 接口随时可能加签名。**出问题优先怀疑这三件事，再怀疑网络。**
 *
 * 因为它会静默失败（不抛「接口变了」，只抛业务错误码），所以下面每个失败分支都
 * 把「可能是什么变了」写进错误消息里，而不是只说「登录失败」。
 *
 * ## 实测跑通过的完整流程（每个值都实跑验证过，别自己另找）
 *
 *   1) createQRLogin                    → data.url（二维码内容）+ data.ticket
 *   2) 轮询 queryQRLoginStatus          → Created → Scanned → Confirmed
 *   3) **在 Confirmed 那一次响应的 set-cookie 里**取 token
 *   4) getUserGameRolesByCookie         → game_uid（★ 不是 user_info.aid）
 *   5) 用 Cookie 去调 act-api 取数
 *
 * ## 三个必须知道的坑（都真实踩过）
 *
 * **① token 不在 `data.tokens` 里。** 那个字段永远是空数组。真正的 token 在
 * `Set-Cookie` 响应头里。而且要拼成 Cookie 请求头，还得自己从 `name=value; Path=/...`
 * 这种格式里把 name=value 摘出来。
 *
 * **② token 只在「第一次拿到 Confirmed」的那次响应里返回。** 再查一次就没了
 * （官方一次性下发）。所以必须在拿到 Confirmed 的**同一个响应**里立刻抓 set-cookie，
 * 不能「先返回再补查」——那条路实测拿到空集合，然后所有后续请求都是未登录。
 *
 * **③ 游戏 UID ≠ 米游社账号 ID。** `queryQRLoginStatus` 的 `user_info.aid` 是米游社
 * 账号 ID；游戏接口要的是 `getUserGameRolesByCookie` 里 `region=prod_gf_cn` 那条的
 * `game_uid`。**拿 aid 去打游戏接口会一直返回 -100「请先登录」**，非常像 cookie 坏了，
 * 实际只是 UID 用错了——这个坑排查成本极高。
 */

import { randomUUID } from 'node:crypto';
import { encodeQrDataUrl } from './qr.mjs';
import { collectFiles, buildMeta } from './collect.mjs';
import { createNodeTransport, ACT_API } from './transport-node.mjs';

/** passport 域（登录），与 act 域（取数）不是同一个。 */
const PASSPORT = 'https://passport-api.mihoyo.com/account/ma-cn-passport/web';
/** 取游戏角色的接口（需要 cookie，用来换 game_uid）。 */
const BINDING = 'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie';

/*
 * 逆向得来的请求头。**改任何一个之前先读文件头**：这些值错了不会报「参数错误」，
 * 而是回一个 -3005 之类看着像参数/登录态问题的业务码。
 *
 * - `x-rpc-app_id: cieb8o6xs1kw` —— 米游社 App 的 app_id。用 `unknown` 会一直 -3005。
 * - `x-rpc-client_type: 4` —— 4 = 移动端 App。其他值会走到不同的登录策略。
 * - `x-rpc-game_biz: nap_cn` —— 《绝区零》国服（nap = 绝区零，cn = 国服）。
 * - `x-rpc-sdk_version: 2.57.0` —— 抄自官方页面当时加载的 SDK 版本。
 * - `Origin` / `Referer` 指向 user.mihoyo.com：passport 对来源做了校验。
 */
const PASSPORT_HEADERS = {
  'x-rpc-app_id': 'cieb8o6xs1kw',
  'x-rpc-client_type': '4',
  'x-rpc-game_biz': 'nap_cn',
  'x-rpc-sdk_version': '2.57.0',
  'Content-Type': 'application/json',
  Origin: 'https://user.mihoyo.com',
  Referer: 'https://user.mihoyo.com/',
};

/*
 * 设备 id：一个固定 UUID，**整个进程内复用**。
 *
 * 每次请求换一个的话，官方会当成「同一张二维码被不同设备在轮询」，
 * 实测会拒绝确认。所以它是模块级常量，不是每次调用生成。
 */
const DEVICE_ID = randomUUID();

/**
 * 服务端下发的 cookie 名。拼 Cookie 头时按这个顺序取。
 *
 * `aliyungf_tc` **必须排除**：那是阿里云 CDN 的会话 cookie，与登录无关，
 * 带上反而会让 passport 认为来源不对。
 */
const AUTH_COOKIE_NAMES = [
  'cookie_token_v2', 'ltoken_v2', 'account_id_v2', 'account_mid_v2',
  'ltuid_v2', 'ltmid_v2', 'account_id', 'ltuid', 'uni_web_token',
];
const IGNORED_COOKIE_NAMES = new Set(['aliyungf_tc']);

/**
 * 从 `Set-Cookie` 头数组里拼出 Cookie 请求头。
 *
 * 每个 Set-Cookie 形如 `ltoken_v2=xxx; Path=/; Domain=...; Max-Age=...`，
 * 只要第一段 `name=value`。**不能**把整串塞进 Cookie 头（`Path=` 那些属性会被服务端
 * 当成 cookie 名解析，结果就是「带了 cookie 却不认」）。
 *
 * @param {string[]} setCookies
 * @returns {string} 形如 `a=1; b=2`
 */
export function cookiesFromSetCookie(setCookies) {
  const found = new Map();
  for (const raw of setCookies ?? []) {
    if (typeof raw !== 'string') continue;
    const first = raw.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name || IGNORED_COOKIE_NAMES.has(name)) continue;
    found.set(name, value);
  }
  /*
   * 只取认识的几个，且保持 AUTH_COOKIE_NAMES 的顺序 —— 顺序稳定，
   * 出了问题（比如某个新名字没被收进来）可以用例断言，而不是靠肉眼比对一长串。
   */
  const parts = [];
  for (const name of AUTH_COOKIE_NAMES) {
    if (found.has(name)) parts.push(`${name}=${found.get(name)}`);
  }
  return parts.join('; ');
}

/** fetch 的 Response → set-cookie 数组。Node 18+ 用 getSetCookie()。 */
function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/**
 * 扫码登录，返回可用于后续请求的 Cookie 头。
 *
 * @param {object} args
 * @param {(qr: {dataUrl: string, url: string, ticket: string}) => void|Promise<void>} args.onQr
 *        拿到二维码时回调。调用方负责**落盘/展示**（SDK 自己不写盘）。
 * @param {(msg: string) => void} [args.log]          进度日志
 * @param {(ms: number) => Promise<void>} [args.sleep] 便于用例注入假时钟
 * @param {number} [args.pollMs]                      轮询间隔，默认 2000ms
 * @param {number} [args.maxWaitMs]                   整体超时，默认 3 分钟
 * @returns {Promise<{cookie: string, deviceId: string}>}
 */
export async function loginWithQr({
  onQr,
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 2000,
  maxWaitMs = 3 * 60 * 1000,
  now = () => Date.now(),
  fetchImpl = fetch,
  encodeQr = encodeQrDataUrl,
} = {}) {
  /*
   * 1) 申请一张二维码。
   *
   * body 必须是 `{}`（不是空 body）：passport 对空的 POST 会回参数错误。
   */
  const createRes = await fetchImpl(`${PASSPORT}/createQRLogin`, {
    method: 'POST',
    headers: { ...PASSPORT_HEADERS, 'x-rpc-device_id': DEVICE_ID },
    body: '{}',
  });
  const created = await createRes.json().catch(() => null);
  if (!created || created.retcode !== 0 || !created.data?.url) {
    throw new Error(
      `申请二维码失败：retcode=${created?.retcode} ${created?.message ?? ''}\n` +
      '→ 优先怀疑 x-rpc-app_id 变了（用 unknown 或旧值会一直 -3005「参数不合法」），' +
      '其次检查 x-rpc-game_biz / x-rpc-client_type。见本文件文件头的常量说明。',
    );
  }
  const ticket = created.data.ticket;
  const qrDataUrl = await encodeQr(created.data.url);
  log('已生成二维码');
  /*
   * 交给调用方。**回调可以 await**：调用方可能要落盘、要起图片服务、要等它写成功
   * 再打印地址。SDK 自己不碰磁盘。
   */
  await onQr?.({ dataUrl: qrDataUrl, url: created.data.url, ticket });

  /*
   * 2) 轮询登录态，直到 Confirmed。
   *
   * 三次状态：Created（还没扫）→ Scanned（扫了没确认）→ Confirmed（确认了）。
   * 超时统一按「等待登录超时」处理，不区分「没扫」和「扫了没确认」——
   * 对调用方来说下一步都是「重来一次」。
   */
  const deadline = now() + maxWaitMs;
  let lastStatus = null;
  while (now() < deadline) {
    const res = await fetchImpl(`${PASSPORT}/queryQRLoginStatus`, {
      method: 'POST',
      headers: { ...PASSPORT_HEADERS, 'x-rpc-device_id': DEVICE_ID },
      body: JSON.stringify({ ticket }),
    });

    /*
     * ★★ 坑②：token 只在「第一次 Confirmed」的这次响应里。
     * 所以 set-cookie 必须在这个分支里当场摘走，不能等下一轮、也不能靠再查一次补。
     */
    const setCookies = getSetCookies(res);
    const body = await res.json().catch(() => null);
    if (!body || body.retcode !== 0) {
      throw new Error(
        `查询登录态失败：retcode=${body?.retcode} ${body?.message ?? ''}\n` +
        '→ 二维码可能已失效，重跑一次即可。若持续失败，见文件头关于 app_id 的说明。',
      );
    }

    const status = body.data?.status;
    if (status !== lastStatus) {
      if (status === 'Scanned') log('已扫码，等待确认…');
      if (status === 'Confirmed') log('已确认登录');
      lastStatus = status;
    }

    if (status === 'Confirmed') {
      const cookie = cookiesFromSetCookie(setCookies);
      if (!cookie) {
        /*
         * 拿到 Confirmed 却没有 cookie，说明「一次性下发」这条前提变了
         * （或者 set-cookie 被中间层吃掉）。这里必须报错而不是空着往下走 ——
         * 空 cookie 的后续表现是游戏接口 -100「请先登录」，与「cookie 坏了」无法区分。
         */
        throw new Error(
          '登录已确认，但响应里没有取到任何登录 cookie。\n' +
          `→ 收到了 ${setCookies.length} 个 set-cookie（${setCookies.map((c) => String(c).split('=')[0]).join(', ') || '无'}）。\n` +
          '   可能原因：cookie 名变了（见文件头 AUTH_COOKIE_NAMES），或 token 不再随 Confirmed 一次性下发。',
        );
      }
      /*
       * 顺带把米游社账号 ID（`user_info.aid`）也带出去。
       *
       * **它不是游戏 UID**（坑③），两个值不能混用；但调用方有时需要它
       * （日志、对账）。拿不到就给 null —— 不为一个顺带字段报错。
       */
      const accountId = body.data?.user_info?.aid ? String(body.data.user_info.aid) : null;
      return { cookie, deviceId: DEVICE_ID, accountId };
    }

    await sleep(pollMs);
  }
  throw new Error(`等待扫码超时（${Math.round(maxWaitMs / 1000)} 秒，最后状态 ${lastStatus ?? '未知'}）。重跑一次可生成新二维码。`);
}

/**
 * 用 cookie 换游戏 UID。
 *
 * ★ 坑③：这里要的是 **game_uid**，不是 `user_info.aid`。
 * aid 是米游社账号 ID，拿它去打游戏接口会一直 -100「请先登录」。
 *
 * @param {object} args
 * @param {string} args.cookie  `loginWithQr()` 返回的 Cookie 头
 * @param {string} [args.region] 期望的区服，默认国服 prod_gf_cn
 * @returns {Promise<{uid: string, nickname: string|null, region: string, regionName?: string}>}
 */
export async function resolveGameUid({ cookie, region = 'prod_gf_cn', fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${BINDING}?game_biz=nap_cn`, {
    headers: {
      Cookie: cookie,
      // 这两个头是 act/binding 域要求的来源校验，抄自官方页面
      Origin: 'https://act.mihoyo.com',
      Referer: 'https://act.mihoyo.com/',
    },
  });
  const body = await res.json().catch(() => null);
  if (!body || body.retcode !== 0) {
    throw new Error(
      `查游戏角色失败：retcode=${body?.retcode} ${body?.message ?? ''}\n` +
      '→ retcode=-100「请先登录」时先确认 cookie 拼对了（要 name=value，不带 Path 等属性）；' +
      '若 cookie 正确，见文件头关于 header / app_id 的说明。',
    );
  }
  const list = body.data?.list ?? [];
  const hit = list.find((x) => x.region === region) ?? null;
  if (!hit?.game_uid) {
    const got = list.map((x) => x.region).join(', ') || '（空）';
    throw new Error(
      `这台账号下没有 ${region} 的角色。返回的区服：${got}\n` +
      '→ 国际服账号请用 --region 指定，并配合 --transport browser（纯 Node 这条路只做国服）。',
    );
  }
  return {
    uid: String(hit.game_uid),
    nickname: hit.nickname ?? null,
    region: hit.region,
    regionName: hit.region_name,
  };
}

/**
 * 纯 Node 扫码登录：一张二维码 → 一套 Cookie + 游戏 UID。**只做国服。**
 *
 * 这是 SDK 对外的**并列入口之一**（另一条是浏览器的 `loginByQrBrowser`）。
 * 它只管把这件事做成或抛错：**不判断该不该换一条路、不重试、不降级**。
 * 换路的策略在 CLI（`scripts/collect.mjs`）里 —— 服务那边将来可能完全不同
 * （只用浏览器、或纯粹失败即报错），策略不该被 SDK 写死。
 *
 * @param {object} args
 * @param {(qr: {dataUrl: string, url: string, ticket: string}) => void|Promise<void>} args.onQr
 *        拿到二维码时回调。调用方负责落盘/展示（SDK 不碰磁盘）。
 * @param {string} [args.region] 目前只接受 `prod_gf_cn`，其它直接抛错
 * @returns {Promise<{cookieHeader: string, uid: string, gameUid: string, nickname: string|null, region: string}>}
 *        `cookieHeader` 可直接放进后续请求的 `Cookie` 头；
 *        `uid` 是米游社账号 ID（可能为 null 之外的空串），`gameUid` 才是游戏接口要的那个。
 */
export async function loginByQrNode({
  onQr,
  region = 'prod_gf_cn',
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 2000,
  maxWaitMs = 3 * 60 * 1000,
  now = () => Date.now(),
  fetchImpl = fetch,
  encodeQr = encodeQrDataUrl,
} = {}) {
  /*
   * 国际服直接抛错，**不在这里偷偷换成浏览器**。
   * 这句报错就是调用方决定要不要降级的依据 —— 换不换是 CLI 的事。
   */
  if (!/^prod_gf_cn$/i.test(region)) {
    throw new Error(
      `纯 Node 扫码登录只做国服（prod_gf_cn），收到 ${region}。` +
      '国际服的 passport/biz 是另一套，未实测，请改用浏览器路径。',
    );
  }

  const { cookie, accountId } = await loginWithQr({
    onQr, log, sleep, pollMs, maxWaitMs, now, fetchImpl, encodeQr,
  });
  const role = await resolveGameUid({ cookie, region, fetchImpl });
  log(`UID ${role.uid}（${role.regionName ?? role.region}）`);

  return {
    cookieHeader: cookie,
    uid: accountId ?? '',
    gameUid: role.uid,
    nickname: role.nickname ?? null,
    region: role.region,
  };
}

/**
 * 纯 Node 取数：Cookie + gameUid → 14 个键的 Map。**只做国服。**
 *
 * 与 `loginByQrNode()` 是并列的两个动作，不是它的后续步骤 —— 调用方可以把
 * 「登录」和「取数」分开做（例如复用已有 Cookie 重取一次数据）。
 * 同样**不降级**：接口失败就抛。
 *
 * @param {object} args
 * @param {string} args.cookieHeader `loginByQrNode()` 返回的 Cookie 头
 * @param {string} args.uid          游戏 UID（不是米游社账号 ID）
 * @param {string} [args.region]
 * @param {string|null} [args.nickname] 已有昵称就带上，省得再去别处找
 * @returns {Promise<{files: Map<string, unknown>, summary: object, meta: object}>}
 */
export async function collectViaNode({
  cookieHeader,
  uid,
  region = 'prod_gf_cn',
  api = null,
  nickname = null,
  channels = null,
  cfg = null,
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl = fetch,
  fetchedAt = undefined,
} = {}) {
  if (!/^prod_gf_cn$/i.test(region)) {
    throw new Error(
      `纯 Node 取数只做国服（prod_gf_cn），收到 ${region}。请改用浏览器路径。`,
    );
  }
  if (!cookieHeader) throw new Error('collectViaNode 需要 cookieHeader');
  if (!uid) throw new Error('collectViaNode 需要 uid（游戏 UID）');

  const transport = createNodeTransport({
    uid, cookie: cookieHeader, region, api, nickname, fetchImpl,
  });
  const { files, summary, index } = await collectFiles({ transport, channels: channels ?? cfg?.channels, log, sleep });
  const meta = buildMeta({
    /*
     * `meta.source` 记的是「数据从哪个接口基址来的」。
     * 没显式给 api 时用 transport 实际在打的那个基址（`ACT_API.cn`），
     * 而不是留空 —— 空串在产物里显示成「来源未知」，排障时最没用。
     */
    index, uid: String(uid), nickname, region, api: api ?? ACT_API.cn,
    summary, fetchedAt, isCn: true,
  });

  return { files, summary, meta };
}
