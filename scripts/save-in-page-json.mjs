#!/usr/bin/env node
/**
 * 把 scripts/fetch-in-page.js 的返回结果落成 data/<账号>/ 下的文件（默认 data/current）。
 *
 * 用途：不管你用哪种浏览器能力取到数据（会话自带工具、moli、Playwright、人工复制），
 * 只要拿到那段 JSON，就能接上同一个报表构建流程：
 *
 *   node scripts/save-in-page-json.mjs --in result.json
 *   echo '<粘贴的 JSON>' | node scripts/save-in-page-json.mjs
 *   node scripts/build-report.mjs
 *
 * 输入可以是：
 *   - fetch-in-page.js 的返回值（{ ok, uid, index, channels }）
 *   - 直接就是那个 JSON 字符串（会被再次解析）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const argOf = (f, d) => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
/*
 * 默认写 data/current：一个账号一个子目录，与 collect.mjs / build-report.mjs 一致。
 * 用 --data data/<账号> 指到已有的那份数据上。
 */
const DATA_DIR = resolve(ROOT, argOf('data', 'data/current'));

async function readStdin() {
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function parseLoose(raw) {
  let v = JSON.parse(raw);
  // 有的工具会把返回值再包一层字符串
  for (let i = 0; i < 3 && typeof v === 'string'; i += 1) v = JSON.parse(v);
  return v;
}

const input = argOf('in', null);
const raw = input ? readFileSync(input, 'utf8') : await readStdin();
if (!raw.trim()) {
  console.error('没有输入。用 --in <file> 或从 stdin 传入 JSON。');
  process.exit(1);
}

let payload;
try {
  payload = parseLoose(raw.trim());
} catch (e) {
  console.error('JSON 解析失败：', e.message);
  process.exit(1);
}

if (!payload || payload.ok === false) {
  console.error('取数没成功：', payload?.error ?? '未知错误', payload?.hint ?? '');
  process.exit(1);
}
if (!payload.index || !payload.channels) {
  console.error('输入格式不对：需要包含 index 与 channels 字段（由 scripts/fetch-in-page.js 产出）。');
  process.exit(1);
}

mkdirSync(DATA_DIR, { recursive: true });

const write = (name, value) => {
  writeFileSync(join(DATA_DIR, name), JSON.stringify(value, null, 1));
};

write('index.json', payload.index);

let totalGolds = 0;
for (const [id, ch] of Object.entries(payload.channels)) {
  write(`cur_pool_stat_${id}.json`, ch.curPoolStat);
  write(`hist_pool_stat_${id}.json`, ch.histPoolStat);
  const count = (list) => list.reduce((s, p) => s + (p.cur_records?.length ?? 0), 0);
  totalGolds += count(ch.curPoolStat?.data?.list ?? []) + count(ch.histPoolStat?.data?.list ?? []);
}

// 昵称不在接口里，只能由采集方从页面文本读取后补进 payload
const versions = (payload.index.data?.type_stats ?? []).flatMap((t) => t.has_data_vers ?? []);
const uniq = [...new Set(versions)].sort((a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  return pb[0] - pa[0] || (pb[1] ?? 0) - (pa[1] ?? 0);
});

const server = payload.server ?? (/^prod_gf_cn$/.test(String(payload.region ?? 'prod_gf_cn')) ? 'cn' : 'os');

// 国际服的接口基址与国服不同；落进 meta 方便事后核对这份数据是哪个服的
const API_BASE = server === 'cn'
  ? 'https://act-api-takumi.mihoyo.com/event/nap_gacha_record'
  : 'https://sg-act-public-api.hoyolab.com/event/nap_gacha_record';

write('meta.json', {
  schema: 'zzz-stats/v1',
  server,
  uid: String(payload.uid),
  region: payload.region ?? 'prod_gf_cn',
  nickname: payload.nickname ?? null,
  fetched_at: payload.fetchedAt ?? new Date().toISOString(),
  versions: uniq.length ? `${uniq[uniq.length - 1]} → ${uniq[0]}` : null,
  source: API_BASE,
  total_gacha_count: Number(payload.index.data?.total_gacha_count ?? 0),
  total_s_count: Number(payload.index.data?.total_s_count ?? 0),
  total_counts_exclude_bangboo: true,
});

// 完整性：金抽数 + 垫抽 == 官方总抽
let bad = 0;
for (const [id, ch] of Object.entries(payload.channels)) {
  const stat = (payload.index.data?.type_stats ?? []).find(
    (t) =>
      t.gacha_type ===
      ({
        1: 'GACHA_TYPE_PERMANENT',
        2: 'GACHA_TYPE_CHARACTER_UP',
        3: 'GACHA_TYPE_WEAPON_UP',
        5: 'GACHA_TYPE_BANGBOO',
        102: 'GACHA_TYPE_CHARACTER_RETURN',
        103: 'GACHA_TYPE_WEAPON_RETURN',
      })[id],
  );
  if (!stat) continue;
  const pools = [
    ...(ch.histPoolStat?.data?.list ?? []),
    ...(ch.curPoolStat?.data?.list ?? []),
  ];
  const pulls = pools.reduce(
    (s, p) => s + (p.cur_records ?? []).reduce((x, r) => x + Number(r.count || 0), 0),
    0,
  );
  const total = pulls + Number(stat.next_s_cur_times ?? 0);
  if (total !== Number(stat.total_count)) {
    bad += 1;
    console.warn(
      `⚠️  频道 ${id}: 金抽数 ${pulls} + 垫抽 ${stat.next_s_cur_times} = ${total} ≠ 官方 ${stat.total_count}`,
    );
  }
}

console.log(`已写入 ${DATA_DIR}（UID ${payload.uid}，${totalGolds} 金）`);
console.log(bad === 0 ? '✅ 完整性校验通过' : `⚠️  ${bad} 个频道校验失败`);
console.log('下一步：node scripts/build-report.mjs');
