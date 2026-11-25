/**
 * 纯 Node 取数 —— 用 Cookie 直接请求官方 act 接口，不开浏览器。
 *
 * ## 与浏览器那条路的差别
 *
 * 浏览器那条路必须在 `act.mihoyo.com` 页面上下文里 `fetch`，因为接口的 CORS
 * 只放行官方源。纯 Node 没有浏览器的同源限制，**也不需要**伪造 Origin：
 * 实测直接带 Cookie + Referer 就能拿到真数据，不需要签名。
 *
 * 风险同一件事：这是私有接口，字段和域名都可能变。域名变了用 `--api` 覆盖；
 * 鉴权变了（要求签名 / 换 header）则只能退回浏览器那条路。
 *
 * ## 为什么单独成文件
 *
 * `collectData()` 只认一个 `transport` 接口（见 packages/sdk/collect.mjs）。
 * 两种取数方式各是一个 transport 实现，编排逻辑因此只有一份 ——
 * 否则「先 index 再每频道 cur/hist」这套顺序会写成两份，必然漂移。
 */

/**
 * 国服 / 国际服的 act 基址。
 *
 * 与 `scripts/collect.mjs` 里的 ENDPOINTS 同源（那边是浏览器路径用的页面地址）。
 * 纯 Node 这条路**只做国服**：国际服的 passport 与 biz 是另一套，没实测过，
 * 与其猜一个半对的实现，不如明确报错让调用方走浏览器。
 */
export const ACT_API = {
  cn: 'https://act-api-takumi.mihoyo.com/event/nap_gacha_record/api/zzz',
  os: 'https://sg-act-public-api.hoyolab.com/event/nap_gacha_record/api/zzz',
};

/**
 * 建一个「用 Cookie 直接打 act 接口」的 transport。
 *
 * transport 的契约（`collectData` 只依赖这几个）：
 *   - `kind`：'node' | 'browser'，日志里要说清楚走的哪条
 *   - `getUid()` → string        （已经知道 uid 时直接给，否则去问）
 *   - `fetchJson(path, query)` → 已解包的原始响应对象（retcode !== 0 抛错）
 *   - `readNickname()` → string|null
 *   - `close()` → 释放资源（纯 Node 无事可做，留着保持接口一致）
 *
 * @param {object} args
 * @param {string} args.uid
 * @param {string} args.cookie           `loginWithQr()` 给的那个 Cookie 头
 * @param {string} [args.region]         默认 prod_gf_cn
 * @param {string} [args.api]            硬覆盖基址（官方换域名时用）
 * @param {string|null} [args.nickname]  登录阶段已经拿到的昵称（有就不必再读页面）
 * @param {typeof fetch} [args.fetchImpl]
 */
export function createNodeTransport({
  uid, cookie, region = 'prod_gf_cn', api, nickname = null, fetchImpl = fetch,
}) {
  const isCn = /^prod_gf_cn$/i.test(region);
  const base = api ?? (isCn ? ACT_API.cn : ACT_API.os);

  return {
    kind: 'node',
    uid: String(uid),
    nickname,

    getUid() { return String(uid); },

    /**
     * 打一个 act 接口。
     *
     * `query` 里的值按 URLSearchParams 编码，顺序与浏览器路径一致
     * （uid 在前、region 其次、其余按传入顺序）—— 产物里只有响应体，
     * 请求顺序不影响结果，但日志/排障时对着看更省事。
     */
    async fetchJson(path, query = '') {
      const params = new URLSearchParams();
      params.set('uid', String(uid));
      params.set('region', region);
      if (query) {
        for (const [k, v] of new URLSearchParams(query)) params.set(k, v);
      }
      const url = `${base}${path}?${params.toString()}`;
      const res = await fetchImpl(url, {
        headers: {
          Cookie: cookie,
          /*
           * Referer 指向官方活动页。**不要删**：act 接口用它判断来源，
           * 缺了会回 no-login 类错误码（看着像 cookie 失效）。
           */
          Referer: 'https://act.mihoyo.com/zzz/event/gacha-record/index.html',
        },
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch {
        throw new Error(`${path}: 返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
      }
      if (json.retcode !== 0) {
        const err = new Error(`${path}: retcode=${json.retcode} ${json.message ?? ''}`);
        err.retcode = json.retcode;
        throw err;
      }
      return json;
    },

    /*
     * 纯 Node 没有页面可读，昵称只能来自登录阶段（`resolveGameUid()` 的返回值）。
     * 返回 null 时由调用方决定是否退回 UID 当目录名 —— 那是落盘策略，不在这里决定。
     */
    readNickname() { return nickname; },

    async close() { /* 纯 Node 无需清理 */ },
  };
}

/**
 * 当前时间的 ISO 字符串。抽成函数是为了 `meta.generatedAt` 与 `fetched_at` 两处
 * 能用同一个值（用例里可以注入固定值做逐字节比对）。
 */
export function nowIso() {
  return new Date().toISOString();
}
