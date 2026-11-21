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
      /*
       * highlight（最长连 UP / 十连多金）除了颜色更亮，再加一层外发光。
       *
       * 只调亮度不够：这两个色在暗底上肉眼几乎分不出（实测 #F5C04A vs #FFE066 只差一点）。
       * 发光用同色低透明度 box-shadow，在深色背景上形成清晰的光晕，
       * 一眼就能看出「这条比旁边那几条更值得看」。
       * 是否 highlight 由构建时的色值判定——前端不重复维护一份标签 id 名单。
       */
      if (t.tone && t.tone.toLowerCase() === String(CFG.tags?.tone?.highlight?.color || '').toLowerCase()) {
        n.dataset.highlight = 'true';
      }
      n.appendChild(el('i', 'dot'));
      n.appendChild(document.createTextNode(t.name));
      n.dataset.tip = t.tip || t.name;
      if (t.bars && t.bars.length) n.dataset.bars = t.bars.join(';');
      /*
       * 十连多金的柱子定位：存「频道内 sort 序号」，不存柱位下标。
       *
       * 存下标不行——`multiGold` 是角色池 + 音擎合并的，两边 round 编号各算各的；
       * 而主图一次只画一个频道。存 sort 让前端按当前频道现算，切 tab 后仍然对得上。
       * 当前频道里没有的那些（比如在音擎、而此刻看的是独家）会被自动跳过。
       */
      if (t.multiGoldSorts && t.multiGoldSorts.length) n.dataset.goldSorts = t.multiGoldSorts.join(';');
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

  /*
   * 理论每 UP 期望抽数：62.5 抽/金 × 1.5（50/50）= 93.75。
   *
   * 提到模块作用域（而不是放在 buildOption 里），因为图例也要用它：
   * 图例那条「灰虚线＝理论基准（…）」需要把具体数值写进文案。
   * 放在 buildOption 内会让 renderLegend 拿到 undefined —— 表现为整块图变白。
   *
   * 这是**理论上限**，不是「这个账号自己的均值」：
   *   - 判档（红绿柱子）：跟账号自己的 perUp 比，回答「这段时间比平时好还是差」
   *   - 基准线（灰虚线）：跟理论期望比，回答「比理论好还是差」
   * 两套基准都成立，互不替代。低于这个值算欧（抽得少），所以它是上限线。
   */
  const perUpBaseline = Number(CFG.numbers.sPityExpect) > 0 && Number(CFG.numbers.fiftyFifty) > 0
    ? Math.round(Number(CFG.numbers.sPityExpect) * Number(CFG.numbers.fiftyFifty) * 10) / 10
    : null;

  /*
   * 主图状态。
   *   channel —— 当前画哪个频段（独家 / 音擎 …），对应 R.charts 里的一项
   *   majors  —— 版本主版本过滤，**默认全选**（全选＝不过滤，全显示）
   *
   * 为什么用「全选」而不是「空集合」表示不过滤：
   *   初始状态要让读者一眼看出「能筛什么、现在筛了什么」。
   *   空集合的表现是三颗灰 chip，看起来像「什么都没选、图是空的」，
   *   与实际情况（全部显示）相反。全选才是「不筛」的直观表达。
   *   全部取消时依然回到全显示，而不是画空图。
   *
   * 两个状态共同决定画哪些柱子。过滤放在前端而不是构建时，
   * 是因为它是「看报表的人当场想收窄视野」，不是数据口径——
   * 构建时过滤会让「N 个 UP · N 抽」这些数字和柱子对不上。
   */
  const chartState = {
    channel: R.charts[0]?.channelId ?? null,
    majors: new Set(R.versionFilters ?? []),
  };

  const currentChart = () => R.charts.find((c) => c.channelId === chartState.channel) || R.charts[0];

  /**
   * 按版本过滤后，还要哪些柱。
   * 返回原 rounds 的下标数组——头像、歪出、多金点都按下标引用，
   * 所以过滤只能挑下标，不能先筛数据再重建（那样图标栈会错位）。
   */
  function visibleIndices(c) {
    const all = R.versionFilters ?? [];
    // 全选（或一个都没选）＝不过滤：全选是默认状态，全不选是「什么都想看的反向确认」
    if (!chartState.majors.size || (all.length && chartState.majors.size >= all.length)) {
      return c.rounds.map((_, i) => i);
    }
    return c.rounds
      .map((r, i) => i)
      .filter((i) => chartState.majors.has(String(c.rounds[i].version ?? '').split('.')[0]));
  }

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
    const c = currentChart();
    const all = c.rounds;
    const perUp = c.perUp;
    /*
     * 只画可见的柱子，但下标沿用原数组。
     *
     * 过滤后柱子会变少，如果先筛数组再按新下标取数据，
     * 头像栈（按 rounds 下标叠）和多金点（按 sort 找柱）都会错位到别的柱上。
     * 所以这里保持「下标 = 原 rounds 下标」不变，只跳过被过滤掉的。
     */
    const idxs = visibleIndices(c);
    const rounds = idxs.map((i) => all[i]);
    const tiers = rounds.map((r) => tierOf(r, perUp));

    /*
     * 横轴版本标签去重：同一版本的多根柱只在中间标一次。
     *
     * 一个版本抽得多时同版本会连出好几根柱，逐柱写 v2.0 就是「v2.0 v2.0 v2.0」一片，
     * 既读不出它们同属一个版本，也挤掉了相邻真正不同的版本。
     * 现在按连续段分组，只在组中点写版本号；组与组之间用刻度线分出边界。
     */
    /*
     * 版本号**不再写进 x 轴的 axisLabel**，改由 versionRange 用 custom 画
     * （axisLabel 只能挂在某个类目中心，2 根柱时做不到真正的居中间）。
     * 这里保留一个全空数组：类目轴仍然需要 N 个类目占位，否则柱子会挤在一起。
     */
    const xLabels = new Array(rounds.length).fill('');
    const groups = [];
    let cursor = 0;
    while (cursor < rounds.length) {
      const version = rounds[cursor].version;
      let end = cursor;
      while (end + 1 < rounds.length && rounds[end + 1].version === version) end += 1;
      groups.push({ version, from: cursor, to: end });
      cursor = end + 1;
    }
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

    /*
     * 十连多金青点：落在它所属的那根柱上。
     * 点的直径按金数放大——2 金 6px、3 金 8px、4 金 10px。
     * 全是同尺寸的话，「两次双金」和「一次三金」在图上长得一模一样。
     *
     * `sortToBar` 把「金在频道内的 sort 序号」映射成柱位，是这条链路上唯一的换算入口：
     * 青点位置、以及标签悬浮高亮（multigold 标签 → 柱子）都从这里取。
     * 两处若各写一份，迟早会漂——青点在 A 柱、高亮圈住 B 柱，而两边都不报错。
     *
     * 为什么不能直接用 `r.sort`：多金组的最后一金可能是「十连副金」，
     * 它不属于任何 round 的 sort，只记录在某一轮的 `side[]` 里。
     * 所以两种都要比：本轮 UP 本身，或本轮带出的副金。
     */
    const barSortOf = (sort) => all.findIndex(
      (r) => r.sort === sort || r.side.some((s) => s.sort === sort),
    );
    const dotItems = [];
    for (const g of c.multiGold) {
      const idx = barSortOf(g.sort);
      if (idx < 0) continue;
      const at = idxs.indexOf(idx);
      if (at < 0) continue;   // 这根柱被版本过滤掉了
      dotItems.push({
        value: [at, all[idx].total],
        symbolSize: 4 + (g.size ?? 2) * 1,
        symbolOffset: [11, -16],
      });
    }

    /*
     * 左轴上限**按频道固定**，不随数据自适应。
     *
     * 自适应的问题：同一个账号不同频道、或两个账号之间，纵轴刻度不一样，
     * 横向对比就没有基准了——天猪号最高柱 159、音擎最高 137，
     * 自适应后两张图的柱子看起来一样高，读者读不出「谁更高」。
     *
     * 固定值来自「该频道保底抽数 × 2」：
     * 一轮 UP 的成本最多是「先歪一次（吃保底）+ 再吃保底」，也就是 2 倍保底。
     * 角色池/常驻/复刻 90 × 2 = 180；音擎/回响/邦布 80 × 2 = 160。
     * 实测最大柱 159 / 137，都落在框内，不会截断。
     */
    const pullsMaxByChannel = CFG.numbers.axisPullsMax ?? {};
    const axisMax = pullsMaxByChannel[c.key]
      ?? Math.ceil((Math.max(...rounds.map((r) => r.total), 1) + 18) / 30) * 30;
    /*
     * 不歪率右轴上限**固定**，和左轴同一套写法：先读配置，读不到才回退自适应。
     *
     * 为什么必须固定：不歪率的理论范围就是 0~100%，没有按数据缩放的道理。
     * 自适应会让 56% 的号和 80% 的号在图上看起来差不多高，跨图、跨频道都没法比；
     * 更糟的是 35% / 50% 这两条分档线会随账号浮动，同一个 48% 在两张图上落在不同高度。
     * 固定之后分界线在任何一张图上都同高，档位读法统一。
     *
     * **这里曾经退回过一次**：左轴改成了「先读配置」，右轴漏了这半句，只留下自适应，
     * 于是角色池显 60%、音擎显 80%。因为复刻角色那栏峰值恰好 100%、自适应出来也是 100%，
     * 只看那一张图会以为没问题——验这个必须六个频道全验，别只看一张。
     * 回归防线在 references/report-rules.md §9.3：构建后断言所有频道的右轴上限 === 配置值。
     *
     * 自适应保留作配置缺省时的兜底（不是死代码）：没配 axisWinRateMax 的旧配置仍然出得来图。
     */
    const wins = rounds.length ? c.winRate.filter((_, i) => idxs.includes(i)) : [];
    const winPeak = Math.max(0, ...wins);
    const winMax = CFG.numbers.axisWinRateMax
      ?? Math.min(100, Math.max(10, Math.ceil((winPeak + 10) / 10) * 10));
    /*
     * 右轴下限就是 0，和 x 轴基线对齐。
     *
     * 不抬到负值：0% 读作「一次都没赢过」，它本来就该坐在基线上。
     * 早先为了「让线可见」加了 -4% 余量，那是拿语义去换可见性——
     * 短线被抬离基线，读者反而要猜「这条线到底是不是 0」。
     *
     * 可见性改用另外两个手段解决，都不动坐标语义：
     *   1) 折线启用 clip:false，描边贴在底边时也不会被 grid 裁掉一半；
     *   2) 给折线加 y 向 symbolOffset 抬 1px，让 1.4px 的线压在基线上方而不是正中。
     */
    const winMin = 0;

    return {
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
      /*
       * bottom 要容下版本号 + 横线两层：文字中心在轴下 11（到 16.25 才完）、横线在 22。
       * 留 30：横线下方还有 8px 余量，不会贴边。
       * 这两层都画在轴下方、不在绘图区内，留少了会被 grid 直接裁掉。
       */
      grid: { left: 46, right: 48, top: 40, bottom: 30, containLabel: false },
      xAxis: {
        type: 'category',
        data: xLabels,
        axisLine: { lineStyle: { color: '#3a3a45' } },
        /*
         * 每根柱下一个短刻度：标签去重后，刻度是唯一还能看出「这是另一根柱」的东西。
         *
         * 组与组之间的边界不靠加长 tick 表达——tick 长了会和下一个版本的 tick 视觉粘连，
         * 也看不出「这几根属于同一组」。改用轴下方的版本范围线（见下面 versionRange 系列）。
         */
        axisTick: {
          show: true,
          interval: 0,
          length: 3,
          lineStyle: { color: '#3a3a45' },
        },
        axisLabel: {
          /*
           * 关闭轴自带标签：版本号改由下面的 versionRange 用 custom 画。
           *
           * 原因：axisLabel 只能把文字挂在某个类目的中心，
           * 而 2 根柱的版本中点在两根柱之间（x.5），挂在任一根上都偏半格。
           * 想让版本号真正垂直居中于括号，必须自己算 x 坐标画。
           */
          show: false,
        },
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
          return tipLines(rounds[i], perUp, wins[i]);
        },
      },
      series: [
        {
          name: 'off',
          type: 'bar',
          stack: 'cost',
          /*
           * 柱宽按类目带宽的 46%，但必须有像素上限。
           *
           * barWidth 的百分比是「类目带宽」的比例，不是画布比例：
           * 只有 1 根柱时类目带宽就是整个绘图区，46% 会变成 600px 宽的巨型色块
           * （实测复刻角色页就是 600px，而 71 根柱时每根只有 96px）。
           * 上限走配置，改配置就生效，不在样式里另写死数。
           */
          barWidth: '46%',
          barMaxWidth: CFG.numbers.barMaxWidth,
          data: offData,
          label: { position: 'inside', fontSize: 10, fontFamily: 'DM Mono, monospace' },
          emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1, shadowBlur: 8, shadowColor: 'rgba(245,192,74,0.35)' } },
        },
        {
          name: 'up',
          type: 'bar',
          stack: 'cost',
          // 与 off 段同宽：同一根柱的两段宽度不一致会错位成阶梯形
          barMaxWidth: CFG.numbers.barMaxWidth,
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
          itemStyle: { color: COLORS.multiGoldDot, borderWidth: 0 },
          z: 5,
          tooltip: { show: false },
        },
        {
          name: 'winRate',
          /*
           * 不歪率折线：**按 35% 这条线分色，蓝＝好、红＝差**。
           *
           * 用 custom 手动画线段，不用 line + visualMap：
           *   visualMap 的 pieces 是「按数据点」判色，ECharts 会在相邻两点之间
           *   用两点各自的颜色做渐变过渡——想要的是「30% → 40% 这整段连线是蓝色」，
           *   visualMap 做不到（它会在两点间混色）。
           *   自己画线段就能按「这一段有没有碰到 35% 以上」整段定色。
           *
           * 判定：取两端较大的那个值。只要这段线有任何一头在 35% 之上，
           * 整段就是蓝的——这正是「一个点在 30、下一个在 40，连线应该是蓝色」。
           * 两端都在 35% 以下才是红色。
           */
          type: 'custom',
          yAxisIndex: 1,
          data: wins.map((v, i) => [i, v]),
          clip: false,
          /*
           * z 必须高于柱子。
           * 柱子没显式设 z（默认 2），折线早先也是 2 —— 同级时折线会被柱子压在下面，
           * 曲线一进到柱体里就消失，看起来像「数据从中间才开始」。
           * 3：压过两根柱子，又低于头像（4）与多金点（5），不会骑到角色脸上。
           */
          z: 3,
          tooltip: { show: false },
          renderItem: (params, api) => {
            const i = params.dataIndex;
            const v1 = wins[i];
            if (v1 == null) return null;
            /*
             * 三档：按不歪率分段着色，档位来自 config.numbers.winRateTiers。
             *   < 35%  非酋  红
             *   35~50% 薛定谔 灰（还没定型）
             *   >= 50% 大欧  蓝
             *
             * 50% 是 50/50 的理论期望，天然是「欧」的分界；
             * 35% 是「明显低于随机」的位置，用来标出真的差的段落。
             * 两档之间的灰不是「不好」，而是「还在波动中、看不出结论」。
             */
            const tiers = CFG.numbers.winRateTiers ?? [
              { max: 35, key: 'unlucky' },
              { max: 50, key: 'shrodinger' },
              { max: null, key: 'lucky' },
            ];
            const TIER_COLOR = {
              unlucky: COLORS.winRateUnlucky,
              shrodinger: COLORS.winRateSchrodinger,
              lucky: COLORS.winRateLucky,
            };
            // 落档：第一个 max 还没到头（或 max 为 null）的档
            const colorOf = (v) => {
              const hit = tiers.find((t) => t.max == null || v < t.max) ?? tiers[tiers.length - 1];
              return TIER_COLOR[hit.key] ?? COLORS.winRateSchrodinger;
            };
            const a = api.coord([i, v1]);
            const children = [];
            /*
             * 描边（halo）：同一段画两遍，先粗后细，粗的那遍用深色。
             *
             * **为什么必须加**：折线是提亮版，压在**同类柱子上**仍然看不清——
             * 实测红折线压红柱 1.31:1、绿压绿 2.30:1、蓝压蓝 1.80:1，三个全部低于 3:1。
             * 柱子本身是「歪掉的抽数 / UP 抽数」的语义，不能为折线让路；
             * 换更亮的线色也只解决绿档（红蓝还是低）。
             * 加一圈深色轮廓，三档一次解决，且保住红/绿/蓝的语义。
             *
             * 为什么是 4.6px 而不是 3px：
             * 彩色线 1.4px，描边两侧各露出 (W - 1.4) / 2。
             * 取 3px 时每侧只有 0.8px——**亚像素**，屏幕上一个像素里有 80% 描边色 +
             * 20% 柱色，抗锯齿直接把它混成一团。实测紧邻像素对比度只有 1.09~1.47:1，
             * 和没加描边（1.31）几乎一样，等于白加。
             * 取 4.6px 时每侧 1.6px，能保证至少一整像素是纯描边色，
             * 实测紧邻对比度才真正上到 6.8~8.7:1。
             *
             * 再粗就会把柱子挖掉一条明显的黑沟，4.6 是「刚好一个实心像素」的下限。
             *
             * 为什么描边色取深色而不是半透明黑：半透明会吃进柱子的色相，
             * 在红柱上偏红、在绿柱上偏绿，三档分开后就又不一致了。
             *
             * `lineCap: 'round'` 两端都圆：线段是一段一段画的，方头会让每段接缝处
             * 出现一个比线宽略窄的缺口，虚线感明显。
             */
            const HALO = COLORS.winRateHalo;
            if (i + 1 < wins.length && wins[i + 1] != null) {
              const v2 = wins[i + 1];
              const b = api.coord([i + 1, v2]);
              if (HALO) {
                children.push({
                  type: 'line',
                  shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] },
                  style: { stroke: HALO, lineWidth: 4.6, lineCap: 'round' },
                });
              }
              children.push({
                type: 'line',
                shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] },
                style: { stroke: colorOf(Math.max(v1, v2)), lineWidth: 1.4, lineCap: 'round' },
              });
            }
            // 圆点：同样两遍。描边圆的半径要比线宽半径大 1.6，才盖得住线头
            if (HALO) {
              children.push({
                type: 'circle',
                shape: { cx: a[0], cy: a[1], r: 4.2 },
                style: { fill: HALO },
              });
            }
            children.push({
              type: 'circle',
              shape: { cx: a[0], cy: a[1], r: 2.6 },
              style: { fill: colorOf(v1) },
            });
            return { type: 'group', children };
          },
        },
        {
          /*
           * 版本范围线：把属于同一版本的柱子连起来。
           *
           * 为什么需要它：版本标签为了去重只在每段中间标一次（否则 v2.0 v2.0 v2.0 一片），
           * 结果是「这段里其他柱子看不出属于哪个版本」——
           * 过滤后尤其明显：v2.0 有 4 根柱时只有第 2 根下面有字，
           * 最左那根下面是空的，读者分不清它属于 v1.x 还是 v2.0。
           *
           * 用 custom 而不是 markArea：markArea 在类目轴上按整格铺，
           * 会和柱心错开半格（柱子按类目中心对齐），看起来像偏了一根。
           * custom 直接取 x 轴坐标，两端正好落在首尾柱的中心。
           *
           * 画在轴**下方**（y+7）：柱体从 0 往上长，画在图内会压住柱子和段内数字。
           * silent + z=1：它只是注记，不该抢鼠标事件，也不该盖住任何数据。
           */
          name: 'versionRange',
          type: 'custom',
          silent: true,
          tooltip: { show: false },
          z: 1,
          /*
           * 所有版本一律画线，不论几根柱。
           *
           * 早先只给 3 根及以上的版本画，1~2 根的不画——
           * 截出来就是「有的版本下面有线、有的没有」，读者要猜「没线的是不是没有版本」。
           * 统一画之后，这条线变成固定的「版本跨度」标记，不再承担「多柱才需要」的语义，
           * 也就不存在「有线和没线」的对比了。
           */
          /*
           * data 带三个值：起柱下标、止柱下标、版本号。
           * 版本号文字也由这里画——axisLabel 只能挂在柱心，做不到「挂在两根柱之间」。
           */
          data: groups.map((g, gi) => [g.from, g.to, `v${groups[gi].version}`]),
          renderItem: (params, api) => {
            const from = api.value(0);
            const to = api.value(1);
            const label = api.value(2);
            const a = api.coord([from, 0]);
            const b = api.coord([to, 0]);
            const single = from === to;
            const color = COLORS.versionDivider;
            // 轴线的 y 位置（类目轴的 0 值坐标就是轴本身）
            const axisY = a[1];
            /*
             * 版本号在**轴与横线之间**：轴下 11px，横线在 22px 处把它兜住。
             *
             * 读者看到的是「一条横线 + 两端竖虚线，版本号夹在它们中间」，
             * 所以线是真的把版本号框住了，而不是版本号飘在线外面。
             * 字高 10.5，中心放 11 时上下各占 5.25（5.75~16.25），不会压到轴也不碰横线。
             */
            const textY = axisY + 11;
            // 横线在版本号下方 11px：两端竖虚线长 20px，能画出 3 段 dash
            const lineY = axisY + 22;
            const children = [];

            if (single) {
              /*
               * 单柱版本：只写版本号，不画线。
               *
               * 单柱没有「跨度」，两端竖虚线会退化到同一个 x 位置（看起来像一条粗线），
               * 横线也没有左右可延伸——画出来只是重复。柱心正下方写版本号本身就够清楚。
               */
              children.push({
                type: 'text',
                x: a[0],
                y: textY,
                style: {
                  text: label,
                  fill: '#8b8b96',
                  fontSize: 10.5,
                  align: 'center',
                  verticalAlign: 'middle',
                },
              });
            } else {
              // 多柱版本：横线 + 两端竖虚线 + 居中版本号
              children.push({
                type: 'line',
                shape: { x1: a[0], y1: lineY, x2: b[0], y2: lineY },
                style: { stroke: color, lineWidth: 2, lineCap: 'round' },
              });
              /*
               * 两端竖虚线：只提示范围边界，不做封闭括号。
               * dash 用 [3,3]：这两道线长 18px，正好画得出 3 段，虚线感才成立。
               */
              children.push({
                type: 'line',
                shape: { x1: a[0], y1: axisY + 2, x2: a[0], y2: lineY },
                style: { stroke: color, lineWidth: 1.4, lineDash: [3, 3] },
              });
              children.push({
                type: 'line',
                shape: { x1: b[0], y1: axisY + 2, x2: b[0], y2: lineY },
                style: { stroke: color, lineWidth: 1.4, lineDash: [3, 3] },
              });
              /*
               * 版本号放在**两根柱的正中间**。
               * 这里用 (a[0] + b[0]) / 2 而不是挂在某个类目上，
               * 所以 2 根柱时它是真正的居中，不会再偏向左柱。
               */
              children.push({
                type: 'text',
                x: (a[0] + b[0]) / 2,
                y: textY,
                style: {
                  text: label,
                  fill: '#8b8b96',
                  fontSize: 10.5,
                  align: 'center',
                  verticalAlign: 'middle',
                },
              });
            }
            return { type: 'group', children };
          },
        },
      ],
    };
  }

  function renderChart() {
    if (typeof echarts === 'undefined') return;
    const c = currentChart();
    /*
     * 一个可画的频道都没有（账号完全没抽过 50/50 池）时，不要初始化 ECharts——
     * 空数据会让 Math.max(...[]) 得到 -Infinity，坐标轴上限变成 NaN，整块图变白。
     * 换成一句人话，比一张坏掉的图好。
     */
    if (!c) {
      const box = $('#chart-main');
      if (box) box.innerHTML = `<div class="chart-empty">${CFG.copy.chartEmpty ?? '还没有可画的 UP 记录'}</div>`;
      return;
    }
    /*
     * 面板右上角：`N 个 UP · N 抽`。
     * 过滤生效时要写成 `N / 总数 个 UP`，否则柱子只剩 10 根、右边还写 71，
     * 读者会以为图没画全。
     */
    const meta = $('#chart-meta');
    if (meta) {
      const idxs = visibleIndices(c);
      const filtered = idxs.length !== c.rounds.length;
      if (!filtered) {
        /*
         * 不过滤时抽数用该频道的官方口径（chart.pulls），不是柱子求和。
         * 两者差的是「已经抽掉但还没出金」的垫抽——柱子里没有它，
         * 但官方总抽数含它，报表顶部其余数字也都按官方口径。
         * 用柱和会得到 6318，跟顶部「8245 抽」这套官方数不是一个口径。
         */
        meta.textContent = fill(CFG.copy.titleRowMeta, {
          upCount: c.rounds.length,
          pulls: c.pulls,
        });
      } else {
        /*
         * 过滤后柱子和官方总数必然对不上（只画了 2.x）。
         * 此时写「32 / 71 个 UP · 2525 抽」，2525 是这几根柱的真实成本之和；
         * 若写官方总数，读者会以为过滤后仍包含全部抽数。
         */
        const pulls = idxs.reduce((s, i) => s + c.rounds[i].total, 0);
        meta.textContent = fill(CFG.copy.chartMetaFiltered, {
          shown: idxs.length,
          upCount: c.rounds.length,
          pulls,
        });
      }
    }

    if (!chart) chart = echarts.init($('#chart'), null, { renderer: 'svg' });
    /*
     * notMerge: true —— 切频道 / 改过滤后柱子数量会变。
     * 用默认的合并模式，上一份的额外柱子会残留在末尾（ECharts 不会主动缩短 series）。
     */
    chart.setOption(buildOption(), { notMerge: true });

    /*
     * 版本分隔线：曾经用贯穿全图的竖虚线，但柱顶头像是"摞在柱子上方"的，
     * 竖线一定会插进头像和总抽数里，视觉噪音大于信息量。
     * 横轴现在按版本分组、只在组中标一次版本号，分界已经看得出来，
     * 所以仍然不画竖线。
     */

    // 标签联动高亮
    /*
     * 把标签指代的柱子换算成「当前可见列的位置」。
     *
     * 两种标签带的信息不同：
     *   - 连 UP / 连歪 / 似非实欧 → `data-bars`，存的是原 rounds 下标与区间；
     *   - 十连多金 → `data-gold-sorts`，存的是频道内 sort 序号。
     *
     * 为什么十连多金不能也用下标：多金组是**角色池 + 音擎合并**统计的，
     * 两边的 round 编号各算各的，直接当角色池下标用会高亮到别的柱子上（且不报错）。
     * 所以多金走 sort → 柱位这条映射，与青点位置共用同一套换算（见 buildOption 的 barSortOf）。
     *
     * 过滤后必须换算：`data-bars` 里是原下标、多金是原柱位，
     * 直接拿去 highlight 会落到错列的柱子上（甚至越界）。
     */
    const barsOfTag = (tag) => {
      const idxs = visibleIndices(c);
      const posOf = new Map(idxs.map((orig, pos) => [orig, pos]));
      const all = c.rounds;

      if (tag.dataset.goldSorts) {
        /* 多金：sort → 原柱位 → 可见列。当前频道里没有的那些自动跳过。 */
        const bySort = (sort) => all.findIndex(
          (r) => r.sort === sort || r.side.some((s) => s.sort === sort),
        );
        return tag.dataset.goldSorts.split(';').filter(Boolean)
          .map((s) => posOf.get(bySort(Number(s))))
          .filter((p) => p != null);
      }

      const ranges = (tag.dataset.bars ?? '').split(';').filter(Boolean)
        .map((s) => s.split('-').map(Number));
      const out = [];
      for (const [a, b] of ranges) {
        for (let i = a; i <= b; i += 1) {
          const pos = posOf.get(i);
          if (pos != null) out.push(pos);
        }
      }
      return out;
    };

    $('#tags').addEventListener('mouseenter', (e) => {
      const tag = e.target.closest('.tag');
      if (!tag || (!tag.dataset.bars && !tag.dataset.goldSorts)) return;
      const indices = barsOfTag(tag);
      if (!indices.length) return;
      chart.dispatchAction({ type: 'highlight', seriesIndex: [0, 1], dataIndex: indices });
      chart.setOption({
        series: [
          {
            markArea: {
              silent: true,
              itemStyle: { color: 'rgba(240,240,241,0.07)' },
              data: indices.map((p) => [{ xAxis: p - 0.5 }, { xAxis: p + 0.5 }]),
            },
          },
        ],
      });
    }, true);

    $('#tags').addEventListener('mouseleave', (e) => {
      const tag = e.target.closest('.tag');
      if (!tag || (!tag.dataset.bars && !tag.dataset.goldSorts)) return;
      chart.dispatchAction({ type: 'downplay', seriesIndex: [0, 1] });
      chart.setOption({ series: [{ markArea: { data: [] } }, {}, { markLine: { data: [] } }] });
    }, true);
  }

  /*
   * 主图频段 tab。
   *
   * 为什么主图要能切音擎：音擎的 UP 成本是独立的一套数（80 保底、每 UP 抽数也不同），
   * 并进角色池的柱子会让两边都不成立，所以是切数据集。原来只能翻到第二屏详情里看，
   * 而「这一版音擎花了多少抽」本来就是总览该回答的问题。
   *
   * 只有一个频道时不渲染 tab——空 tab 条比没有更让人困惑。
   */
  function renderChartTabs() {
    const box = $('#chart-tabs');
    if (!box) return;
    box.innerHTML = '';
    if (R.charts.length < 2) return;
    for (const c of R.charts) {
      const b = el('button', 'chart-tab', c.detailLabel ?? c.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.id = String(c.channelId);
      b.setAttribute('aria-selected', String(c.channelId === chartState.channel));
      b.addEventListener('click', () => {
        if (chartState.channel === c.channelId) return;
        chartState.channel = c.channelId;
        /*
         * 切频道不清空版本过滤。
         * 两个频道共用同一套版本号，「只看 2.x」的意图跨频道依然成立；
         * 清掉等于每次切 tab 都要重点一遍。
         */
        renderChartTabs();
        renderChartFilters();
        renderLegend();
        renderChart();
      });
      box.appendChild(b);
    }
  }

  /*
   * 版本过滤器：按主版本多选（1.x / 2.x / 3.x）。
   *
   * 形态是「一个漏斗图标 + 若干带勾选态的标签」，不是原来的实心 chip：
   *   1) 不带图标时，这排小胶囊和左边的频段 tab 长得太像，读者会以为是同一种东西；
   *      加一个漏斗，一眼就知道「这是过滤」。
   *   2) 选中态靠**勾**表达，不只靠颜色：打码截图会被压成灰度/低对比，
   *      只靠金色填充的话，选中和未选中在截图里几乎分不出来。勾是形状差异，压色也看得出。
   *
   * 行为不变：过滤只影响柱子（visibleIndices），**不歪率折线始终是全局累计**。
   * 这条是用户定死的口径，改过滤时不要顺手把折线也过滤了。
   *
   * icon 用内联 SVG：产物要能单文件离线打开，不能引外部图标库。
   */
  const FILTER_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">'
    + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" '
    + 'd="M2.5 3.5h11l-4.2 5v4.2l-2.6 1.3V8.5z"/></svg>';

  const CHECK_ICON = '<svg class="check" viewBox="0 0 16 16" width="9" height="9" aria-hidden="true" focusable="false">'
    + '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" '
    + 'd="m3.5 8.5 3 3 6-7"/></svg>';

  const DASH_ICON = '<svg class="check dash" viewBox="0 0 16 16" width="9" height="9" aria-hidden="true" focusable="false">'
    + '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M4 8.5h8"/></svg>';

  function renderChartFilters() {
    const box = $('#chart-filters');
    if (!box) return;
    box.innerHTML = '';
    const majors = R.versionFilters ?? [];
    if (majors.length < 2) return;   // 只有一个版本档位时过滤没有意义

    // 漏斗图标：只是说明「这排是过滤器」，不参与点击
    const icon = el('span', 'filter-icon');
    icon.innerHTML = FILTER_ICON;
    icon.setAttribute('aria-hidden', 'true');
    box.appendChild(icon);

    for (const major of majors) {
      const on = chartState.majors.has(major);
      const b = el('button', 'chip');
      b.type = 'button';
      b.dataset.major = major;
      b.setAttribute('aria-pressed', String(on));
      /*
       * 勾选态用两种图标：选中的是勾，未选中的是一道短横。
       * 两者宽度相同，所以切换时标签不会左右抖动。
       */
      const box2 = el('span', 'chip-box');
      box2.innerHTML = on ? CHECK_ICON : DASH_ICON;
      b.appendChild(box2);
      b.appendChild(el('span', 'chip-label', `${major}.x`));
      b.addEventListener('click', () => {
        if (chartState.majors.has(major)) chartState.majors.delete(major);
        else chartState.majors.add(major);
        renderChartFilters();
        renderChart();
      });
      box.appendChild(b);
    }
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
    const c = currentChart();
    const vars = {
      extremePulls: CFG.numbers.extremePulls,
      goldCount: R.metrics.goldCount,
      multiGoldRounds: R.metrics.multiGoldRounds,
      /*
       * 图例里的「青点＝十连多金 ×N」要跟着当前频道走：
       * 切到音擎后还写角色池的 N，图例就在说另一个频道的数。
       * 所以覆盖 multiGoldRounds（模板用的就是这个名字）。
       */
      multiGoldRounds: (c.multiGold ?? []).length,
      /*
       * 图例里的灰虚线说明要同时讲两条线，因为它们的「欧」方向相反：
       * 每 UP 抽数越低越欧，不歪率越高越欧。只写「基准线」等于没说清。
       */
      baseline: CFG.numbers.baselineWinRate ?? 50,
    };
    // 色块按配置里的 key 取色，图例顺序变化不会错位
    const swatchColor = {
      bad: COLORS.bad.top,
      badOff: COLORS.bad.off,
      extreme: COLORS.extreme.top,
      good: COLORS.good.top,
      line: COLORS.winRateLucky,
      dot: COLORS.multiGoldDot,
    };

    for (const item of CFG.copy.legend ?? []) {
      const line = typeof item === 'string' ? { text: item } : item;
      // 多金这一条在「当前频道一组都没有」时不显示，免得图例写 ×0
      if (line.swatch === 'dot' && !vars.multiGoldRounds) continue;
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
  }

  function init() {
    renderHeader();
    renderTags();
    renderChartTabs();
    renderChartFilters();
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
