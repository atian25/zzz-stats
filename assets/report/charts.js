/* zzz-stats 报表渲染
 *
 * 只消费 window.__REPORT__（由 scripts/build-report.mjs 生成），不含任何口径计算：
 * 称号、标签、阈值、配色全部来自 report.config，改数据不用碰这个文件。
 */
(function () {
  'use strict';

  const R = window.__REPORT__;
  if (!R) return;
  const CFG = R.config;

  // ------------------------------------------------------------- 小工具

  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const fill = (tpl, vars) => String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
  const pad2 = (n) => String(n).padStart(2, '0');

  /** 本地时区 MM-DD HH:MM */
  function fmtTime(sec) {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // --------------------------------------------------------- 隐私开关状态

  const privacy = { state: 0 };

  function maskName(name) {
    if (!name) return '';
    const c = CFG.privacy.maskName;
    return c.keepFirst ? name.slice(0, 1) + c.mask : c.mask.repeat(name.length);
  }
  function maskUid(uid) {
    if (!uid || uid.length <= CFG.privacy.maskUid.keepHead + CFG.privacy.maskUid.keepTail) return uid || '';
    const c = CFG.privacy.maskUid;
    const head = uid.slice(0, c.keepHead);
    const tail = uid.slice(-c.keepTail);
    return head + c.mask.repeat(uid.length - c.keepHead - c.keepTail) + tail;
  }
  const NAME_MASKED = new Set();
  function displayName(name) {
    if (!name) return '';
    if (privacy.state >= 2 || NAME_MASKED.has(name)) return maskName(name);
    return name;
  }
  function displayUid(uid) {
    return privacy.state >= 1 ? maskUid(uid) : uid;
  }

  const EYE_ICONS = {
    0: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    1: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>',
    2: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.9 17.9A11 11 0 0 1 12 20C5 20 1 12 1 12a20 20 0 0 1 5.1-6.1"/><path d="M9.9 4.2A11 11 0 0 1 12 4c7 0 11 8 11 8a20 20 0 0 1-2.2 3.2"/><path d="M3 3l18 18"/></svg>',
  };
  const EYE_LABEL = { 0: '打码 UID', 1: '打码昵称', 2: '显示全部' };

  // ---------------------------------------------------------------- header

  function renderHeader() {
    const m = R.meta;
    const nick = $('#nick');
    const uid = $('#uid');
    const eye = $('#eye');

    nick.textContent = m.nickname ? displayName(m.nickname) : '—';
    nick.title = m.nickname ? '' : '昵称未采集到（接口不返回昵称，需采集时从页面文本读取）';
    uid.textContent = `UID ${displayUid(m.uid)}`;
    eye.innerHTML = EYE_ICONS[privacy.state];
    eye.title = EYE_LABEL[privacy.state];
    eye.setAttribute('aria-label', EYE_LABEL[privacy.state]);
    eye.dataset.state = String(privacy.state);

    $('#h1').textContent = R.title ? R.title.name : '';
    $('#h1').dataset.tone = R.title ? R.title.tone : 'neutral';

    // 悬浮看全部档位与区间；当前档加粗高亮（与图表 tip 同样的气泡样式）
    const tiers = CFG.titles?.tiers ?? [];
    if (tiers.length && R.metrics.pullsPerUp != null) {
      const cur = R.metrics.pullsPerUp;
      const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      let prev = 0;
      const rows = [];
      for (const t of tiers) {
        const hit = t.name === R.title.name;
        const range = t.maxPullsPerUp == null
          ? `&gt; ${prev}`
          : prev > 0
            ? `${prev} – ${t.maxPullsPerUp}`
            : `≤ ${t.maxPullsPerUp}`;
        const cell = `${range.padEnd(12)}${esc(t.name)}`;
        rows.push(hit ? `<b>${cell}</b>` : cell);
        if (t.maxPullsPerUp != null) prev = t.maxPullsPerUp;
      }
      $('#h1').dataset.tipHtml = [
        `每 UP 均 ${cur} 抽 → ${esc(R.title.name)}`,
        '',
        ...rows,
        '',
        '按「角色池每 UP 均（含歪）」判档',
      ].join('\n');
    }

    const kpis = $('#kpi');
    kpis.innerHTML = '';
    for (const k of R.kpi) {
      const box = el('div', 'kpi');
      const v = el('div', 'v');
      v.textContent = k.value;
      if (k.unit) v.appendChild(el('small', null, k.unit));
      box.appendChild(v);
      box.appendChild(el('div', 'k', k.label));
      kpis.appendChild(box);
    }

    const meta = $('#meta');
    meta.innerHTML = '';
    const T = R.totals;
    const stat = (label, value) => {
      const s = el('span');
      s.appendChild(el('b', null, value));
      s.appendChild(document.createTextNode(' ' + label));
      return s;
    };
    // 标签里已含单位的（如「UP 池抽卡数」），值只写数字
    const statPlain = (label, num) => {
      const s = el('span');
      s.appendChild(el('b', null, String(num)));
      s.appendChild(document.createTextNode(' ' + label));
      return s;
    };
    /*
     * 次行三项：全账号总量 + 当前频道的两个结果。
     * 「S 级角色」用「代理人」是因为游戏里角色池抽的就是代理人；
     * 「UP 池抽卡数」去掉——2372 这个数字在下方 KPI「每 UP 角色」的语境里已经隐含。
     */
    // UP 数从各频道的官方 up_count 取；UP 角色/音擎本身都是 S，所以不必再写「S 级」
    const upOf = (key) => {
      const c = R.channels.find((x) => x.key === key);
      return Number(c?.stats?.upCount ?? 0);
    };
    meta.appendChild(stat('总抽卡数', `${T.pulls} 抽`));
    meta.appendChild(stat('S 级代理人', `${T.golds}`));
    meta.appendChild(stat('UP 代理人', `${R.metrics.upCount}`));
    const upWeapon = upOf('weapon_up');
    if (upWeapon) meta.appendChild(stat('UP 音擎', `${upWeapon}`));

    /*
     * 行尾只保留「区服 + 采集时间（含年份）」。
     * 去掉 region（prod_gf_cn）——对读者没有意义，排查问题时看 meta.json 即可；
     * 时间要带年份，跨年看报表时 MM-DD 会有歧义。
     */
    const tail = el('span', 'tail');
    const fetched = m.fetchedAt ? fmtTime(Date.parse(m.fetchedAt) / 1000) : '';
    tail.textContent = [m.serverLabel, fetched || null].filter(Boolean).join(' · ');
    meta.appendChild(tail);

    // 右上角仓库链接：指向报表来源，方便别人反查是怎么生成的
    const repo = CFG.copy?.repo;
    const link = $('#repo');
    if (link) {
      if (repo?.url) {
        link.href = repo.url;
        // 只替换文字节点，保留前面的 GitHub 图标
        const text = document.getElementById('repo-text');
        if (text) text.textContent = repo.label || repo.url;
        else link.textContent = repo.label || repo.url;
        link.title = repo.url;
      } else {
        link.remove();
      }
    }
  }

  // ------------------------------------------------------------------ tags

  /*
   * 标签行。
   * 图表区是 flex 撑满的，标签每多一行就压缩图表高度；
   * 超过两行会把柱体和图例挤在一起，所以超出部分折叠成「+N」，点开才展开。
   */
  // 只保留一行：第二行就会把图表压到 476px（1280 宽），柱体和图例开始打架
  const TAG_ROW_LIMIT = 1;
  let tagsExpanded = false;

  function renderTags() {
    const row = $('#tags');
    row.innerHTML = '';
    const makeTag = (t) => {
      const n = el('span', 'tag');
      n.dataset.tone = t.id === 'unlucky-aura' || t.id === 'bad-streak' || t.id === 'loss-streak'
        || String(t.id).startsWith('loss-streak-') ? 'negative'
        : t.id === 'multi-gold' ? 'neutral'
        : t.id === 'near-miss' ? 'info'
        : 'positive';
      n.appendChild(el('i', 'dot'));
      n.appendChild(document.createTextNode(t.name));
      n.dataset.tip = t.tip || t.name;
      if (t.bars && t.bars.length) n.dataset.bars = t.bars.join(';');
      return n;
    };

    for (const t of R.tags) row.appendChild(makeTag(t));

    /*
     * 标签直接换行，不折叠。
     * 之前做过「超过一行收进 +N」，但标签本身就是结论，藏起来等于让用户多点一次。
     * 图表区是 flex 撑满的，会自己让出高度；标签多时首屏可能变高，
     * 所以这里只保证不裁剪（flex-wrap: wrap），不做隐藏。
     */
  }

  // ----------------------------------------------------------------- chart

  let chart = null;
  const COLORS = CFG.colors;

  function tierOf(round, perUp) {
    if (round.total <= CFG.numbers.extremePulls) return 'extreme';
    return round.total > perUp ? 'bad' : 'good';
  }

  function tipLines(round, perUp, cumRate) {
    const T = CFG.copy.tip;
    const lines = [];
    const lead = round.side.length ? `${round.side.map((s) => s.name).join('、')} → ` : '';
    const losses = round.off > 0 ? '' : '';
    lines.push(`${lead}${round.name}`);
    lines.push(`卡池 v${round.version} · ${fmtTime(round.recordTime)}`);
    if (round.direct) {
      lines.push(fill(T.direct, { total: round.total }));
      if (round.side.length) lines.push(T.multiGoldRound);
      if (round.total < perUp) lines.push(T.nearMiss);
    } else if (round.guar) {
      lines.push(fill(T.guaranteed, { total: round.total, from: round.guarFrom }));
    } else {
      // 名字本身已带「」的（如「11号」）不再套一层，否则会出现「「11号」」
      const rawNames = round.lossNames || '';
      const names = /[「『]/.test(rawNames) ? rawNames : `「${rawNames}」`;
      lines.push(fill(T.lost, { total: round.total, off: round.off, names }));
    }
    lines.push(fill(T.winRate, { rate: cumRate }));
    return lines.filter(Boolean).join('\n');
  }

  function buildOption() {
    const rounds = R.chart.rounds;
    const perUp = R.metrics.pullsPerUp;
    const xLabels = rounds.map((r) => `v${r.version}`);
    const tiers = rounds.map((r) => tierOf(r, perUp));

    // 堆叠柱：下段 = off（歪掉的抽数），上段 = up（含十连副金）
    const offData = rounds.map((r, i) => ({
      value: r.off,
      itemStyle: { color: COLORS[tiers[i]].off },
      label: { show: r.off >= CFG.numbers.segmentLabelMin, color: '#fff' },
    }));
    const upData = rounds.map((r, i) => {
      const side = r.side.reduce((s, x) => s + x.count, 0);
      return {
        value: r.up + side,
        itemStyle: { color: COLORS[tiers[i]].top },
        label: { show: r.up >= CFG.numbers.segmentLabelMin, color: '#fff' },
      };
    });

    /*
     * 柱顶三层的垂直顺序（从下往上）：
     *   1. 柱体顶（r.total）
     *   2. 总抽数 —— 紧贴柱顶
     *   3. 头像栈 —— 摞在总抽数之上
     *
     * 头像层序：先出的在上、后出的在下（越早 = 越高）。
     * 顺序 [歪出…, UP, 十连副金]：歪的先出 → 最上层；UP 次之；十连副金在 UP 之后出 → 最下层。
     * 别把 UP 放最上层——那会让「歪了谁」在图上消失。
     */
    const ICON = 22;
    const ICON_STEP = 23;
    const LABEL_LINE = 18;   // 给总抽数留出的一行高度
    const avatarItems = [];
    rounds.forEach((r, i) => {
      // avatar 字段是 build-report 内嵌好的 data URL（不再依赖 assets 目录）
      const stack = [...r.losts.map((x) => x.avatar), r.avatar, ...r.side.map((x) => x.avatar)].filter(Boolean);
      stack.forEach((src, layer) => {
        avatarItems.push({
          value: [i, r.total],
          symbol: `image://${src}`,
          symbolSize: ICON,
          // 第一层要抬到「总抽数那一行」之上
          symbolOffset: [0, -(LABEL_LINE + ICON / 2 + 8 + layer * ICON_STEP)],
        });
      });
    });

    // 十连多金青点：落在它所属的那根柱上
    const dotItems = [];
    for (const g of R.chart.multiGold) {
      const idx = rounds.findIndex((r) => r.sort === g.sort || r.side.some((s) => s.sort === g.sort));
      const at = idx >= 0 ? idx : rounds.findIndex((r) => r.sort > g.sort);
      if (at >= 0) dotItems.push({ value: [at, rounds[at].total], symbolOffset: [11, -16] });
    }

    const maxTotal = Math.max(...rounds.map((r) => r.total), 1);
    const axisMax = Math.ceil((maxTotal + 18) / 30) * 30;

    return {
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
      grid: { left: 46, right: 48, top: 40, bottom: 30, containLabel: false },
      xAxis: {
        type: 'category',
        data: xLabels,
        axisLine: { lineStyle: { color: '#3a3a45' } },
        axisTick: { show: false },
        axisLabel: { color: '#8b8b96', fontSize: 10.5, margin: 8, interval: 0 },
      },
      yAxis: [
        {
          type: 'value',
          max: axisMax,
          splitLine: { lineStyle: { color: '#26262e' } },
          axisLabel: { color: '#6c6c78', fontSize: 10.5 },
        },
        {
          type: 'value',
          min: 0,
          max: 60,
          splitLine: { show: false },
          axisLabel: { color: '#6c6c78', fontSize: 10.5, formatter: '{value}%' },
        },
      ],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(255,255,255,0.04)' } },
        backgroundColor: '#0d0d10',
        borderColor: '#35353f',
        // formatter 返回纯文本，必须显式保留换行符，否则 ECharts 会把 \n 折叠成空格
        className: 'zzz-chart-tip',
        textStyle: { color: '#e8e8ee', fontSize: 11.5, lineHeight: 18 },
        extraCssText: 'white-space: pre; line-height: 18px; padding: 8px 11px; border-radius: 7px; box-shadow: 0 8px 24px rgba(0,0,0,.55);',
        formatter: (params) => {
          const i = params[0].dataIndex;
          return tipLines(rounds[i], perUp, R.chart.winRate[i]);
        },
      },
      series: [
        {
          name: 'off',
          type: 'bar',
          stack: 'cost',
          barWidth: '46%',
          data: offData,
          label: { position: 'inside', fontSize: 10, fontFamily: 'DM Mono, monospace' },
          emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1, shadowBlur: 8, shadowColor: 'rgba(245,192,74,0.35)' } },
        },
        {
          name: 'up',
          type: 'bar',
          stack: 'cost',
          data: upData,
          label: { position: 'inside', fontSize: 10, fontFamily: 'DM Mono, monospace' },
          emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1, shadowBlur: 8, shadowColor: 'rgba(245,192,74,0.35)' } },
        },
        {
          // 柱顶总成本：透明散点只为挂 label，不参与视觉。
          // 位置紧贴柱顶（在头像栈之下），不随头像层数变化——读者先看数、再看是谁。
          name: 'total',
          type: 'scatter',
          data: rounds.map((r, i) => ({
            value: [i, r.total],
            symbolOffset: [0, -LABEL_LINE / 2 + 1],
          })),
          symbolSize: 1,
          itemStyle: { color: 'transparent', borderWidth: 0 },
          label: {
            show: true,
            position: 'top',
            distance: 1,
            color: '#e8e8ee',
            fontSize: 11,
            fontFamily: 'DM Mono, monospace',
          },
          z: 3,
          tooltip: { show: false },
        },
        {
          name: 'avatar',
          type: 'scatter',
          data: avatarItems,
          itemStyle: { borderWidth: 0 },
          z: 4,
          tooltip: { show: false },
        },
        {
          name: 'multiGold',
          type: 'scatter',
          data: dotItems,
          symbolSize: 6,
          itemStyle: { color: COLORS.multiGoldDot, borderWidth: 0 },
          z: 5,
          tooltip: { show: false },
        },
        {
          name: 'winRate',
          type: 'line',
          yAxisIndex: 1,
          data: R.chart.winRate,
          symbol: 'none',
          lineStyle: { color: COLORS.winRateLine, width: 1.4 },
          z: 2,
          tooltip: { show: false },
        },
      ],
    };
  }

  function renderChart() {
    if (typeof echarts === 'undefined') return;
    // 面板右上角：N 个 UP · N 抽
    const meta = $('#chart-meta');
    if (meta) meta.textContent = fill(CFG.copy.titleRowMeta, { upCount: R.metrics.upCount, pulls: R.metrics.pulls });
    chart = echarts.init($('#chart'), null, { renderer: 'svg' });
    chart.setOption(buildOption());

    /*
     * 版本分隔线：曾经用贯穿全图的竖虚线，但柱顶头像是"摞在柱子上方"的，
     * 竖线一定会插进头像和总抽数里，视觉噪音大于信息量。
     * 横轴本身是按版本标注的（v1.0 / v1.1 / ...），已经能看出分界，
     * 所以不再画分隔线。
     */

    // 标签联动高亮
    $('#tags').addEventListener('mouseenter', (e) => {
      const tag = e.target.closest('.tag');
      if (!tag || !tag.dataset.bars) return;
      const ranges = tag.dataset.bars.split(';').filter(Boolean).map((s) => s.split('-').map(Number));
      const indices = [];
      for (const [a, b] of ranges) for (let i = a; i <= b; i += 1) indices.push(i);
      chart.dispatchAction({ type: 'highlight', seriesIndex: [0, 1], dataIndex: indices });
      chart.setOption({
        series: [
          {
            markArea: {
              silent: true,
              itemStyle: { color: 'rgba(240,240,241,0.07)' },
              data: ranges.map(([a, b]) => [{ xAxis: a - 0.5 }, { xAxis: b + 0.5 }]),
            },
          },
        ],
      });
    }, true);

    $('#tags').addEventListener('mouseleave', (e) => {
      const tag = e.target.closest('.tag');
      if (!tag || !tag.dataset.bars) return;
      chart.dispatchAction({ type: 'downplay', seriesIndex: [0, 1] });
      chart.setOption({ series: [{ markArea: { data: [] } }, {}, { markLine: { data: [] } }] });
    }, true);

    window.addEventListener('resize', () => chart && chart.resize());
  }

  // --------------------------------------------------------------- 详情

  const detailState = { channel: CFG.channels[0].id, merged: false };

  function renderDetail() {
    const tabs = $('#detail-tabs');
    tabs.innerHTML = '';
    for (const ch of R.channels) {
      const b = el('button', 'detail-tab', ch.detailLabel);
      b.setAttribute('role', 'tab');
      b.dataset.id = String(ch.id);
      b.setAttribute('aria-selected', String(ch.id === detailState.channel));
      b.addEventListener('click', () => {
        detailState.channel = ch.id;
        renderDetail();
      });
      tabs.appendChild(b);
    }

    const ch = R.channels.find((c) => c.id === detailState.channel) || R.channels[0];
    const d = R.details[ch.id];
    const merged = detailState.merged && ch.has5050;
    const rows = merged ? d.merged : d.all;

    const toggle = $('#merge');
    toggle.checked = merged;
    toggle.disabled = !ch.has5050;
    toggle.closest('.merge-toggle').dataset.disabled = String(!ch.has5050);

    $('#detail-meta').textContent = merged
      ? fill(CFG.copy.detailMetaMerged, { upCount: d.merged.length, perUp: (ch.stats.upAvg || 0).toFixed(1) })
      : fill(CFG.copy.detailMetaAll, { goldCount: d.all.length, perGold: d.perGold ? ch.stats.pulls === undefined ? '—' : (d.perGold).toFixed(1) : '—' });

    const list = $('#detail-list');
    list.innerHTML = '';
    if (!rows.length) {
      list.appendChild(el('div', 'detail-empty', CFG.copy.detailEmpty));
      return;
    }

    // 按版本分组（已是时间倒序）
    const groups = [];
    for (const row of rows) {
      const last = groups[groups.length - 1];
      if (last && last.version === row.version) last.rows.push(row);
      else groups.push({ version: row.version, rows: [row] });
    }

    const maxPulls = 100;
    for (const g of groups) {
      const wrap = el('div', 'detail-group');
      const bracket = el('div', 'detail-bracket');
      const ver = el('div', 'detail-ver');
      ver.textContent = `v${g.version}`;
      const rowsBox = el('div', 'detail-rows');

      for (const row of g.rows) {
        const line = el('div', 'detail-row');
        const img = el('img', 'detail-icon');
        img.src = row.icon || '';
        img.alt = '';
        // 不用 loading="lazy"：图标只有 96px，但懒加载会让截图/打印时还没滚到的行是空白。
        // icon 已内嵌成 data URL，缺失时 build-report 会替换成占位图。

        const track = el('div', 'detail-track');
        const bar = el('div', 'detail-bar');
        const good = row.pulls <= (ch.perGold || Infinity);
        bar.dataset.side = good ? 'good' : 'bad';
        // 条长 = 抽数/100 的轨道占比（78 抽 ≈ 78%），保底 44px，给右侧歪章留出空间
        const pct = Math.max(0, Math.min(1, row.pulls / CFG.numbers.detailBarDivisor));
        bar.style.width = `max(${CFG.numbers.detailBarMinPx}px, calc((100% - 34px) * ${pct.toFixed(4)}))`;
        bar.textContent = `${row.pulls}抽`;
        track.appendChild(bar);

        if (ch.has5050) {
          const stamp = el('div', 'detail-stamp', row.stamp ? '歪' : '');
          if (!row.stamp) stamp.dataset.empty = 'true';
          track.appendChild(stamp);
        }

        line.appendChild(img);
        line.appendChild(track);
        line.dataset.tip = buildRowTip(row, ch, merged);
        rowsBox.appendChild(line);
      }

      wrap.appendChild(bracket);
      wrap.appendChild(ver);
      wrap.appendChild(rowsBox);
      list.appendChild(wrap);
    }
  }

  function buildRowTip(row, ch, merged) {
    const lines = [row.name, `v${row.version} · ${fmtTime(row.recordTime)}`];
    if (!ch.has5050) {
      lines.push(`距上一金 ${row.pulls} 抽`);
    } else if (!merged) {
      lines.push(`距上一金 ${row.pulls} 抽 · ${row.isUp ? 'UP' : '歪'}`);
    } else if (row.off > 0) {
      // 「歪出」要读 losts（真正歪掉的角色），不是 side（十连副金）
      const lost = (row.losts || []).map((x) => `${x.name} ${x.count} 抽`).join('、');
      const extra = (row.side || []).map((x) => `十连副金 ${x.name} ${x.count} 抽`).join('、');
      lines.push(`本轮 ${row.pulls} 抽 ＝ UP ${row.up} + 歪 ${row.off}`);
      lines.push(`歪出：${[lost, extra].filter(Boolean).join('、') || '—'}`);
    } else if ((row.side || []).length) {
      lines.push(`本轮 ${row.pulls} 抽 · 无歪 · 十连副金 ${(row.side || []).map((x) => x.name).join('、')}`);
    } else {
      lines.push(`本轮 ${row.pulls} 抽 · 无歪`);
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------------- tooltip

  function setupTip() {
    const tip = el('div', 'tip');
    document.body.appendChild(tip);
    let active = null;

    const place = (ev) => {
      const pad = 12;
      const r = tip.getBoundingClientRect();
      let x = ev.clientX + pad;
      let y = ev.clientY + pad;
      if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
      if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
      tip.style.left = `${Math.max(8, x)}px`;
      tip.style.top = `${Math.max(8, y)}px`;
    };

    document.addEventListener('mouseover', (ev) => {
      const t = ev.target.closest('[data-tip],[data-tip-html]');
      if (!t) return;
      active = t;
      // 标题档位表用 data-tip-html（需要加粗当前档）；其余一律纯文本，避免 XSS 面
      if (t.dataset.tipHtml != null) tip.innerHTML = t.dataset.tipHtml;
      else tip.textContent = t.dataset.tip;
      tip.classList.add('on');
      place(ev);
    });
    document.addEventListener('mousemove', (ev) => {
      if (!active) return;
      place(ev);
    });
    document.addEventListener('mouseout', (ev) => {
      const t = ev.target.closest('[data-tip],[data-tip-html]');
      if (!t || (ev.relatedTarget && t.contains(ev.relatedTarget))) return;
      active = null;
      tip.classList.remove('on');
    });
  }

  // ------------------------------------------------------------------ box

  function renderLegend() {
    const box = $('#legend');
    box.innerHTML = '';
    const vars = {
      extremePulls: CFG.numbers.extremePulls,
      goldCount: R.metrics.goldCount,
      multiGoldRounds: R.metrics.multiGoldRounds,
    };
    // 色块按配置里的 key 取色，图例顺序变化不会错位
    const swatchColor = {
      bad: COLORS.bad.top,
      badOff: COLORS.bad.off,
      extreme: COLORS.extreme.top,
      good: COLORS.good.top,
      line: COLORS.winRateLine,
      dot: COLORS.multiGoldDot,
    };

    for (const item of CFG.copy.legend ?? []) {
      const line = typeof item === 'string' ? { text: item } : item;
      const s = el('span');
      const color = swatchColor[line.swatch];
      if (color) {
        const sw = el('i', 'swatch');
        sw.style.background = color;
        s.appendChild(sw);
      }
      s.appendChild(document.createTextNode(fill(line.text, vars)));
      box.appendChild(s);
    }

    if (CFG.copy.legendTail) {
      box.appendChild(el('span', 'legend-tail', fill(CFG.copy.legendTail, vars)));
    }
  }

  function init() {
    renderHeader();
    renderTags();
    renderLegend();
    renderChart();
    renderDetail();
    setupTip();

    $('#eye').addEventListener('click', () => {
      privacy.state = (privacy.state + 1) % 3;
      renderHeader();
      // 标签页标题也跟着走，避免标题里泄露未打码的昵称
      document.title = `${R.meta.nickname ? displayName(R.meta.nickname) : '绝区零'} · 调频统计`;
    });

    /*
     * 主图折叠（默认展开，折叠纯属截图辅助）。
     * 展开时不重建图表，只让 ECharts 重算一次尺寸：
     *   #chart 的 display 始终是 block，折叠只是让外层容器高度归零，
     *   所以重新展开后容器尺寸恢复，resize() 就能把画布还原，不需要 renderChart()。
     */
    $('#collapse-chart').addEventListener('click', () => {
      const panel = $('.chart-panel');
      const screen = $('.screen');
      const btn = $('#collapse-chart');
      const collapsed = panel.classList.toggle('collapsed');
      screen.classList.toggle('chart-collapsed', collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.querySelector('.collapse-text').textContent = collapsed ? '展开' : '收起';
      if (!collapsed && chart) {
        // 等布局恢复后再量尺寸
        requestAnimationFrame(() => chart.resize());
      }
    });

    $('#merge').addEventListener('change', (e) => {
      detailState.merged = e.target.checked;
      renderDetail();
    });

    // 初版把标题一律打码，会和页面的「全显示」状态不一致；改为跟随开关
    document.title = `${R.meta.nickname ? displayName(R.meta.nickname) : '绝区零'} · 调频统计`;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
