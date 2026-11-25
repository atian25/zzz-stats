/** 登录后采集内核：只返回 13 个响应键与独立 meta，不读消费者配置。 */

import { throwIfAborted, SdkError } from './errors.mjs';

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
 * 按频道取数，产出 13 个键的 Map（不含 meta.json —— 那个要昵称，由外层补）。
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
export async function collectFiles({ transport, channels, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), signal, progress = async () => {} }) {
  throwIfAborted(signal);
  const index = await transport.fetchJson('/index');
  if (!index?.data || !Array.isArray(index.data.type_stats)) throw new SdkError('INVALID_RESPONSE', 'index 缺少 type_stats', { stage: 'collect', endpoint: '/index' });
  const byEnum = new Map((index.data.type_stats ?? []).map((t) => [t.gacha_type, t]));

  const files = new Map();
  files.set('index.json', index);
  const summary = {};

  for (const ch of channels) {
    throwIfAborted(signal);
    await progress('channel-start', { channelId: ch.id });
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
    throwIfAborted(signal);
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
        if (e.retcode === -400005) throw new SdkError('UPSTREAM_ERROR', `${ch.label}: vers 分片仍报参数错误`, { stage: 'collect', retcode: e.retcode, endpoint: '/hist_pool_stat', cause: e });
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
    await progress('channel-done', { channelId: ch.id });
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
