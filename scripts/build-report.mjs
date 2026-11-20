#!/usr/bin/env node
/**
 * zzz-stats 报表构建器
 *
 * 输入（全部来自 skill 的采集步骤，原样保存的官方响应）：
 *   data/index.json
 *   data/cur_pool_stat_<t>.json
 *   data/hist_pool_stat_<t>.json
 *   data/meta.json（可选，补昵称/采集时间）
 * 配置：config/report.json
 * 输出：report.html（单文件，内联数据和 ECharts，图片走相对路径）
 *
 * 这份脚本是「口径的唯一实现」。文档只描述结果，不再重复算法。
 * 用法：node scripts/build-report.mjs [--data data] [--out report.html]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DATA_DIR = resolve(ROOT, argOf('data', 'data'));
const OUT_FILE = resolve(ROOT, argOf('out', 'report.html'));

const CFG = JSON.parse(readFileSync(join(ROOT, 'config/report.json'), 'utf8'));

// ---------------------------------------------------------------- 读取原始数据

function readJson(file) {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8');
  const body = JSON.parse(raw);
  if (body && body.retcode !== undefined && body.retcode !== 0) {
    throw new Error(`${file}: retcode=${body.retcode} ${body.message || ''}`);
  }
  return body?.data ?? body;
}

const index = readJson(join(DATA_DIR, 'index.json'));
if (!index) {
  console.error(`找不到 ${join(DATA_DIR, 'index.json')}。先跑采集步骤，或把已有 data/ 放到该目录。`);
  process.exit(1);
}
const meta = readJson(join(DATA_DIR, 'meta.json')) || {};

/** 一个频道的全部金，按 sort 升序。sort 是频道内跨池连续的全局序号。 */
function loadGolds(channel) {
  const golds = [];
  for (const prefix of ['hist_pool_stat', 'cur_pool_stat']) {
    const body = readJson(join(DATA_DIR, `${prefix}_${channel.id}.json`));
    for (const pool of body?.list ?? []) {
      for (const rec of pool.cur_records ?? []) {
        golds.push({
          sort: Number(rec.sort),
          count: Number(rec.count),
          recordTime: Number(rec.record_time),
          itemId: String(rec.item_id),
          name: rec.name,
          itemType: rec.item_type,
          isUp: rec.is_up === true,
          upTag: rec.up_tag,
          version: pool.version ?? null,
          rarity: rec.rarity,
        });
      }
    }
  }
  golds.sort((a, b) => a.sort - b.sort);
  return golds;
}

// ---------------------------------------------------------------- 口径计算

const statsOf = (enumName) => (index.type_stats ?? []).find((t) => t.gacha_type === enumName) ?? null;
const num = (v) => (v == null || v === '' ? null : Number(v));

/** 同一发十连：同秒 且 sort 差 ≤ N。 */
const sameTenPull = (a, b) => a.recordTime === b.recordTime && b.sort - a.sort <= CFG.numbers.multiGoldSortGap;

/**
 * 把一个频道的金序列折成「UP 轮」。
 *
 * 规则来自 references/report-rules.md §1：
 *  - 一轮从上一个 UP 结束后开始，`off` 累计期间所有非 UP 金的抽数；
 *  - UP 金自己的 count 是距上一金的抽数，记作 `up`；
 *  - 十连里排在 UP 之后的非 UP 金（副金）并回这一轮，总抽 +它的 count，仍算直出。
 *
 * 这样 total 之和恒等于该频道官方 gacha_count，可以直接校验。
 */
function buildRounds(golds) {
  const rounds = [];
  // losts 必须带身份（itemId/name）：柱顶上要给歪出的角色画头像，tip 里也要写名字。
  // 只累加 off 的数字会把「歪了谁」丢掉。
  let losts = [];
  const off = () => losts.reduce((s, x) => s + x.count, 0);
  let i = 0;
  while (i < golds.length) {
    const g = golds[i];
    if (!g.isUp) {
      losts.push({ name: g.name, itemId: g.itemId, count: g.count, sort: g.sort });
      i += 1;
      continue;
    }
    const round = {
      version: g.version,
      name: g.name,
      itemId: g.itemId,
      recordTime: g.recordTime,
      sort: g.sort,
      off: off(),
      lossNames: losts.map((x) => x.name).join('、'),
      losts: [...losts],
      up: g.count,
      total: off() + g.count,
      side: [],
    };
    // 十连副金：紧跟在 UP 之后、同秒且 sort 差 ≤ N 的非 UP 金
    let j = i + 1;
    while (j < golds.length && sameTenPull(golds[j - 1], golds[j]) && !golds[j].isUp) {
      round.side.push({ name: golds[j].name, itemId: golds[j].itemId, count: golds[j].count, sort: golds[j].sort });
      round.total += golds[j].count;
      j += 1;
    }
    rounds.push(round);
    losts = [];
    i = j;
  }
  return rounds;
}

/** 一轮是否「保底获得」：上一轮末尾带出了非 UP 副金，说明 50/50 已经歪掉。 */
function markGuaranteed(rounds) {
  rounds.forEach((r, k) => {
    r.direct = r.off === 0;
    r.guar = k > 0 && rounds[k - 1].side.length > 0;
    r.guarFrom = r.guar ? rounds[k - 1].side.map((s) => s.name).join('、') : null;
  });
  return rounds;
}

/** 累计不歪率：直出且不是保底获得才算胜场。 */
function cumulativeWinRate(rounds) {
  let wins = 0;
  return rounds.map((r, i) => {
    if (r.direct && !r.guar) wins += 1;
    return Math.round((wins / (i + 1)) * 1000) / 10;
  });
}

/** 连续段统计：返回 [{k, start, end, chain}]，按长度降序。
 *  breakOnGuaranteed：保底获得（上一轮已经歪掉）不计入 50/50 连胜，必须打断。 */
/** 版本序号比较（"1.10" > "1.9"）。 */
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * 把一串版本号写成人类读法：
 *   同一版本        → `v2.0`
 *   连续区间        → `v1.0～1.1`（尾部省掉重复的 v）
 *   不连续多段      → `v1.0～1.1、v2.5`
 */
function versionRange(list) {
  const uniq = [...new Set(list)].sort(cmpVer);
  if (!uniq.length) return '';
  const runs = [];
  let cur = [uniq[0]];
  for (let i = 1; i < uniq.length; i += 1) {
    // 相邻（1.0 → 1.1 / 1.9 → 1.10 / 2.7 → 3.0）算连续
    const prev = cur[cur.length - 1].split('.').map(Number);
    const now = uniq[i].split('.').map(Number);
    const nextMajor = [...prev];
    nextMajor[1] = (prev[1] ?? 0) + 1;
    const isNext = nextMajor[0] === now[0] && nextMajor[1] === now[1];
    const isMajor = now[0] === prev[0] + 1 && (now[1] ?? 0) === 0;
    if (isNext || isMajor) cur.push(uniq[i]);
    else { runs.push(cur); cur = [uniq[i]]; }
  }
  runs.push(cur);

  return runs
    .map((run) => {
      if (run.length === 1) return `v${run[0]}`;
      const head = `v${run[0]}`;
      const tail = run[run.length - 1];
      // 完整写出尾版本（v2.1～2.3），不要缩成 v2.1～3 —— 会被误读成「到 v3」
      return `${head}～${tail}`;
    })
    .join('、');
}

function seriesOf(rounds, predicate, opts = {}) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push({
      k: run.length,
      start: run[0],
      end: run[run.length - 1],
      // 每一环带上歪出的角色：`青衣（猫又）`；没歪就只写名字
      chain: run
        .map((idx) => {
          const r = rounds[idx];
          const lost = (r.losts ?? []).map((x) => x.name).filter(Boolean).join('、');
          return lost ? `${r.name}（${lost}）` : r.name;
        })
        .join(' → '),
      // 区间写法：同版本 `v2.0`，跨版本 `v1.0～1.1`；片段连续时合并，否则用逗号
      versions: versionRange(run.map((idx) => rounds[idx].version)),
    });
    run = [];
  };
  rounds.forEach((r, idx) => {
    if (opts.breakOnGuaranteed && r.guar) {
      flush();
      return;
    }
    if (predicate(r)) run.push(idx);
    else flush();
  });
  flush();
  return out.sort((a, b) => b.k - a.k || a.start - b.start);
}

const roundsOf = (channel) => markGuaranteed(buildRounds(loadGolds(channel)));

/** 十连多金组：同频道内，把同秒且 sort 差 ≤ N 的连续金归为一组。 */
function multiGoldGroups(golds) {
  const groups = [];
  let run = [];
  const flush = () => {
    if (run.length > 1) groups.push([...run]);
    run = [];
  };
  golds.forEach((g, idx) => {
    run.push(g);
    const next = golds[idx + 1];
    if (!next || !sameTenPull(g, next)) flush();
  });
  flush();
  return groups;
}

// ---------------------------------------------------------------- 组装报表数据

const channelReports = CFG.channels.map((ch) => {
  const golds = loadGolds(ch);
  const rounds = ch.kind === 'permanent' || ch.kind === 'bangboo' ? markGuaranteed(buildRounds(golds)) : roundsOf(ch);
  const stats = statsOf(ch.enum);
  const officialPulls = num(stats?.total_count) ?? rounds.reduce((s, r) => s + r.total, 0);
  const recordPulls = rounds.reduce((s, r) => s + r.total, 0) + rounds.reduce((s, r) => s + r.side.reduce((x, y) => x + y.count, 0), 0);
  const perGold = golds.length ? officialPulls / golds.length : null;
  return {
    ...ch,
    golds,
    rounds,
    stats: stats
      ? {
          pulls: officialPulls,
          sCount: num(stats.s_count),
          upCount: num(stats.up_count),
          upAvg: num(stats.avr_up_count),
          pity: num(stats.next_s_cur_times),
          hasDataVers: stats.has_data_vers ?? [],
        }
      : null,
    perGold,
  };
});

const character = channelReports.find((c) => c.key === 'character_up');
const charRounds = character.rounds;
const pullsPerUp = charRounds.length ? character.stats.pulls / charRounds.length : null;
const winRate = cumulativeWinRate(charRounds);
const finalWinRate = winRate.length ? winRate[winRate.length - 1] : null;

const extremeRounds = charRounds.filter((r) => r.total <= CFG.numbers.extremePulls);
const multiGold = multiGoldGroups(character.golds);
const upStreaks = seriesOf(charRounds, (r) => r.direct, { breakOnGuaranteed: true });
const lossStreaks = seriesOf(charRounds, (r) => r.off > 0);
const nearMiss = charRounds.filter((r) => r.off > 0 && r.total < pullsPerUp);

const metrics = {
  channelLabel: character.label,
  pulls: character.stats.pulls,
  goldCount: character.golds.length,
  upCount: charRounds.length,
  pullsPerUp: pullsPerUp == null ? null : Math.round(pullsPerUp * 10) / 10,
  winRate: finalWinRate,
  extremeRounds: extremeRounds.length,
  multiGoldRounds: multiGold.length,
  maxUpStreak: upStreaks.length ? upStreaks[0].k : 0,
  maxLossStreak: lossStreaks.length ? lossStreaks[0].k : 0,
  nearMissRounds: nearMiss.length,
};

/** 称号：按每 UP 均查配置里的 10 档，取第一个满足的档位。 */
function titleFor(value) {
  if (value == null) return null;
  const tiers = CFG.titles.tiers;
  for (const t of tiers) {
    if (t.maxPullsPerUp == null || value <= t.maxPullsPerUp) return t;
  }
  return tiers[tiers.length - 1];
}
metrics.title = titleFor(metrics.pullsPerUp);

/** 条件求值：支持 > >= < <= == != */
const compare = (left, op, right) => {
  switch (op) {
    case '>': return left > right;
    case '>=': return left >= right;
    case '<': return left < right;
    case '<=': return left <= right;
    case '==': return left === right;
    case '!=': return left !== right;
    default: throw new Error(`未知比较符 ${op}`);
  }
};

const fill = (tpl, vars) => String(tpl ?? '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '').toString());

/** 计数后缀：只有出现不止一次时才写 ×N。 */
const times = (n) => (n > 1 ? ` ×${n}` : '');

function evaluateTags() {
  const out = [];
  // 提示文案可用的变量：指标 + 配置里的阈值
  const vars = { ...metrics, ...CFG.numbers };
  for (const rule of CFG.tags.rules) {
    if (rule.enabled === false) continue;
    const tone = CFG.tags.tone[rule.tone]?.color ?? CFG.tags.tone.positive.color;

    if (rule.kind === 'metric') {
      const groups = rule.any ? [rule.any] : [rule.all ?? []];
      const hit = groups.some((group) => group.every((c) => compare(metrics[c.metric] ?? 0, c.op, c.value)));
      if (!hit) continue;
      out.push({ id: rule.id, name: fill(rule.name, metrics), tone, tip: fill(rule.tip ?? rule.name, vars), bars: [] });
      continue;
    }

    if (rule.kind === 'series') {
      const list = rule.series === 'upStreak' ? upStreaks : lossStreaks;
      if (!list.length) continue;
      /*
       * 每个不同的长度各出一个标签，不是只留最长那档。
       * 例：账号里有 5 连歪、也有 3 连歪，两个都要出现——
       * 只取最长会让「3 连歪」这个事实在报表里消失。
       * 同一长度出现多次才加 ×N。
       */
      const byLen = new Map();
      for (const item of list) {
        if (!byLen.has(item.k)) byLen.set(item.k, []);
        byLen.get(item.k).push(item);
      }
      // 单发成的「1 连」是噪音，不立标签（阈值可配）
      const minK = rule.minK ?? 2;
      const lens = [...byLen.keys()].filter((k) => k >= minK).sort((a, b) => b - a);
      if (!lens.length) continue;
      // 最长的那个仍用原 id，其余的加后缀，便于前端/测试稳定引用
      for (const [idx, k] of lens.entries()) {
        const same = byLen.get(k);
        const name = `${fill(rule.nameTemplate, { k })}${times(same.length)}`;
        const tip = same.map((s) => fill(rule.tipTemplate, s)).join('\n');
        out.push({
          id: idx === 0 ? rule.id : `${rule.id}-${k}`,
          name,
          tone,
          tip,
          bars: same.map((s) => `${s.start}-${s.end}`),
        });
      }
      continue;
      continue;
    }

    if (rule.kind === 'event') {
      if (!multiGold.length) continue;
      const name = rule.showCount ? `${rule.nameTemplate}${times(multiGold.length)}` : rule.nameTemplate;
      const tip = multiGold
        .map((g) => `${[...new Set(g.map((x) => `v${x.version}`))].join('、')}：${g.map((x) => `${x.name} ${x.count} 抽`).join(' → ')}`)
        .join('\n');
      out.push({ id: rule.id, name, tone, tip, bars: [] });
      continue;
    }

    if (rule.kind === 'round') {
      const m = rule.match ?? {};
      const hits = charRounds
        .map((r, idx) => ({ r, idx }))
        .filter(({ r }) => {
          if (m.offAbove != null && !(r.off > m.offAbove)) return false;
          if (m.totalBelowMean && !(r.total < pullsPerUp)) return false;
          return true;
        });
      if (!hits.length) continue;
      const name = rule.showCount ? `${rule.nameTemplate}${times(hits.length)}` : rule.nameTemplate;
      const tip = hits.map(({ r }) => `v${r.version} ${r.name}：${r.total} 抽，歪 ${r.off} 抽`).join('\n');
      out.push({ id: rule.id, name, tone, tip, bars: hits.map(({ idx }) => `${idx}-${idx}`) });
    }
  }
  return out;
}

const rawTags = evaluateTags();

/*
 * 标签去重与优先级。
 *
 * 冲突来自两类：
 *   1) 宏观概括 vs 具体明细：「运势极佳」(最长连 UP ≥ 4) 与「代理人 4 连 UP」是同一件事，
 *      两条同时出现等于说两遍。具体的那条更有信息量，所以概括让位（配置里的 suppressWhen）。
 *   2) 正向 vs 负向互斥：「欧气附体」与「非酋附体」理论上可同时成立，同时出现会自相矛盾。
 *
 * 规则：配置数组里靠前的优先级更高；被 suppressWhen 指向的标签一旦存在，本条就不再输出。
 */
const tags = (() => {
  const present = new Set(rawTags.map((t) => t.id));
  const killed = new Set();
  for (const t of rawTags) {
    const rule = CFG.tags.rules.find((r) => r.id === t.id);
    for (const dep of rule?.suppressWhen ?? []) {
      if (present.has(dep)) killed.add(t.id);
    }
  }
  // 正负互斥
  if (present.has('unlucky-aura')) killed.add('lucky-aura');
  return rawTags.filter((t) => !killed.has(t.id));
})();

if (rawTags.length !== tags.length) {
  const dropped = rawTags.filter((t) => !tags.includes(t)).map((t) => t.name);
  console.log(`  （标签去重，已省略：${dropped.join(' / ')}）`);
}

/** 详情行：逐金模式 = 每一金一行；合并模式 = 只留 UP 行，歪成本并入。 */
function detailRows(channel, merged) {
  const toRow = (g) => ({
    itemId: g.itemId,
    name: g.name,
    version: g.version,
    pulls: g.count,
    isUp: g.isUp,
    lost: channel.has5050 ? !g.isUp : null,
    stamp: channel.has5050 && !g.isUp,
    recordTime: g.recordTime,
  });
  if (!merged || !channel.has5050) {
    return channel.golds
      .slice()
      .reverse()
      .map((g) => toRow(g));
  }
  return channel.rounds
    .slice()
    .reverse()
    .map((r) => ({
      itemId: r.itemId,
      name: r.name,
      version: r.version,
      pulls: r.total,
      isUp: true,
      lost: r.off > 0,
      stamp: r.off > 0,
      up: r.up,
      off: r.off,
      recordTime: r.recordTime,
      side: r.side,
      // 歪出的角色在 losts 里（side 只装十连副金），tip 需要它
      losts: r.losts,
    }));
}

const details = Object.fromEntries(
  CFG.channels.map((ch) => {
    const c = channelReports.find((x) => x.id === ch.id);
    return [ch.id, { all: detailRows(c, false), merged: detailRows(c, true), perGold: c.perGold, has5050: ch.has5050 }];
  }),
);

const versions = (() => {
  const all = channelReports.flatMap((c) => c.golds.map((g) => g.version)).filter(Boolean);
  const uniq = [...new Set(all)];
  uniq.sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    return pa[0] - pb[0] || (pa[1] ?? 0) - (pb[1] ?? 0);
  });
  return uniq;
})();

const report = {
  schema: 'zzz-stats/report@1',
  generatedAt: new Date().toISOString(),
  meta: {
    // 昵称不在任何接口里，只能由采集步从页面 DOM 文本读到，写进 meta.json
    nickname: meta.nickname ?? null,
    nicknameKnown: Boolean(meta.nickname),
    uid: String(meta.uid ?? ''),
    region: meta.region ?? 'prod_gf_cn',
    serverLabel: '国服',
    fetchedAt: meta.fetched_at ?? null,
    versionFrom: versions[0] ?? null,
    versionTo: versions[versions.length - 1] ?? null,
  },
  metrics,
  tags,
  title: metrics.title,
  chart: {
    rounds: charRounds,
    winRate,
    extremePulls: CFG.numbers.extremePulls,
    multiGold: multiGold.map((g) => ({ sort: g[g.length - 1].sort, names: g.map((x) => x.name) })),
  },
  channels: channelReports.map((c) => ({
    id: c.id,
    key: c.key,
    label: c.label,
    detailLabel: c.detailLabel,
    kind: c.kind,
    has5050: c.has5050,
    stats: c.stats,
    perGold: c.perGold,
    goldCount: c.golds.length,
    rounds: c.rounds.length,
  })),
  details,
  kpi: [
    { key: 'winRate', label: '角色池不歪', value: finalWinRate == null ? '—' : `${finalWinRate}%`, unit: '' },
    { key: 'pullsPerUp', label: '每 UP 角色', value: metrics.pullsPerUp ?? '—', unit: '抽' },
    { key: 'weaponPerUp', label: '每 UP 音擎', value: (() => { const w = channelReports.find((c) => c.key === 'weapon_up'); return w.stats?.upCount ? Math.round((w.stats.pulls / w.stats.upCount) * 10) / 10 : '—'; })(), unit: '抽' },
    { key: 'permanentPerGold', label: '常驻每金', value: (() => { const p = channelReports.find((c) => c.key === 'permanent'); return p.perGold ? Math.round(p.perGold * 10) / 10 : '—'; })(), unit: '抽' },
    { key: 'bangbooPerGold', label: '每邦布', value: (() => { const b = channelReports.find((c) => c.key === 'bangboo'); return b.perGold ? Math.round(b.perGold * 10) / 10 : '—'; })(), unit: '抽' },
  ],
  totals: {
    // 跨频道汇总只算同一种货币：邦布用邦布币，不计入
    pulls: channelReports.filter((c) => c.countsTowardTotals !== false).reduce((s, c) => s + (c.stats?.pulls ?? 0), 0),
    pullsUsingTicket: channelReports.reduce((s, c) => s + (c.stats?.pulls ?? 0), 0),
    golds: channelReports.filter((c) => c.countsTowardTotals !== false).reduce((s, c) => s + c.golds.length, 0),
    goldsUsingTicket: channelReports.reduce((s, c) => s + c.golds.length, 0),
    pullsOfficial: num(index.total_gacha_count),
    goldsOfficial: num(index.total_s_count),
    excludedChannels: channelReports.filter((c) => c.countsTowardTotals === false).map((c) => c.label),
  },
  config: CFG,
};

// ---------------------------------------------------------------- 渲染

/*
 * 把用到的图标读成 base64 内嵌进 HTML。
 *
 * 为什么内嵌：报表经常被单独发出去（发文件、贴到别的对话、当附件）。
 * 如果只写相对路径 `assets/avatars/x.png`，接收方拿不到 assets 目录，
 * 就会看到一堆空框 —— 图表头像和详情图标全没了。
 * 图标都是 96px，用户自己的账号通常也就几十到两百张，内嵌后仍在 2 MB 量级。
 */
function inlineImages(report) {
  const cache = new Map();
  /*
   * 主图头像最终只显示 22px、详情图标 26px，96px 原图直接内嵌会把 HTML 撑到 6 MB。
   * 缩到 64px 再转 WebP（QPng 体积的 1/4），肉眼观感没有差别。
   */
  const encode = (dir, id) => {
    const key = `${dir}/${id}`;
    if (cache.has(key)) return cache.get(key);
    // 优先用压缩过的 64px 版本（assets/report/icons/<dir>），没有再退回原图
    const small = join(ROOT, 'assets/report/icons', dir, `${id}.png`);
    const full = join(ROOT, 'assets', dir, `${id}.png`);
    const file = existsSync(small) ? small : full;
    let out = null;
    if (existsSync(file)) {
      out = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
    } else {
      const fb = join(ROOT, 'assets/items/_fallback.png');
      out = existsSync(fb) ? `data:image/png;base64,${readFileSync(fb).toString('base64')}` : null;
      if (out) console.warn(`  ⚠️  缺图标 assets/${dir}/${id}.png，用占位图代替`);
    }
    cache.set(key, out);
    return out;
  };

  // 主图头像
  for (const r of report.chart.rounds) {
    r.avatar = encode('avatars', r.itemId);
    for (const s of r.side) s.avatar = encode('avatars', s.itemId);
    for (const x of r.losts ?? []) x.avatar = encode('avatars', x.itemId);
  }
  // 详情图标
  for (const ch of Object.values(report.details)) {
    for (const mode of ['all', 'merged']) {
      for (const row of ch[mode]) row.icon = encode('items', row.itemId);
      for (const row of ch[mode]) {
        for (const s of row.side ?? []) s.icon = encode('items', s.itemId);
      }
    }
  }
  return cache.size;
}

const template = readFileSync(join(ROOT, 'assets/report/template.html'), 'utf8');
const chartsJs = readFileSync(join(ROOT, 'assets/report/charts.js'), 'utf8');
const chartsCss = readFileSync(join(ROOT, 'assets/report/charts.css'), 'utf8');
const echartsJs = readFileSync(join(ROOT, 'assets/vendor/echarts.min.js'), 'utf8');

const inlined = inlineImages(report);

const html = template
  .replace('/*__CHARTS_CSS__*/', () => chartsCss)
  .replace('/*__ECHARTS__*/', () => echartsJs)
  .replace('/*__REPORT_DATA__*/', () => `window.__REPORT__ = ${JSON.stringify(report)};`)
  .replace('/*__CHARTS_JS__*/', () => chartsJs);

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, html);

// ---------------------------------------------------------------- 校验 + 摘要

/*
 * 通用完整性校验（6/6 频道实测成立，比「记录条数对得上」更强）：
 *     sum(cur_records[].count) + type_stats[].next_s_cur_times == type_stats[].total_count
 * 左边是「已出金的抽数 + 当前垫抽」，右边是官方总抽数。金数对得上但记录缺抽时会在这里露出来。
 * 常驻/邦布没有任何 is_up 记录，所以只对 50/50 频道额外做 UP 轮校验。
 */
const warn = [];
for (const c of channelReports) {
  if (!c.stats) {
    warn.push(`${c.label}: index 里没有对应 type_stats，抽数只能从记录推算`);
    continue;
  }
  const recordedPulls = c.golds.reduce((s, g) => s + g.count, 0);
  const pity = c.stats.pity ?? 0;
  if (recordedPulls + pity !== c.stats.pulls) {
    warn.push(`${c.label}: 金抽数 ${recordedPulls} + 垫抽 ${pity} = ${recordedPulls + pity} ≠ 官方 ${c.stats.pulls}`);
  }
  if (c.golds.length !== c.stats.sCount) {
    warn.push(`${c.label}: 金数 ${c.golds.length} ≠ 官方 s_count ${c.stats.sCount}`);
  }
  if (c.has5050) {
    const sumRounds = c.rounds.reduce((s, r) => s + r.total, 0);
    if (Math.abs(sumRounds - (c.stats.pulls - pity)) > 0) {
      warn.push(`${c.label}: UP 轮总抽 ${sumRounds} ≠ 官方已抽 ${c.stats.pulls - pity}`);
    }
  }
}
const nonBangbooPulls = channelReports.reduce((s, c) => s + (c.key === 'bangboo' ? 0 : c.stats?.pulls ?? 0), 0);
if (report.totals.pullsOfficial != null && report.totals.pullsOfficial !== nonBangbooPulls) {
  warn.push(`官方 total_gacha_count=${report.totals.pullsOfficial} ≠ 非邦布频道之和 ${nonBangbooPulls}（两个口径都不含邦布）`);
}

const sizeMB = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`report.html → ${OUT_FILE}（${sizeMB} MB，内嵌 ${inlined} 张图标，可单独发送）`);
console.log(`  角色池 ${metrics.upCount} UP / ${metrics.pulls} 抽 / 每 UP ${metrics.pullsPerUp} / 不歪 ${metrics.winRate}% / 称号「${metrics.title?.name}」`);
console.log(`  KPI: ${report.kpi.map((k) => `${k.label} ${k.value}${k.unit}`).join(' · ')}`);
console.log(`  标签: ${tags.map((t) => t.name).join(' / ') || '（无）'}`);
for (const w of warn) console.warn(`  ⚠️  ${w}`);
process.exit(0);
