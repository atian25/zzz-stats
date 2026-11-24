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
 *   lib/collect.mjs          ← 本文件：登录 → 定 uid/昵称 → 按频道取数 → 返回 Map
 *   lib/login-node.mjs       纯 Node 扫码登录
 *   lib/login-browser.mjs    浏览器登录（扫码走页面 iframe，短信也在这里）
 *   lib/transport-node.mjs   纯 Node 取数
 *   scripts/collect.mjs      薄壳：参数、日志、图片服务、落盘、退出码
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

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeTransport } from './transport-node.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, '..');

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
 * @param {'node'|'browser'} [args.transport]        用哪条路，默认 node
 * @param {object} [args.browser]                    浏览器路径的参数（见 lib/login-browser.mjs）
 * @param {Array} [args.channels]                    频道表，默认读 config/report.json
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
  onQr = null,
  onProgress = null,
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl = fetch,
  fetchedAt = undefined,
} = {}) {
  const CFG = cfg ?? JSON.parse(readFileSync(join(SKILL_DIR, 'config/report.json'), 'utf8'));
  const CHANNELS = channels ?? CFG.channels;
  const isCn = /^prod_gf_cn$/i.test(region);
  const progress = (stage, message, data) => onProgress?.({ stage, message, data });

  if (transport === 'node') {
    if (!isCn) {
      /*
       * 国际服的 passport/biz 是另一套，没实测过。与其猜一个半对的实现，
       * 不如明确退回去 —— 外壳会打一行「为什么降级」，用户不会莫名拿到错数据。
       */
      throw new Error('纯 Node 取数只做国服（prod_gf_cn）。国际服账号请用 --transport browser。');
    }
    const { loginWithQr, resolveGameUid } = await import('./login-node.mjs');
    progress('login', '申请二维码');
    const { cookie } = await loginWithQr({
      onQr: async (qr) => { await onQr?.(qr); },
      log,
      sleep,
      fetchImpl,
    });
    progress('login', '已登录，查游戏角色');
    const role = await resolveGameUid({ cookie, region, fetchImpl });
    log(`UID ${role.uid}（${role.regionName ?? role.region}）`);
    const t = createNodeTransport({
      uid: role.uid, cookie, region, api, nickname: role.nickname, fetchImpl,
    });
    progress('collect', '开始取数');
    const { files, summary, index } = await collectFiles({ transport: t, channels: CHANNELS, log, sleep });
    const meta = buildMeta({
      index, uid: role.uid, nickname: role.nickname, region, api: api ?? t.apiBase ?? '',
      summary, fetchedAt, isCn,
    });
    progress('done', '采集完成');
    return { uid: role.uid, nickname: role.nickname, files, summary, meta };
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
