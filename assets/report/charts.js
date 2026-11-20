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
  /*
   * 图标去重表：数据里只存 hash（avatarKey / iconKey），真正 base64 在 R.icons 里各存一份。
   * 这张表把 232 次内嵌压成 74 份，HTML 从 3.7 MB 降到 2.0 MB，读图行为完全一致。
   */
  const ICONS = R.icons || {};
  const iconOf = (key) => (key && ICONS[key]) || '';

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
      /*
       * 颜色来自 config.tags.tone（构建时已经按 tone 名解析成色值写进每个 tag），
       * 不再依赖 CSS 里再写一份同义的色值——否则改配置里的正/负向颜色不会生效。
       * 用 style.color 直接给值，CSS 的 data-tone 只保留兜底。
       */
      if (t.tone) n.style.color = t.tone;
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
      // avatarKey 是构建时算的图标 hash，iconOf() 从 R.icons 取出 data URL（不再依赖 assets 目录）
      const stack = [...r.losts.map((x) => iconOf(x.avatarKey)), iconOf(r.avatarKey), ...r.side.map((x) => iconOf(x.avatarKey))].filter(Boolean);
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
    /*
     * 不歪率右轴上限按数据定，不写死 60%。
     * 写死的话，比这个账号更欧的曲线会顶到框外被截断（50% 的号看不出来，70% 的号就会）。
     * 规则：峰值向上取整到 10 的倍数，留 10% 头部空间，但上限不超过 100
     * （不歪率是百分比，110% 的坐标轴会被读成 bug）。
     */
    const winPeak = Math.max(0, ...R.chart.winRate);
    const winMax = Math.min(100, Math.max(10, Math.ceil((winPeak + 10) / 10) * 10));
    /*
     * 右轴下限留一点负向余量，别让 0% 贴死底边。
     *
     * 为什么：开局的累计不歪率是 0%（还没赢过），这段线正好画在 grid 底边上，
     * 和灰色 x 轴基线重合，1.4px 的描边再被 grid 裁掉一半 —— 结果就是
     * 「折线开头没了」。用户看到的是一个从中间才开始的曲线，会以为数据缺了。
     * 留 -4% 的余量后，0% 这条线落在底边上方，整条曲线自始至终可见。
     */
    const winMin = -Math.max(2, Math.round(winMax * 0.04));

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
          min: winMin,
          max: winMax,
          splitLine: { show: false },
          /*
           * 负刻度只是为了让 0% 的线不贴死底边（见上面 winMin），
           * 但「-2%」这种刻度对读者没有意义，直接不显示。
           */
          axisLabel: {
            color: '#6c6c78',
            fontSize: 10.5,
            formatter: (v) => (v < 0 ? '' : `${v}%`),
          },
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
          /*
           * z 必须高于柱子。
           * 柱子没显式设 z（默认 2），折线早先也是 2 —— 同级时折线会被柱子压在下面，
           * 曲线一进到柱体里就消失，看起来像「数据从中间才开始」。
           * 3：压过两根柱子，又低于头像（4）与双金点（5），不会骑到角色脸上。
           */
          z: 3,
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
      /*
       * 空频段也要画垫抽行：音擎回响正是「垫了 12 抽、一金未出」的典型，
       * 只显示「这个频段还没有 S 级记录」等于把唯一有信息量的数藏起来了。
       */
      const pityOnly = buildPityRow(ch.pity);
      if (pityOnly) list.appendChild(pityOnly);
      const empty = el('div', 'detail-empty', CFG.copy.detailEmpty);
      list.appendChild(empty);
      return;
    }

    // 按版本分组（已是时间倒序）
    const groups = [];
    for (const row of rows) {
      const last = groups[groups.length - 1];
      if (last && last.version === row.version) last.rows.push(row);
      else groups.push({ version: row.version, rows: [row] });
    }

    /*
     * 垫抽行放在**最新版本组的内部、第一行**，不是列表外面。
     *
     * 原因纯排版：外面那一层没有版本括号的缩进（1px 括号 + 7px gap + 版本号宽度），
     * 放外面会比下面的头像整体左移 42px，一眼就能看出没对齐。
     * 放进去后问号块和头像、绿条和红条都落在同一列。
     */
    const pityRow = buildPityRow(ch.pity);
    if (pityRow && groups.length) groups[0].rows.unshift({ __pity: true });

    for (const g of groups) {
      const wrap = el('div', 'detail-group');
      const bracket = el('div', 'detail-bracket');
      const ver = el('div', 'detail-ver');
      ver.textContent = `v${g.version}`;
      const rowsBox = el('div', 'detail-rows');

      for (const row of g.rows) {
        if (row.__pity) { rowsBox.appendChild(pityRow); continue; }
        const line = el('div', 'detail-row');
        const img = el('img', 'detail-icon');
        img.src = iconOf(row.iconKey);
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

  // -------------------------------------------------------------- 垫抽

  /*
   * 垫抽行：正文里的一行，不是标题上的数字。
   *
   * 造型照官方调频页：左边一个金色问号方块（还没出的那个 S 是谁 = 未知），
   * 右边一条绿色斜纹进度条，条内写「已垫 N 抽」。
   *
   * 为什么放进正文而不是面板头：
   *   1) 它是「这一档还差多少」的状态，和下面每一金的横条是同一套读法——条长＝进度；
   *   2) 面板头要挤 6 个 tab + 勾选框 + meta，再塞一条进度条会两边都看不清；
   *   3) 玩家在详情里逐金往上翻，最后看到的就是「垫到哪了」，顺序天然对。
   *
   * 数据来自 index.json 的 type_stats[].next_s_cur_times，构建时已算好
   * {cur, cap, remain, pct, last}；前端只负责画，不重复算。
   */
  function buildPityRow(pity) {
    if (!pity || pity.cap == null || !pity.cur) return null;

    const row = el('div', 'detail-row pity-row');

    // 问号方块：下一个 S 未知，所以画「?」而不是头像
    const tile = el('div', 'pity-tile');
    tile.textContent = '?';
    tile.setAttribute('aria-hidden', 'true');

    const track = el('div', 'detail-track');
    const bar = el('div', 'detail-bar pity-bar');
    // 条长＝进度占比，与详情其他横条同一套「长度即数值」的读法
    const pct = Math.max(0, Math.min(1, (pity.pct ?? 0) / 100));
    bar.style.width = `max(${CFG.numbers.detailBarMinPx}px, calc((100% - 34px) * ${pct.toFixed(4)}))`;
    bar.textContent = `已垫${pity.cur}抽`;
    track.appendChild(bar);

    row.appendChild(tile);
    row.appendChild(track);
    // 剩 ≤ 10 抽就该变红：马上就要出了
    row.dataset.near = String(pity.remain != null && pity.remain <= 10);

    const last = pity.last
      ? `\n上一个 S：${pity.last.name}${pity.last.version ? `（v${pity.last.version}）` : ''}`
      : '';
    row.dataset.tip = `已垫 ${pity.cur} 抽，还差 ${pity.remain ?? '—'} 抽到保底（${pity.cap} 抽保底）${last}`;
    return row;
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
