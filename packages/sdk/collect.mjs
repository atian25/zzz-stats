/**
 * 采集编排 —— 登录 + 取数，**只返回数据，不写盘**。
 *
 * ## 与改前的关系
 *
 * 改前这些逻辑全在 `scripts/collect.mjs`（1027 行）里，和「解析参数 / 建目录 / 写文件 /
 * process.exit / 信号处理 / 二维码图片服务」混在一起。那个脚本同时是「采集算法」
 * 和「命令行外壳」，想从服务里复用就只能复制一份 —— 两份必然漂移。
 *
 * 现在：
 *
 *   packages/sdk/collect.mjs          ← 本文件：登录 → 定 uid/昵称 → 按频道取数 → 返回 Map
 *   packages/sdk/login-node.mjs       纯 Node 扫码登录
 *   packages/sdk/login-browser.mjs    浏览器登录（扫码走页面 iframe，短信也在这里）
 *   packages/sdk/transport-node.mjs   纯 Node 取数
 *   skills/zzz-stats/scripts/collect.mjs  薄壳：参数、日志、图片服务、落盘、退出码
 *
 * ## 为什么返回「文件名 → 内容」的 Map
 *
 * 落盘时文件名必须与 `output/<账号名>/data/` 下的完全一致（14 个键），
 * 构建侧 `buildReport()` 认的也是同一批键。用 Map 而不是对象，是为了保留
 * 插入顺序（index.json 在前、然后按频道顺序），写出来的目录列出来和以前一样。
 *
 * **SDK 不写盘**：账号名要等昵称出来才知道，而落盘位置是「用户工作目录」的概念，
 * 属于外壳。服务里可能根本不想落盘，只想把 Map 存进数据库。
 */

/*
 * 这里**没有**任何 `import.meta.url` / `resolve(__dirname, '..')`。
 *
 * 采集层在 `packages/sdk/`，报表渲染器在 `skills/zzz-stats/lib/build.mjs` ——
 * 两者分属不同目录，采集层**不可能**再靠层级猜出 skill 资源在哪
 * （`resolve(HERE, '..')` 在这里指向 `packages/`）。
 *
 * 好在这层真正需要的 skill 配置只有一样：`config/report.json` 里的 `channels`
 * （6 个频道的 id / enum / label / 保底）。配置与资源路径一律由调用方注入，
 * SDK 不猜、不兜底、不读环境变量。
 *
 * 对照：报表渲染器（`lib/build.mjs`）**留在 skill 里**，它跟 `assets/report/**`
 * 是绑死的（模板、charts、core、icons、echarts 十处读取），
 * 所以它照旧用 `resolve(HERE, '..') = SKILL_DIR` 自己定位，不需要注入。
 */

/** 单次 hist_pool_stat 最多带 10 个版本（接口上限，超了报 -400005）。 */
export const MAX_VERS = 10;
/** 请求间隔。沿用改前实测值：太快会被限流，350ms 稳。 */
export const REQUEST_GAP_MS = 350;

/** 版本号降序。与改前 `sortVersionsDesc` 一字不差。 */
export function sortVersionsDesc(list) {
  return [...list].sort((a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    return pb[0] - pa[0] || (pb[1] ?? 0) - (pa[1] ?? 0);
  });
}

/** 按 n 分片。与改前 `chunk` 一字不差。 */
export function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * 按频道取数，产出 14 个键的 Map（不含 meta.json —— 那个要昵称，由外层补）。
 *
 * 这段是改前 `collectAll()` 的原样搬迁（含「先 index 再逐频道」「每频道 cur + hist」
 * 「hist 按版本分片并去重」的顺序）。**顺序不能改**：产物里的键序、
 * 以及「缺某个频道时 hist 用空 list 兜底」的行为都依赖它。
 *
 * @param {object} args
 * @param {{fetchJson: Function, kind: string}} args.transport
 * @param {Array<{id: string|number, enum: string, label: string}>} args.channels
 * @param {(msg: string) => void} [args.log]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 */
export async function collectFiles({ transport, channels, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const index = await transport.fetchJson('/index');
  const byEnum = new Map((index.data.type_stats ?? []).map((t) => [t.gacha_type, t]));

  const files = new Map();
  files.set('index.json', index);
  const summary = {};

  for (const ch of channels) {
    const stat = byEnum.get(ch.enum);

    await sleep(REQUEST_GAP_MS);
    let cur;
    try {
      cur = await transport.fetchJson('/cur_pool_stat', `gacha_type=${ch.id}`);
    } catch (e) {
      /*
       * 单频道 cur 失败不致命：音擎回响这类频道常常一条记录都没有，
       * 接口会报错或返回空。用空 list 兜底，让该频道在报表里正常显示「没有金」。
       */
      log(`⚠️  ${ch.label} cur_pool_stat 失败：${e.message}`);
      cur = { retcode: 0, data: { list: [] } };
    }
    files.set(`cur_pool_stat_${ch.id}.json`, cur);

    // 历史卡池：必须用本频道自己的 has_data_vers，且单次最多 10 个
    const vers = sortVersionsDesc(stat?.has_data_vers ?? []);
    const pools = [];
    for (const slice of chunk(vers, MAX_VERS)) {
      await sleep(REQUEST_GAP_MS);
      try {
        const hist = await transport.fetchJson('/hist_pool_stat', `gacha_type=${ch.id}&vers=${slice.join(',')}`);
        pools.push(...(hist.data?.list ?? []));
      } catch (e) {
        if (e.retcode === -400005) throw new Error(`${ch.label}: vers 分片仍报参数错误（${slice.join(',')}）`);
        throw e;
      }
    }
    /*
     * 分片之间可能有重叠（同一版本可能出现在多个分片的返回里），按四元组去重。
     * 改前就是这么做的，**判据别动**：只看 gacha_type|version|start_ts|end_ts，
     * 不看记录内容 —— 同一卡池的不同版本属于不同条目，本来就该都在。
     */
    const seen = new Set();
    const merged = pools.filter((p) => {
      const key = `${p.gacha_type}|${p.version}|${p.start_ts}|${p.end_ts}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    files.set(`hist_pool_stat_${ch.id}.json`, {
      retcode: 0,
      message: 'OK',
      data: { cur_ver: index.data.cur_ver, list: merged },
    });

    const countGold = (list) => list.reduce((s, p) => s + (p.cur_records?.length ?? 0), 0);
    const golds = countGold(merged) + countGold(cur.data?.list ?? []);
    summary[ch.id] = { label: ch.label, pulls: Number(stat?.total_count ?? 0), sCount: Number(stat?.s_count ?? 0), golds };
    log(`${ch.label}: ${summary[ch.id].pulls} 抽 / 官方 S ${summary[ch.id].sCount} / 取到金 ${golds} / 版本 ${vers.length}`);
  }

  return { files, summary, index };
}

/**
 * 由 index + 登录阶段信息拼出 meta.json 的内容。
 *
 * **字段顺序与改前完全一致**（`JSON.stringify(meta, null, 2)` 落盘，键序会影响字节）：
 * 改前在 `scripts/collect.mjs` 的 main 里手写这个对象，这里原样搬过来。
 *
 * @param {object} args
 * @param {object} args.index           `/index` 的原始响应
 * @param {string} args.uid
 * @param {string|null} args.nickname
 * @param {string} args.region
 * @param {string} args.api
 * @param {Record<string, object>} args.summary
 * @param {string} [args.fetchedAt]     采集时间（ISO），默认 now
 * @param {boolean} [args.isCn]
 */
export function buildMeta({ index, uid, nickname, region, api, summary, fetchedAt, isCn }) {
  const versions = (index.data.type_stats ?? []).flatMap((t) => t.has_data_vers ?? []);
  const uniq = sortVersionsDesc([...new Set(versions)]);
  return {
    schema: 'zzz-stats/v1',
    server: (isCn ?? /^prod_gf_cn$/i.test(region)) ? 'cn' : 'os',
    uid,
    region,
    nickname: nickname ?? null,
    fetched_at: fetchedAt ?? new Date().toISOString(),
    versions: uniq.length ? `${uniq[uniq.length - 1]} → ${uniq[0]}` : null,
    source: api,
    channels: summary,
    total_gacha_count: Number(index.data.total_gacha_count ?? 0),
    total_s_count: Number(index.data.total_s_count ?? 0),
    total_counts_exclude_bangboo: true,
  };
}

/**
 * 采集一整个账号：登录 → uid → 取数 → meta。
 *
 * 两个 transport：
 *   - `{ kind: 'node' }`    纯 Node 扫码登录 + Cookie 直连取数（默认）
 *   - `{ kind: 'browser' }` 浏览器页面里扫码 + 页内 fetch（改前的老路，保留作降级）
 *
 * @param {object} args
 * @param {object} args.cfg                          `config/report.json` 的解析结果。**必传**
 *        （SDK 不猜配置路径：它不知道自己在哪个仓库布局里）。`channels` 不给时用它的 channels。
 * @param {Function} [args.encodeQr]                自定义二维码编码器（收文本、返回 dataUrl）
 * @param {'node'|'browser'} [args.transport]        用哪条路，默认 node
 * @param {object} [args.browser]                    浏览器路径的参数（见 packages/sdk/login-browser.mjs）
 * @param {Array} [args.channels]                    频道表，默认取 args.cfg.channels
 * @param {string} [args.region]                     默认 prod_gf_cn
 * @param {string} [args.api]                        硬覆盖 act 基址
 * @param {(qr: {dataUrl: string, file?: string, url?: string}) => any} [args.onQr]
 *        二维码回调。**SDK 不写盘**：要落盘/起服务的调用方自己在这里做。
 * @param {(ev: {stage: string, message: string, data?: object}) => void} [args.onProgress]
 * @param {(msg: string) => void} [args.log]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {Function} [args.fetchImpl]
 * @returns {Promise<{uid: string, nickname: string|null, files: Map<string, unknown>, summary: object, meta: object}>}
 */
export async function collectData({
  transport = 'node',
  browser = null,
  channels = null,
  region = 'prod_gf_cn',
  api = null,
  cfg = null,
  encodeQr = null,
  onQr = null,
  onProgress = null,
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl = fetch,
  fetchedAt = undefined,
} = {}) {
  /*
   * cfg 必传。这里**不再兜底去读** `config/report.json` —— 那需要知道 skill 目录在哪，
   * 而 SDK 已经搬到 `packages/sdk/`，猜出来的路径必然错。
   * 报错信息要说清「该传什么」，而不是让人去翻 ENOENT 的路径。
   */
  if (!cfg) {
    throw new Error('collectData(): 必须传 cfg（config/report.json 的解析结果）——SDK 不再自己猜配置路径');
  }
  const CFG = cfg;
  const CHANNELS = channels ?? CFG.channels;
  const isCn = /^prod_gf_cn$/i.test(region);
  const progress = (stage, message, data) => onProgress?.({ stage, message, data });

  /*
   * 这个函数**只做一件事**：按你给的 transport 调对应那一个。
   *
   * 它**不判断该不该换一条路**：没有任何 catch、没有重试、没有
   * 「node 失败就 browser」的分支。降级策略在 CLI（`scripts/collect.mjs`）里，
   * 因为策略会随部署形态变（服务里可能只用浏览器、或失败即报错），
   * 把它写进 SDK 就等于替所有调用方做了决定。
   *
   * 两条路各自的两个动作（登录 / 取数）是并列的独立函数，见
   * `loginByQrNode` / `collectViaNode` / `loginByQrBrowser` / `collectViaBrowser`。
   * 这里只是为了兼容「一次拿到全部结果」的用法把它们串起来，不替代它们。
   */
  if (transport === 'node') {
    const { loginByQrNode, collectViaNode } = await import('./login-node.mjs');
    progress('login', '申请二维码');
    const { cookieHeader, gameUid, nickname } = await loginByQrNode({
      onQr: async (qr) => { await onQr?.(qr); },
      region,
      log,
      sleep,
      fetchImpl,
      encodeQr,
    });
    progress('collect', '开始取数');
    const { files, summary, meta } = await collectViaNode({
      cookieHeader,
      uid: gameUid,
      region,
      api,
      nickname,
      channels: CHANNELS,
      log,
      sleep,
      fetchImpl,
      fetchedAt,
    });
    progress('done', '采集完成');
    return { uid: gameUid, nickname, files, summary, meta };
  }

  if (transport === 'browser') {
    const { collectWithBrowser } = await import('./login-browser.mjs');
    return await collectWithBrowser({
      ...browser, channels: CHANNELS, region, api, onQr, onProgress: progress, log, sleep,
      fetchedAt, isCn,
    });
  }

  throw new Error(`未知 transport:${transport}（只支持 node / browser）`);
}
