/**
 * 报表构建内核 —— **纯逻辑，不写盘、不读参数、不退出进程**。
 *
 * 这是从 `scripts/build-report.mjs` 搬出来的那一段（改前该脚本 1002 行，
 * 其中「读参数 / 读磁盘 / 写产物 / process.exit」是外壳语义，口径与装配不是）。
 * 现在的分工：
 *
 *   scripts/build.mjs    ← 本文件：files + cfg → { html, report, metrics, tags, warnings, fatal }
 *   scripts/build-report.mjs  薄壳：解析参数、把磁盘目录读成 files、调本文件、写文件、打摘要、退出码
 *
 * ## 为什么 SDK 不写盘
 *
 * 同一个内核要能被三种调用方复用：CLI、未来的 HTTP 服务、用例。
 * 写盘位置（`output/<账号名>/report.html`）、失败时「不写文件 + exit 1」这些
 * 都是**外壳**的决定：服务里没有 exit，用例里不该落文件。
 * 所以这里只返回 `html` 与 `fatal`，写不写、往哪写由调用方决定。
 *
 * ## fatal 为什么不在这里抛
 *
 * 这些断言（坐标轴退化、抽数闭合、影画编号……）是「产物一定不可信」的关闸。
 * 抛异常会让调用方分不清「数据有问题」和「代码崩了」；返回一个 `fatal` 数组，
 * 外壳可以照旧打印 `✖` 再 exit 1，服务可以返回 422，用例可以断言具体条目。
 *
 * **顺序不能变**：调用方必须在 `fatal.length === 0` 之后才写文件。
 * 早先 writeFileSync 在校验之前，退 1 了坏产物也已经躺在 output/ 里 —— CI 红了、
 * 人打开文件看到的还是坏图。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeReport } from '../assets/report/core.js';
import { cssVarBlock, textSubs, escapeHtml, templatePlaceholders } from './template-tokens.mjs';
import { PAYLOAD_ID, escapeJsonForScript, buildCorePlusBoot, checkInlinedScript } from './core-inline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * 本文件在 `skills/zzz-stats/scripts/` 下一层，所以 skill 根目录是 `..`。
 */
const SKILL_DIR = resolve(HERE, '..');

/**
 * 把一份数据集构建成单文件 HTML 报表。**不写盘。**
 *
 * @param {object} args
 * @param {Record<string, unknown>|Map<string, unknown>} args.files
 *        文件名作键的虚拟文件系统（`index.json` / `meta.json` /
 *        `cur_pool_stat_<id>.json` / `hist_pool_stat_<id>.json`）。
 *        Map 与普通对象都收：SDK 的 `collectData()` 返回 Map，Node 外壳读盘给对象。
 * @param {object} [args.cfg]  `config/report.json` 的解析结果；不给就读仓库里那份。
 * @param {(msg: string) => void} [args.logWarn]  图标缺失之类的运行时告警去处，默认 console.warn。
 * @returns {{html: string, report: object, metrics: object, tags: object[],
 *            warnings: string[], fatal: string[], notes: string[],
 *            icons: {unique: number, used: number, missing: number}}}
 */
export function buildReport({ files, cfg, logWarn = (m) => console.warn(m) } = {}) {
  const CFG = cfg ?? JSON.parse(readFileSync(join(SKILL_DIR, 'config/report.json'), 'utf8'));
  /*
   * core 用的是 `files[file]` 这种**对象下标**取值，不是 Map.get。
   * SDK 侧 `collectData()` 给的是 Map（键是文件名），这里统一摊成对象再往下传 ——
   * 转换只发生在入口一处，core 与两套外壳看到的是同一种形状。
   */
  const fileMap = files instanceof Map ? Object.fromEntries(files) : (files ?? {});

  const fatal = [];

  // ---------------------------------------------------------------- 图标：sha1 → dataURL

  /*
   * 图标内嵌 + 去重。
   *
   * 为什么内嵌：报表经常被单独发出去（发文件、贴到别的对话、当附件）。
   * 如果只写相对路径 `assets/report/icons/avatars/x.png`，接收方拿不到 assets 目录，
   * 就会看到一堆空框 —— 图表头像和详情图标全没了。
   *
   * 为什么要去重：同一张图在 HTML 里会出现很多次（同一角色反复 UP、歪出、
   * 十连副金，图标在「逐金」和「合并」两种详情里还各存一份）。
   * 旧实现每次都在数据里塞一整串 base64，产物 3.7 MB 里唯一内容只有不到 1 MB。
   *
   * 现在的做法：
   *   1) 按文件内容 sha1 去重 → 一份图标只编码一次，落到 `ICONS[hash]`；
   *   2) 数据里只存 key（avatarKey / iconKey）；
   *   3) 前端用一次 `ICONS[...]` 取回 data URL，肉眼无差别，产物体积砍掉 2/3。
   *
   * **这一层是「资产」不是「口径」**，所以留在外壳：core 只把 key 贴到结构上，
   * 具体 key 是什么（sha1 / 静态路径 / null）由两端各自决定。
   */
  function makeIconResolver() {
    const byHash = new Map();   // sha1 → dataURL
    const byId = new Map();     // `${dir}/${id}` → hash|null
    const paths = new Map();    // sha1 → `${dir}/${id}`（产物里的图标索引要它）
    let missing = 0;

    const encode = (dir, id) => {
      const key = `${dir}/${id}`;
      if (byId.has(key)) return byId.get(key);
      /*
       * 图标只有 64px 一套，就在 `assets/report/icons/<dir>/`。
       * 96px 那套（原来的 `assets/avatars` / `assets/items`）已经删掉：
       * 实际显示尺寸最大 26 CSS px，DPR2 才需要 52px，64px 够用；
       * 而且 96px 本身也是从更大的原图缩出来的，不是原始资产。
       */
      const file = join(SKILL_DIR, 'assets/report/icons', dir, `${id}.png`);
      let buf = existsSync(file) ? readFileSync(file) : null;
      if (!buf) {
        missing += 1;
        logWarn(`  ⚠️  缺图标 assets/report/icons/${dir}/${id}.png，用占位图代替`);
        const fb = join(SKILL_DIR, 'assets/report/icons/items/_fallback.png');
        buf = existsSync(fb) ? readFileSync(fb) : null;
      }
      if (!buf) {
        byId.set(key, null);
        return null;
      }
      const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16);
      if (!byHash.has(hash)) {
        byHash.set(hash, `data:image/png;base64,${buf.toString('base64')}`);
        /*
         * 产物里的引导脚本要能**自己**复算出同一批 key（它没有文件系统，只有一张表）。
         * 这张表按 `dir/id → sha1` 落盘，与 Node 端 `encode()` 的返回一字不差 ——
         * 浏览器和 Node 于是从同一份 sha1 出发，`report.icons` 自然也完全一致。
         */
        paths.set(hash, `${dir}/${id}`);
      }
      byId.set(key, hash);
      return hash;
    };

    /*
     * 右栏：同一个 id 到底该用哪个目录的图标，只能看文件在不在。
     *
     * 音擎频道一个频道里就有两种金：音擎（id 在 items/）和歪出来的角色（id 在 avatars/）。
     * 邦布也是 items/。所以「按频道选一次目录」必然出错，只能逐个 id 试。
     * 两个目录都没有时不报缺失警告——占位图本来就是为这种情况准备的。
     */
    const resolveId = (id) => {
      for (const dir of ['avatars', 'items']) {
        if (existsSync(join(SKILL_DIR, 'assets/report/icons', dir, `${id}.png`))) return encode(dir, id);
      }
      return encode('avatars', id);
    };

    return {
      encode,
      resolveId,
      finish() {
        /*
         * `ids`：`dir/id → sha1`。产物内嵌它，引导脚本据此复算 core 要的 key。
         * `_fallback` 也在这张表里（resolveId 最后会退到它），不用单独处理。
         */
        const ids = {};
        for (const [hash, key] of paths) ids[key] = hash;
        return { map: Object.fromEntries(byHash), ids, unique: byHash.size, used: byId.size, missing };
      },
    };
  }

  const iconResolver = makeIconResolver();
  const { report, notes, internals } = computeReport({ files: fileMap, cfg: CFG, icons: iconResolver });
  const { channelReports, details, index, metrics, tags } = internals;

  const template = readFileSync(join(SKILL_DIR, 'assets/report/template.html'), 'utf8');
  const chartsJs = readFileSync(join(SKILL_DIR, 'assets/report/charts.js'), 'utf8');
  const chartsCss = readFileSync(join(SKILL_DIR, 'assets/report/charts.css'), 'utf8');
  const echartsJs = readFileSync(join(SKILL_DIR, 'assets/vendor/echarts.min.js'), 'utf8');

  const icons = iconResolver.finish();
  report.icons = icons.map;

  /*
   * CSS 变量与文案替换来自同目录的 template-tokens.mjs。
   *
   * 它们**只有构建期一个调用方**：产物是拼好的静态 HTML，浏览器既不写 <style>
   * 也不做文案替换。历史（见该文件头）把它们放在 core 里，副作用是 token 字面量
   * 会随 core 源码内嵌进产物，让「产物里不许残留 /*__ 占位符」那条断言命中自己。
   */
  const cssVarBlockText = cssVarBlock(CFG);
  const textSubsMap = textSubs(CFG);

  /*
   * 产物里的口径计算段。
   *
   * **这是本轮改动的核心**：产物不再内嵌算好的 `report`（1015 KB），
   * 而是内嵌原始采集 JSON（59 KB）+ 转换后的 core（59 KB）+ 引导。
   * 浏览器启动那一刻现算，`window.__REPORT__` 在 charts.js 执行前一定就绪
   * （三段都是经典同步脚本，见 template.html 的注释）。
   *
   * `files` 直接内嵌磁盘上读到的原始响应 —— 不做任何预算、不裁剪字段。
   * 于是产物里的 JSON 与 `fixtures/<name>/*.json` 逐键对得上，
   * 拿产物就能反推出「这份报表是用哪份数据出的」。
   */
  const coreSource = readFileSync(join(SKILL_DIR, 'assets/report/core.js'), 'utf8');
  const corePlusBoot = buildCorePlusBoot({
    coreSource,
    config: CFG,
    iconIds: icons.ids,
    iconData: icons.map,
    generatedAt: report.generatedAt,
  });

  /*
   * 装配期的问题先收在这里，稍后并入 `fatal`（后者要到校验段才声明）。
   * 直接往 `fatal` 里 push 会踩 TDZ —— `const fatal` 还没初始化就访问，
   * 报 "Cannot access 'fatal' before initialization"，构建当场崩，而不是给出可读的失败原因。
   */
  const assemblyProblems = [];

  let html = template
    .replace('/*__CONFIG_CSS_VARS__*/', () => cssVarBlockText)
    .replace('/*__CHARTS_CSS__*/', () => chartsCss)
    .replace('/*__ECHARTS__*/', () => echartsJs)
    /*
     * 内嵌的必须是 `fileMap`，**不能是入参 `files` 本身**。
     *
     * 入参可能是 Map（SDK 的 `collectData()` 就返回 Map），而 `JSON.stringify(map)`
     * 是 `{}` —— 不会报错，产物里那段原始 JSON 会静默变成空对象，浏览器现算时
     * `statsOf()` 拿到 null 就抛 `Cannot read properties of null (reading 'type_stats')`。
     * 构建日志一切正常、Node 侧口径也对，只有打开产物才白屏。
     */
    .replace('/*__PAYLOAD_JSON__*/', () => escapeJsonForScript(JSON.stringify(fileMap)))
    .replace('/*__CORE_PLUS_BOOT__*/', () => corePlusBoot)
    .replace('/*__CHARTS_JS__*/', () => chartsJs);
  for (const [token, text] of Object.entries(textSubsMap)) {
    // 文案来自本地配置，但仍做一次 HTML 转义，避免配置里写了尖括号把模板打坏
    const esc = escapeHtml(text);
    html = html.split(token).join(esc);
  }

  /*
   * ---------------------------------------------------------------- 占位符闭环
   *
   * 模板换占位符、构建脚本没跟着换 → 产物里留着字面量 `/*__XXX__*\/`、
   * `window.__REPORT__` 一次都没赋值、页面全白，**而构建日志照样打印「成功」**。
   * 这真实发生过一次（本轮开工时就撞上了），所以这里做两道闭环：
   *
   *   1. 模板里出现的每个占位符都必须被消费过；
   *   2. 填完之后产物里一个 `/*__…__*\/` 都不许剩。
   *
   * 两条都是 fatal：坏产物不该落盘。
   */
  /*
   * 闭环要做**双向**，只做一个方向会漏掉真实事故那一半：
   *
   *   A. 模板里有、构建没填  → 产物里留着字面量（下面第 3 条能抓到）
   *   B. 构建要填、模板里没有 → **占了位的地方被换成别的东西/被删掉**，
   *      产物里既没有占位符、也没有数据，构建一切「正常」通过。
   *
   * B 方向是真实踩过的那次：模板的 `/*__PAYLOAD_JSON__*\/` 被换成了新名字，
   * 构建脚本还在填旧名字。当时只查 A，构建打印「成功」，产物里 `window.__REPORT__`
   * 一次都没赋值、页面全白。所以这里维护一份**构建负责填的名单**（REQUIRED），
   * 逐个要求模板里必须出现 —— 名单的每一端都紧挨着真正的 `replace` 调用，改漏会当场红。
   */
  const REQUIRED_TOKENS = [
    'CHARTS_CSS', 'CONFIG_CSS_VARS', 'ECHARTS',
    'PAYLOAD_JSON', 'CORE_PLUS_BOOT', 'CHARTS_JS',
    ...Object.keys(textSubsMap).map((t) => t.replace(/^\/\*__|__\*\/$/g, '')),
  ];
  const templateTokens = templatePlaceholders(template);
  for (const name of REQUIRED_TOKENS) {
    if (!templateTokens.includes(name)) {
      assemblyProblems.push(
        `构建要填 /*__${name}__*/，但模板里没有这个占位符：模板被改过名字或删掉了，` +
        '产物会缺这一段（可能表现为页面全白，而构建照样成功）',
      );
    }
  }
  const unknownTokens = templateTokens.filter((name) => !REQUIRED_TOKENS.includes(name));
  if (unknownTokens.length) {
    assemblyProblems.push(
      `模板里有构建不认识占位符：${[...new Set(unknownTokens)].join(', ')} —— ` +
      '它只会原样留在产物里',
    );
  }

  // C. 填完之后一个都不许剩
  const leftover = html.match(/\/\*__[A-Z0-9_]+__\*\//g);
  if (leftover) {
    assemblyProblems.push(`产物里残留 ${leftover.length} 处未替换的占位符：${[...new Set(leftover)].join(' ')}`);
  }

  /*
   * 内嵌脚本的形状自检：转换后不许有 export / import / await，
   * 且必须能取到 computeReport、必须把结果挂到 window.__REPORT__。
   * 这些条件任一不成立，产物就是「页面全白但构建是绿的」。
   */
  for (const problem of checkInlinedScript(corePlusBoot)) assemblyProblems.push(`内嵌口径脚本不合格：${problem}`);
  if (!html.includes(`id="${PAYLOAD_ID}"`)) {
    assemblyProblems.push(`产物里找不到 #${PAYLOAD_ID} 数据块：引导脚本会读不到原始 JSON`);
  }
  if (!html.includes('window.__REPORT__ = out.report')) {
    assemblyProblems.push('产物里没有 window.__REPORT__ 的赋值：charts.js 会静默退出、页面全白');
  }

  // ---------------------------------------------------------------- 校验 + 摘要

  /*
   * 通用完整性校验（6/6 频道实测成立，比「记录条数对得上」更强）：
   *     sum(cur_records[].count) + type_stats[].next_s_cur_times == type_stats[].total_count
   * 左边是「已出金的抽数 + 当前垫抽」，右边是官方总抽数。金数对得上但记录缺抽时会在这里露出来。
   * 常驻/邦布没有任何 is_up 记录，所以只对 50/50 频道额外做 UP 轮校验。
   */
  /*
   * 校验分两级：
   *   warn  —— 数据层面的可疑点（缺图标、口径对不上等）。打印后照常出图：
   *            图标缺失有占位图兜底，是设计好的降级，不该挡住交付。
   *   fatal —— 产物一定不可信的问题。**必须挡住构建（exit 1）**，
   *            否则「跑一次没事」就会漏过去，断言等于没写。
   *
   * 目前只有坐标轴退化算 fatal：那条断言的整个存在意义是「不靠人记得」，
   * 只打一行 ⚠️ 而照样退出 0，下次改代码时仍然会静默退回去。
   */
  const warnings = [];
  /* 装配期的问题（占位符闭环、内嵌脚本形状）并入 fatal：坏产物不该落盘。 */
  fatal.push(...assemblyProblems);
  for (const c of channelReports) {
    if (!c.stats) {
      warnings.push(`${c.label}: index 里没有对应 type_stats，抽数只能从记录推算`);
      continue;
    }
    const recordedPulls = c.golds.reduce((s, g) => s + g.count, 0);
    const pity = c.stats.pity ?? 0;
    if (recordedPulls + pity !== c.stats.pulls) {
      warnings.push(`${c.label}: 金抽数 ${recordedPulls} + 垫抽 ${pity} = ${recordedPulls + pity} ≠ 官方 ${c.stats.pulls}`);
    }
    if (c.golds.length !== c.stats.sCount) {
      warnings.push(`${c.label}: 金数 ${c.golds.length} ≠ 官方 s_count ${c.stats.sCount}`);
    }
    /*
     * 扣垫抽口径的自检：我们算的「每金」应当等于官方 avr_up_count。
     * 官方这个字段本身就是 (total_count - next_s_cur_times) / s_count，
     * 对不上说明垫抽读错了、或 total_count 不是同一个口径——这比金数对得上更有价值。
     */
    if (c.stats.upAvg != null && c.stats.upAvg > 0) {
      /*
       * 官方 avr_up_count 的分母是 up_count，没有 UP 的频道（常驻 / 邦布 / 空池）退回 s_count。
       * 实测 6/6 频道都严格等于 (total_count − next_s_cur_times) / 分母：
       *   独家 87.9 · 音擎 73.8 · 常驻 65.8 · 邦布 48.6 · 独家重映 76 · 音擎回响 0。
       * 对不上说明垫抽读错或 total_count 口径变了——这比「金数对得上」更能抓到问题。
       */
      const denom = (c.stats.upCount || 0) > 0 ? c.stats.upCount : c.stats.sCount;
      const ours = denom ? (c.stats.pulls - (c.stats.pity ?? 0)) / denom : null;
      if (ours != null && Math.abs(ours - c.stats.upAvg) > 0.1) {
        warnings.push(`${c.label}: 每 ${denom === c.stats.upCount ? 'UP' : '金'} ${ours.toFixed(1)} ≠ 官方 avr_up_count ${c.stats.upAvg}（垫抽口径可能不一致）`);
      }
    }
    if (c.has5050) {
      const sumRounds = c.rounds.reduce((s, r) => s + r.total, 0);
      if (Math.abs(sumRounds - (c.stats.pulls - pity)) > 0) {
        warnings.push(`${c.label}: UP 轮总抽 ${sumRounds} ≠ 官方已抽 ${c.stats.pulls - pity}`);
      }
    }
  }
  const nonBangbooPulls = channelReports.reduce((s, c) => s + (c.key === 'bangboo' ? 0 : c.stats?.pulls ?? 0), 0);
  if (report.totals.pullsOfficial != null && report.totals.pullsOfficial !== nonBangbooPulls) {
    warnings.push(`官方 total_gacha_count=${report.totals.pullsOfficial} ≠ 非邦布频道之和 ${nonBangbooPulls}（两个口径都不含邦布）`);
  }

  /*
   * 轴上限的防回归校验。
   *
   * 为什么要有这条：右轴（不歪率）曾经「修好又退回去」一次——
   * 左轴改成了「先读配置 axisPullsMax」，右轴漏了同一步、只留了自适应，
   * 于是角色池显 60%、音擎显 80%，跨图没法对比。
   * 之所以没被发现，是因为独家重映那栏峰值恰好 100%、自适应出来也是 100%，
   * 随便点开一个频道看着是对的。
   *
   * 这里做的不是「验证图表」，而是**验证产物里每个频道都拿到了配置的固定上限**：
   * 产物 HTML 里会内嵌 report 数据，前端照这个值设轴。只要有一个频道缺键，
   * 前端就会静默回退到自适应——所以必须在这里断言「每个可画频道都有值」。
   */
  const axisWinMax = CFG.numbers.axisWinRateMax;
  const pullsMaxCfg = CFG.numbers.axisPullsMax ?? {};
  /*
   * 上面那段只验「配置在不在」，但这次的回归根因是**前端没读配置**（charts.js 只留了自适应）。
   * 所以再断言一次：charts.js 里必须真的出现这两个配置键的读取。
   *
   * 检查前必须先剥掉注释：这两个键名在注释里也出现过（就是解释这段历史的那段），
   * 直接 includes 会被注释骗过去——实测把读取那行删掉、注释留着，检查仍然通过。
   */
  const stripJsComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const chartsCode = stripJsComments(chartsJs);
  for (const key of ['axisWinRateMax', 'axisPullsMax']) {
    if (!chartsCode.includes(`CFG.numbers.${key}`)) {
      fatal.push(`assets/report/charts.js 没有真正读取 CFG.numbers.${key}：坐标轴会退化成按数据自适应，跨图不可比`);
    }
  }
  if (axisWinMax == null) {
    fatal.push('config.numbers.axisWinRateMax 没配：右轴会回退成按数据自适应，跨图将无法对比');
  } else {
    for (const c of report.charts) {
      if (!c.winRate?.length) continue;
      const peak = Math.max(...c.winRate);
      if (peak > axisWinMax) {
        fatal.push(`${c.label}: 不歪率峰值 ${peak}% > 固定上限 ${axisWinMax}%，曲线会被截断`);
      }
    }
  }
  if (!Object.keys(pullsMaxCfg).length) {
    fatal.push('config.numbers.axisPullsMax 没配：左轴会回退成按数据自适应，跨图将无法对比');
  } else {
    for (const c of report.charts) {
      if (!pullsMaxCfg[c.key]) {
        fatal.push(`${c.label}: axisPullsMax 里没有 ${c.key}，左轴会回退成自适应，与其他频道不可比`);
      } else {
        const tallest = c.rounds.reduce((m, r) => Math.max(m, r.total), 0);
        if (tallest > pullsMaxCfg[c.key]) {
          fatal.push(`${c.label}: 最高柱 ${tallest} 抽 > 固定上限 ${pullsMaxCfg[c.key]}，柱子会被截断`);
        }
      }
    }
  }

  /*
   * 右栏口径的防回归断言。
   *
   * 右栏的影画**必须**跨全部频段算：独家能歪出常驻角色，按频道分开算会少算。
   * 这条被写错一次（右栏一度跟着 tab 走），症状很隐蔽——每个 tab 单独看着都对，
   * 只有把同一个角色在两个频道的记录加起来才能发现珂蕾妲少 1 影。
   *
   * 所以断言两件事：
   *   1) 右栏里没有「一半在 50/50 频道、一半在常驻」的角色按频道分算的痕迹：
   *      凡是在常驻出现过的角色，它的 appearances 必须 > 它在任何单个频道的出现次数。
   *      （等价于「合并过了」，比直接检查代码更靠近结果。）
   *   2) 右栏只有角色：音擎 / 邦布一条都不许进。
   */
  {
    const perChannelAppear = new Map();
    for (const channel of channelReports) {
      for (const g of channel.golds) {
        if (g.itemType !== 'ItemType_Avatar') continue;
        const k = `${g.itemId}@${channel.id}`;
        perChannelAppear.set(k, (perChannelAppear.get(k) ?? 0) + 1);
      }
    }
    for (const c of report.charSummary ?? []) {
      const perChannel = channelReports
        .map((ch) => perChannelAppear.get(`${c.itemId}@${ch.id}`) ?? 0);
      const maxOne = Math.max(0, ...perChannel);
      if (perChannel.filter((n) => n > 0).length > 1 && c.appearances <= maxOne) {
        fatal.push(`右栏 ${c.name} 出现 ${c.appearances} 次，但单频道最多就有 ${maxOne} 次：影画疑似按频道分开算了（必须跨全部频段合并）`);
      }
    }
    const nonAvatar = (report.charSummary ?? []).filter((c) => {
      const g = channelReports.flatMap((ch) => ch.golds).find((x) => x.itemId === c.itemId);
      return g && g.itemType !== 'ItemType_Avatar';
    });
    for (const c of nonAvatar) {
      fatal.push(`右栏含非角色条目 ${c.name}(${c.itemId})：音擎 / 邦布没有影画概念，不该进右栏`);
    }
  }

  /*
   * 抽数闭合断言：右栏所有 UP 角色的 pulls 之和 == 独家 + 独家重映的官方总抽数。
   *
   * 这两条断言是给「抽数口径」上的护栏。它被改错过两次：
   *   ① 一开始拿 `is_up === false` 的条数当「歪」，语义整个反了；
   *   ② 后来把抽数改成「只累加该角色自己那条 UP 记录的 count」，雅算出 230 —— 真实是 384。
   * 第 ② 种的症状极隐蔽：每个数字单看都像个合理值，只有**加起来**才暴露
   * （19 个 UP 只加到 1759，而官方是 2448，凭空少掉 689 抽全被「歪」藏走了）。
   *
   * 闭合成立的原因：这两个频道的每一抽都必然落在某一轮里（轮 = 一次 UP 获得及其前缀），
   * 所以「轮 total 累加」在数学上恒等于官方总抽数；换成别的口径就一定不等。
   *
   * 范围只取 `has5050 && kind === 'avatar'`：右栏只统计角色，UP 轮也只在这两个频道产生。
   * 音擎 / 常驻 / 邦布不参与（它们没有 UP 轮，也不该进这个和）。
   *
   * 官方口径取 `total_count − next_s_cur_times`（已抽，不含垫抽），与轮 total 天然对齐：
   * 垫抽是「还没换来金」的部分，不属于任何一轮。实测独家重映 90 − 14 = 76 = 琉音那轮 total。
   */
  {
    const upChannels = channelReports.filter((c) => c.has5050 && c.kind === 'avatar');
    if (upChannels.length) {
      const official = upChannels.reduce((s, c) => s + c.effectivePulls, 0);
      const ours = (report.charSummary ?? [])
        .filter((c) => c.isUp)
        .reduce((s, c) => s + c.pulls, 0);
      if (ours !== official) {
        const names = upChannels.map((c) => c.label).join(' + ');
        fatal.push(
          `右栏 UP 角色抽数合计 ${ours} ≠ ${names} 官方已抽 ${official}：` +
          `抽数口径错了（必须是「该角色各轮 total 累加」，含期间歪出的抽，不能只取 UP 那条的 count）`,
        );
      }
      /*
       * 兜底：万一所有角色都没被认成 UP（比如 has5050 标记丢了），
       * 上面那条会因为 0 ≠ official 而报警，不会静默通过。这里再显式挡一次
       * 「官方有抽数但一个 UP 轮都没有」——那种情况说明轮次模型根本没跑起来。
       */
      const roundCount = upChannels.reduce((s, c) => s + c.rounds.length, 0);
      if (roundCount === 0 && official > 0) {
        fatal.push(`右栏 ${names} 官方有 ${official} 抽，但一轮都没解析出来：轮次模型没跑起来`);
      }
    }
  }

  /*
   * 详情条分母断言：防「分母退化」与「不同抽数画出同样长度」。
   *
   * 分母是详情条唯一的量值来源，写错了不会报错、只会静默把长条压成一样长
   * （改前 `/100` 就是这个症状：1440 独家 merged 里 104 抽和 159 抽都是 948.11px）。
   * 三条检查：
   *
   * ① **分母必须 ≥ 该视图最长行的 pulls。** 小于它就意味着有行超出 100%，
   *    前端 `Math.min(1, …)` 会把它悄悄截成满格，两条不同的抽数画出一样的长度。
   * ② **分母必须 ≥ 该频道 pityCap。** 这是「单条记录的频道不许必然满格」那条口径的
   *    实现方式：独家重映只有 1 行 76 抽，若分母退化成 76，它就恒为 100%。
   * ③ **同一视图里 pulls 不同的两行，条宽必须能区分。** 用和前端完全相同的公式复算
   *    `max(minPx, (轨道宽−34) × pct)`，同一档宽度下若有两条不同 pulls 落到同一个像素值，
   *    说明它们都被 44px 保底吃掉了——那是保底的正常行为，**但不同 pulls 必须来自保底**
   *    （都在 44px 时才允许相等），不能是分母算错导致的封顶。
   *
   * 这里只算**逻辑比例**（不含轨道宽），所以用「比例值」而不是像素：
   * 比例相同且都不是保底钳制 → 报错。
   */
  {
    const minPx = CFG.numbers.detailBarMinPx;
    if (!(minPx > 0)) {
      fatal.push(`numbers.detailBarMinPx(${minPx}) 不是正数：详情条会塌成 0 宽`);
    }
    for (const ch of CFG.channels) {
      const c = channelReports.find((x) => x.id === ch.id);
      if (!c) continue;
      const d = details[ch.id];
      if (!d) {
        fatal.push(`频道 ${ch.label} 没有 details 条目：详情面板会空白`);
        continue;
      }
      for (const mode of ['all', 'merged']) {
        const rows = d[mode];
        const divisor = d.divisor?.[mode];
        if (!rows.length) continue;
        if (!(divisor > 0)) {
          fatal.push(`频道 ${ch.label} 的 ${mode} 视图分母 ${divisor} 不是正数：条宽无法计算`);
          continue;
        }
        const maxPulls = rows.reduce((m, r) => Math.max(m, r.pulls ?? 0), 0);
        if (divisor < maxPulls) {
          fatal.push(
            `频道 ${ch.label} 的 ${mode} 视图分母 ${divisor} < 最长行 ${maxPulls} 抽：` +
            '超出的行会被截成满格，不同抽数画出同样长度',
          );
        }
        if (ch.pityCap != null && divisor < ch.pityCap) {
          fatal.push(
            `频道 ${ch.label} 的 ${mode} 视图分母 ${divisor} < pityCap ${ch.pityCap}：` +
            '单条记录的频道会必然满格（分母退化）',
          );
        }
        /*
         * 比例去重：同一比例值上出现**不同 pulls** 就是「不同抽数画成一样长」。
         * 允许相等的情形只有一种——两行都被 minPx 保底钳制，此时比例不生效。
         * 判断方法：该行的原始条宽 `(轨道−34) × pct` 是否小到连 minPx 都不到。
         * 轨道宽未知（随视口变），所以用 1440 的实测轨道 982.1 做参照：
         * 只要 `(982.1−34) × pct < minPx`，这一行在 1440 就是保底钳制的。
         */
        const REF_TRACK = 982.1; // 1440 实测 .detail-track 宽
        const clamped = (pct) => (REF_TRACK - 34) * pct < minPx;
        const seen = new Map();
        for (const r of rows) {
          const pct = Math.max(0, Math.min(1, (r.pulls ?? 0) / divisor));
          const key = pct.toFixed(6);
          if (!seen.has(key)) seen.set(key, []);
          seen.get(key).push({ name: r.name, pulls: r.pulls, clamped: clamped(pct) });
        }
        for (const [, group] of seen) {
          const pulls = new Set(group.map((g) => g.pulls));
          if (pulls.size <= 1) continue;
          if (group.every((g) => g.clamped)) continue; // 全被保底钳制，长度相同是刻意的
          const names = group.map((g) => `${g.name} ${g.pulls}抽`).join('、');
          fatal.push(
            `频道 ${ch.label} 的 ${mode} 视图有不同抽数却同条宽：${names}` +
            `（都算成 ${group[0].pulls} 抽 / 分母 ${divisor} 的比例）`,
          );
        }
      }
    }
  }

  /*
   * 右栏 tip 明细断言（`gains`）：防的是「tip 与行内数字互相打脸」。
   *
   * 两条独立校验：
   *
   * ① **`Σgains[].total` 必须等于行内 `pulls`。**
   *    tip 一次获得一行，全部加起来就是行内那个总数；不等说明有获得漏进/漏出了 gains
   *    （比如 side 被当成了独立一轮，或某轮的 total 被重复计）。
   *
   * ② **`losses` 里不许出现「十连副金」造成的歪。**
   *    判定方法：某轮 `losses` 有理，但该轮其实是 `guar`（歪来自上一轮带出的保底）而不是
   *    `off > 0`（本轮自己歪），就会出现「tip 说歪了、行内 lostRounds 却没算它」。
   *    实测反例：南宫羽 `side` 有猫又但 `off = 0`、`lostRounds = 0`；
   *    若把 side 掺进 losses，tip 会写「45 抽（1 抽歪「猫又」）」而行内那一格是空的。
   *    这里用「同一角色 Σ(有 losses 的轮数) ≤ lostRounds」来兜：
   *    `guar` 轮自己没有任何 losts，所以只要有人把 side 掺进来，这个不等式立刻被打破。
   */
  {
    for (const c of report.charSummary ?? []) {
      if (!c.isUp) continue;
      const gains = c.gains ?? [];
      const sum = gains.reduce((s, g) => s + (g.total ?? 0), 0);
      if (sum !== c.pulls) {
        fatal.push(
          `右栏 ${c.name} 的 tip 明细合计 ${sum} 抽 ≠ 行内 ${c.pulls} 抽：` +
          `gains 有遗漏或重复（每次获得必须恰好一条，且 total 之和等于 pulls）`,
        );
      }
      const withLoss = gains.filter((g) => (g.losses ?? []).length > 0).length;
      if (withLoss > c.lostRounds) {
        fatal.push(
          `右栏 ${c.name} 有 ${withLoss} 次获得在 tip 里写了歪出明细，但它只有 ${c.lostRounds} 轮歪：` +
          `疑似把十连副金（round.side）混进了 losses——side 的语义是「下一轮的保底已被吃掉」，不是这一轮歪`,
        );
      }
    }
  }

  /*
   * 非 UP 角色 tip 来源断言（`sources`）：防「tip 少写一影 / 多写一影」。
   *
   * 右栏 tip 对非 UP 角色是**逐影列举**（本体：… / 影画1：…），所以条数必须正好等于影画数 + 1。
   * 少一条 tip 就少一行、多一条就凭空多一影；两种都不会报错，只会安静地显示错内容。
   *
   * 为什么这条断言值得存在：`sources` 来自三处（轮 losts / 轮 side / 常驻 golds），
   * 任何一处漏遍历（比如忘了常驻频道、或者 side 的 recordTime 没补上导致排序错）
   * 都会让某个角色的条数对不上。而 `appearances` 是另一条独立路径数出来的
   * （跨全部频段数 avatar 金），拿它当标尺正好能抓到这类漏洞。
   *
   * 注意**不能拿 `portraits` 当标尺**：portraits = appearances − 1，用它反推等于
   * 把两个本就该独立的量绑在一起，断言会退化成「sources = sources」。
   */
  {
    for (const c of report.charSummary ?? []) {
      if (c.isUp) continue;
      const n = (c.sources ?? []).length;
      if (n !== c.appearances) {
        const kinds = (c.sources ?? []).map((s) => s.kind).join(',') || '（空）';
        fatal.push(
          `右栏 ${c.name} 的来源 ${n} 条 ≠ 出现 ${c.appearances} 次：` +
          `tip 会少写或多写影画（来源明细：${kinds}）。` +
          '三处来源必须全覆盖——轮 losts / 轮 side / 常驻 golds，且只收 ItemType_Avatar',
        );
      }
    }
  }

  /*
   * 「本频道首个金」断言：防「tip 里有不止一个 / 一个都没有」。
   *
   * 判据是定义（该频道 all 视图时间最早那行），所以：
   *   - **行的频道有金 → 恰好 1 行被标**（0 行说明判定失效，2 行说明排序坏了）
   *   - **没有金的频道**（音擎回响只在垫抽、没有 S 记录）→ 0 行，这是合法的
   *   - **merged 视图不标**：合并视图的行代表 UP 轮，第三行写「本轮」，语义已经完整，
   *     硬塞「首个金」会和三行模板打架。非 has5050 频道两个视图共用同一批行对象，
   *     所以那里 merged 也会带上标记——那是同一行，不是第二行。
   */
  {
    for (const ch of CFG.channels) {
      const d = details[ch.id];
      if (!d) continue;
      const marked = (d.all ?? []).filter((r) => r.firstGold);
      const hasGold = (d.all ?? []).length > 0;
      if (hasGold && marked.length !== 1) {
        fatal.push(
          `频道 ${ch.label} 的 all 视图有 ${marked.length} 行被标成「本频道首个金」` +
          `（${(d.all ?? []).length} 行金）：有金的频道必须恰好 1 行，` +
          '判据是「该频道时间最早那行」，不是 count === sort',
        );
      }
      if (!hasGold && marked.length !== 0) {
        fatal.push(`频道 ${ch.label} 没有金，却有 ${marked.length} 行「本频道首个金」`);
      }
      const mergedMarked = (d.merged ?? []).filter((r) => r.firstGold);
      if (ch.has5050 && mergedMarked.length > 0) {
        fatal.push(
          `频道 ${ch.label} 的 merged 视图有 ${mergedMarked.length} 行被标成「本频道首个金」：` +
          '合并视图写「本轮」，不该出现首金措辞',
        );
      }
    }
  }

  /*
   * 左栏「本体 / 影画N」标记断言：防「左右两栏对同一个角色说两套话」。
   *
   * 三条独立校验：
   *
   * ① **左栏每一行的 `portrait` 必须等于右栏同一 itemId 那一条的编号。**
   *    编号是从 `charSummary().gains/sources` 建表回贴的，正常情况恒等；
   *    一旦有人把左栏改成「按频道从 1 数」，这条立刻全线失败（实测会报出几十条）。
   *    这条断言的存在意义就是：左栏编号一旦漂移，**构建就挂**，而不是安静地显示错内容。
   *
   * ② **左栏某 itemId 的最高编号 == 右栏该角色的 `portraits`。**
   *    例：蕾米埃尔 2 影 → 左栏最高必须是「影画2」。这条是①的独立补刀——
   *    ① 只证明「查表查到了」，②证明「表里装的东西本身对」。
   *
   * ③ **音擎 / 邦布行不许有标记。** 术语错误：音擎重复是精炼、邦布没有影画。
   *
   * 编号查不到（null）也当失败：那意味着某个角色行在右栏里找不到对应记录，
   * 渲染出来 tip 第一行就光秃秃一个名字，用户以为漏了。
   */
  {
    const byId = new Map((report.charSummary ?? []).map((c) => [c.itemId, c]));
    const maxSeen = new Map(); // itemId → 左栏见过的最高编号
    let mismatch = 0;
    let nonAvatarMarked = 0;
    const mismatchSamples = [];

    for (const ch of CFG.channels) {
      const d = details[ch.id];
      if (!d) continue;
      for (const mode of ['all', 'merged']) {
        for (const r of d[mode] ?? []) {
          const isAvatar = r.itemType === 'ItemType_Avatar';
          if (!isAvatar) {
            if (r.portrait != null) nonAvatarMarked += 1;
            continue;
          }
          if (r.portrait == null) {
            mismatch += 1;
            if (mismatchSamples.length < 5) mismatchSamples.push(`${ch.label}/${mode} ${r.name} 编号查不到`);
            continue;
          }
          const sum = byId.get(r.itemId);
          if (!sum) {
            mismatch += 1;
            if (mismatchSamples.length < 5) mismatchSamples.push(`${ch.label}/${mode} ${r.name} 右栏没有这个角色`);
            continue;
          }
          // 右栏这一条记录是第几只
          const list = sum.isUp ? (sum.gains ?? []) : (sum.sources ?? []);
          const i = list.findIndex((g) => g.recordTime === r.recordTime && (g.sort ?? 0) === (r.sort ?? 0));
          const expect = i < 0 ? null : (i === 0 ? '本体' : `影画${i}`);
          if (expect !== r.portrait) {
            mismatch += 1;
            if (mismatchSamples.length < 5) {
              mismatchSamples.push(`${ch.label}/${mode} ${r.name}: 左栏「${r.portrait}」≠ 右栏「${expect ?? '查不到'}」`);
            }
            continue;
          }
          const n = i;
          if (!maxSeen.has(r.itemId) || n > maxSeen.get(r.itemId)) maxSeen.set(r.itemId, n);
        }
      }
    }

    if (mismatch > 0) {
      fatal.push(
        `左栏「本体/影画N」与右栏对不上 ${mismatch} 行：${mismatchSamples.join('；')}。` +
        '编号必须从 charSummary 的 gains/sources 回贴，不许在左栏按频道各自从 1 数',
      );
    }
    let portraitMismatch = 0;
    const portraitSamples = [];
    for (const [itemId, n] of maxSeen) {
      const c = byId.get(itemId);
      if (!c) continue;
      if (n !== c.portraits) {
        portraitMismatch += 1;
        if (portraitSamples.length < 5) {
          portraitSamples.push(`${c.name}: 左栏最高影画${n}，右栏 portraits=${c.portraits}`);
        }
      }
    }
    if (portraitMismatch > 0) {
      fatal.push(
        `左栏最高影画编号与右栏 portraits 不一致 ${portraitMismatch} 个角色：${portraitSamples.join('；')}。` +
        '两栏必须用同一份全局编号（跨全部频段、按获得时间排序）',
      );
    }
    if (nonAvatarMarked > 0) {
      fatal.push(
        `有 ${nonAvatarMarked} 行音擎 / 邦布被标了「本体/影画」：` +
        '音擎重复是精炼、邦布没有影画，这些行不许有该标记',
      );
    }
  }

  /*
   * 右栏欧非标记断言：防「标记与行内数字互相打脸」。
   *
   * ① **只许 UP 角色有标记。** 非 UP 角色没有抽数，标了就是 0 抽 = 极欧的胡说。
   * ② **标记必须与行内数字自洽。** 逐行用 `pulls / (upRounds × luckExpectPerUp)`
   *    复算倍率、再独立落一次档，与 `luck` 对不上说明判定用错了字段
   *    （比如还在拿 pulls / upRounds 去比阈值，那是已作废的旧口径）。
   * ③ **档位表必须真从 config 读、且是一张单调阶梯。** 三个检查：
   *    a) luckExpectPerUp 是正数；
   *    b) 每档都有 emoji / 正整数 count / 非空 label（渲染层直接用它，缺了就是空标记）；
   *    c) 档位覆盖互不重叠、边界严格递增——上界写反（比如 euro1 的 max 也写成 0.6）
   *       会静默让一整档角色消失，光靠「标记数看起来正常」发现不了。
   */
  {
    const rows = report.charSummary ?? [];
    const num = CFG.numbers;
    const tiers = num.luckTiers;
    const per = num.luckExpectPerUp;

    if (!(per > 0)) {
      fatal.push(`numbers.luckExpectPerUp(${per}) 不是正数：算不出期望抽数`);
    }
    if (!tiers || typeof tiers !== 'object' || !Object.keys(tiers).length) {
      fatal.push('numbers.luckTiers 缺失或为空：右栏标记没有档位可落');
    } else {
      let edge = -Infinity;
      for (const [key, t] of Object.entries(tiers)) {
        if (!t || typeof t !== 'object') {
          fatal.push(`numbers.luckTiers.${key} 不是对象`);
          continue;
        }
        if (!t.emoji) fatal.push(`numbers.luckTiers.${key} 缺 emoji：渲染层会生成空标记`);
        if (!(Number.isInteger(t.count) && t.count > 0)) {
          fatal.push(`numbers.luckTiers.${key}.count(${t.count}) 必须是正整数`);
        }
        if (!t.label) fatal.push(`numbers.luckTiers.${key} 缺 label：aria-label 会空`);
        /*
         * 区间必须单调递增、**不许重叠**。`min` 缺省表示「从负无穷开始」（只允许第一档），
         * `max` 缺省表示「到正无穷为止」（只允许最后一档）。
         *
         * 注意**允许留空隙**：euro1 上界 0.85 与 bad1 下界 1.15 之间那一段就是刻意留空的平档，
         * 「不标」正是要的效果。所以这里只拦 `min < 上一档 max`（重叠会让后一档永远落不到），
         * 不要求首尾相接——第一版断言按「必须相接」写，直接把这份合法配置判成了致命错误。
         */
        const lo = t.min ?? -Infinity;
        const hi = t.max ?? Infinity;
        if (!(lo < hi)) {
          fatal.push(`numbers.luckTiers.${key} 区间无效：[${lo}, ${hi})`);
        } else if (t.min != null && t.min < edge) {
          fatal.push(
            `numbers.luckTiers.${key}.min(${t.min}) 小于上一档的上界(${edge})：区间重叠，` +
            '后一档永远落不到，那一档的角色会静默消失',
          );
        }
        edge = hi;
      }
    }

    if (per > 0 && tiers) {
      for (const c of rows) {
        if (!c.isUp && c.luck) {
          fatal.push(`右栏 ${c.name} 不是 UP 角色却有欧非标记 ${c.luck}：非 UP 没有抽数，不该判`);
        }
        if (!c.isUp) continue;
        const expect = c.upRounds * per;
        const ratio = c.pulls / expect;
        let want = null;
        for (const [key, t] of Object.entries(tiers)) {
          if (!t || typeof t !== 'object') continue;
          if (t.min != null && !(ratio > t.min)) continue;
          if (t.max != null && !(ratio < t.max)) continue;
          want = key;
          break;
        }
        if (c.luck !== want) {
          fatal.push(
            `右栏 ${c.name} 实抽 ${c.pulls} / 期望 ${expect}（${c.upRounds} 只 × ${per}）` +
            ` = 倍率 ${ratio.toFixed(3)}，应落 ${want ?? '平档'}，实际 ${c.luck ?? '平档'}：判定口径与行内数字不一致`,
          );
        }
      }
    }
  }
  /*
   * 这里**只收集**，不打印、不退出。
   * 调用方约定：`fatal.length === 0` 才写文件。
   */
  return {
    html,
    report,
    metrics,
    tags,
    warnings,
    fatal,
    notes,
    icons: { unique: icons.unique, used: icons.used, missing: icons.missing },
  };
}
