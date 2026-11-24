/**
 * zzz-stats 报表的**浏览器外壳**：纯静态、零后端、零 AI。
 *
 * ## 它是什么 / 不是什么
 *
 * 是：一个静态页。把 `scripts/fetch-in-page.js` 的输出（那段 JSON 字符串）粘进来或拖进来，
 *     页面用和 Node 端**同一份** `core.js` 算出报表，再用和产物**同一份** `charts.js` 渲染。
 *     全程在浏览器里跑完，不联网（除了同源的 echarts / charts.js / 图标）。
 *
 * 不是：采集器。取数仍然要 Node 那套（开浏览器 + 扫码），因为接口 CORS 只放行官方源。
 *
 * ## 为什么口径一定要走 core.js
 *
 * 这个页面里**没有任何一处口径计算**：轮次模型、不歪率、称号、标签、分母、右栏汇总
 * 全在 core.js。这里只做三件事：
 *   1) 把采集 JSON 摊成 core 认识的虚拟文件系统（`filesFromInPage` / `metaFromInPage`）；
 *   2) 提供图标解析器（静态 png 路径，见下）；
 *   3) 把算出的 report 挂到 `window.__REPORT__`，再加载 charts.js。
 *
 * 一旦这里出现第二份口径，两边就会漂移，而漂移的症状是「同一个账号，命令行出的称号是
 * 欧皇、网页上是大欧皇」——没人会主动去比对。
 *
 * ## 图标为什么是路径而不是 dataURL
 *
 * Node 端把图标 sha1 成 key、值内嵌 base64，是为了让产物**单文件可发送**。
 * 静态页没有这个需求（图标就在同目录的 `icons/` 下），所以值换成静态路径，
 * 但 **key 仍然是同一个 sha1**：
 *   - 这样 `report.icons` 的键集与 Node 端逐字相同，等价性验证只需要允许「值不同」；
 *   - charts.js 的 `ICONS[key]` 一行都不用改 —— 它只认识「一个字符串 key」。
 * sha1 从同目录的 `icons/manifest.json` 读，那份清单由 `scripts/build-icons-manifest.mjs`
 * 按文件内容生成，和 Node 端 `createHash('sha1')` 逐条比对过。
 *
 * ## 输入方式（当前支持哪一种）
 *
 * **粘贴 / 拖入 `fetch-in-page.js` 的输出 JSON。** 这是用户手上本来就会有的东西
 * （采集脚本就是把那段 JSON 字符串返回给 agent 的），不需要额外导出步骤。
 * localStorage / URL hash 都没做：它们要么会把含 UID 的数据留在浏览器里，
 * 要么需要先把大 JSON 编码进 URL，两条路都不比粘贴省事。
 *
 * 支持三种粘贴形态，因为采集链路上真实出现过这几种：
 *   1) `{"ok":true,"index":...,"channels":{...}}`      —— fetch-in-page.js 原样
 *   2) 上面那段的**字符串形式**（`"{\"ok\":true,...}"`）—— 有些工具会再包一层
 *   3) `{index: {...}, channels: {...}}` 已经解包过的 —— agent 手工整理时常见
 */

import {
  computeReport,
  filesFromInPage,
  metaFromInPage,
  cssVarBlock,
  textSubs,
  escapeHtml,
} from './core.js';

const HERE = new URL('./', import.meta.url);

/** 图标清单：`{ 'avatars/1021': '<sha1 前16位>' }`，由 build-icons-manifest.mjs 生成。 */
let ICON_MANIFEST = null;

/**
 * 把采集 JSON 解析成 `{ index, channels }`。
 *
 * 输入可能是对象、可能是被包了一层的字符串、也可能是「字符串里还有字符串」
 * （`save-in-page-json.mjs` 的 `parseLoose()` 处理过同样的三层，这里保持一致的宽容度：
 * 宁可多剥一层，也不要在用户粘贴正确数据时报「格式不对」）。
 */
function parsePayload(raw) {
  let v = typeof raw === 'string' ? JSON.parse(raw) : raw;
  for (let i = 0; i < 3 && typeof v === 'string'; i += 1) v = JSON.parse(v);
  return v;
}

/**
 * 校验并摊成虚拟文件系统。
 *
 * 与 `save-in-page-json.mjs` 的判定保持一致：`ok === false` 是采集失败（未登录等），
 * 必须原样把它的 error/hint 显示出来 —— 那是用户唯一能据以自救的信息。
 */
function toFiles(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('不是一个 JSON 对象');
  if (payload.ok === false) {
    const err = payload.error ?? '未知错误';
    const hint = payload.hint ? `：${payload.hint}` : '';
    throw new Error(`${err}${hint}`);
  }
  if (!payload.index) throw new Error('缺少 index 字段（需要 fetch-in-page.js 的输出）');
  if (!payload.channels) throw new Error('缺少 channels 字段（需要 fetch-in-page.js 的输出）');

  const files = filesFromInPage(payload);
  /*
   * meta.json 在 fetch-in-page.js 的返回里不存在（那是落盘时补的）。
   * 不补这一步的话 UID 会显示成空、区服退回默认值 ——
   * 同一份数据在命令行和网页上算出不同的 meta，正是这次重构要消灭的那类漂移。
   */
  if (!files['meta.json'] && payload.meta) files['meta.json'] = payload.meta;
  else if (!files['meta.json']) files['meta.json'] = metaFromInPage(payload);
  return files;
}

/**
 * 图标解析器：返回 **与 Node 端相同的 sha1 key**，但 `report.icons[key]` 是静态路径。
 *
 * `dir` 的选择规则必须与 Node 端一致（主图按频道类型走 avatars/items、
 * 详情行一律 items/、右栏先 avatars 再 items），否则同一份数据在两端会取到不同图。
 * 这里复刻的是**查找顺序**，不是内容 —— 内容差异正是允许的那一项。
 */
function makeBrowserIcons(manifest) {
  const url = (dir, id) => `${HERE}icons/${dir}/${id}.png`;
  const keyOf = (dir, id) => {
    const k = `${dir}/${id}`;
    return Object.prototype.hasOwnProperty.call(manifest, k) ? manifest[k] : null;
  };
  const used = new Map(); // key -> 相对路径（写进 report.icons）
  const encode = (dir, id) => {
    let key = keyOf(dir, id);
    if (key == null) {
      // 与 Node 端同一套降级：缺图退占位图（占位图也在清单里）
      key = keyOf('items', '_fallback');
      if (key == null) return null;
      if (!used.has(key)) used.set(key, 'icons/items/_fallback.png');
      return key;
    }
    if (!used.has(key)) used.set(key, `icons/${dir}/${id}.png`);
    return key;
  };
  const resolveId = (id) => {
    for (const dir of ['avatars', 'items']) if (keyOf(dir, id) != null) return encode(dir, id);
    return encode('avatars', id);
  };
  return { encode, resolveId, url, used };
}

/**
 * 页面上的提示条：错误 / 警告都走这里，不往 console 里埋。
 *
 * `kind === 'warn'` 自动淡出：它是「这次计算有哪些非致命提示」（标签去重之类），
 * 属于运行时信息，不该长期压在报表上 —— 浮层挡住主图，截图比对时也会算成差异。
 * `error` 不自动消失：那个必须让用户看到并据以处理。
 */
let bannerTimer = null;
function banner(kind, text) {
  const box = document.getElementById('app-banner');
  if (!box) return;
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
  box.className = `app-banner ${kind}`;
  box.textContent = text;
  box.hidden = false;
  if (kind === 'warn') {
    bannerTimer = setTimeout(() => { box.hidden = true; }, 4000);
  }
}

/**
 * 主流程：载入数据 → 算 → 渲染。
 *
 * `charts.js` 是个 IIFE，读 `window.__REPORT__` 后立刻 init；所以必须
 * **先赋值、后插 script 标签**。直接 `<script src="charts.js">` 静态引入不行 ——
 * 那时 `__REPORT__` 还不存在，charts.js 的第一行 `if (!R) return` 会静默退出，
 * 页面一片空白且 console 干净（这个坑在原型阶段踩过）。
 */
async function run(rawPayload) {
  if (!ICON_MANIFEST) {
    const res = await fetch(`${HERE}icons/manifest.json`);
    if (!res.ok) throw new Error(`读不到图标清单 icons/manifest.json（HTTP ${res.status}）`);
    ICON_MANIFEST = await res.json();
  }
  const cfgRes = await fetch(`${HERE}config.json`);
  if (!cfgRes.ok) throw new Error(`读不到配置 config.json（HTTP ${cfgRes.status}）`);
  const cfg = await cfgRes.json();

  const payload = parsePayload(rawPayload);
  const files = toFiles(payload);
  const icons = makeBrowserIcons(ICON_MANIFEST);

  const { report, notes } = computeReport({ files, cfg, icons });
  report.icons = Object.fromEntries(icons.used);

  // 配置 → CSS 变量 / 文案，全部来自 core，与 Node 端同源
  const style = document.getElementById('config-vars');
  if (style) style.textContent = cssVarBlock(cfg);
  for (const [token, text] of Object.entries(textSubs(cfg))) {
    for (const node of document.querySelectorAll('[data-copy]')) {
      if (node.dataset.copy === token) node.textContent = escapeHtml(text);
    }
  }

  window.__REPORT__ = report;
  if (notes.length) banner('warn', notes.join('；'));

  // 把输入面板收起来，让报表占满屏
  const panel = document.getElementById('app-input');
  if (panel) panel.hidden = true;

  /*
   * `data-ready` 必须在 charts.js 之前置上。
   *
   * app.html 里有 `html:not([data-ready]) .screen { display: none }`，作用是
   * 「没算出数据前不要显示一堆『—』的空壳」。但 charts.js 是一次性 init 的：
   * ECharts 在 init 那一刻量容器尺寸，如果那会儿 `.screen` 还是 display:none，
   * 量到的就是 **0×0**，画布永远不出内容 —— 而 DOM 里 `#chart svg` 确实存在、计数是 1，
   * 于是「结构断言」全绿、图却一片空白。这个坑实测踩过一次（截图对比才看出来）。
   *
   * 置位后再插 script：charts.js 的 init 在 load 之后同步跑完，中间不会出现
   * 「可见但空」的一帧（最多一帧骨架，和 Node 产物首帧表现一致）。
   */
  document.documentElement.dataset.ready = '1';
  await loadScript(`${HERE}charts.js`);
}

/** 插入一个经典 script（charts.js 是 IIFE，不是模块）。 */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`加载失败：${src}`));
    document.body.appendChild(s);
  });
}

// ---------------------------------------------------------------- 输入 UI

function setupInput() {
  const panel = document.getElementById('app-input');
  const area = document.getElementById('app-json');
  const file = document.getElementById('app-file');
  const go = document.getElementById('app-go');
  if (!panel) return;

  const submit = async () => {
    const raw = area.value.trim();
    if (!raw) { banner('error', '先粘贴 fetch-in-page.js 输出的 JSON，或把 .json 文件拖进来。'); return; }
    try {
      go.disabled = true;
      await run(raw);
    } catch (e) {
      banner('error', `算不出来：${e.message}`);
      console.error(e);
    } finally {
      go.disabled = false;
    }
  };

  go.addEventListener('click', submit);

  /*
   * 拖入文件：直接读文本塞进 textarea 再走同一条路。
   * 不单独走一条「从文件构造」的分支 —— 两条路各写一遍必然漂移，
   * 而它们本来就只是「文本从哪来」的差别。
   */
  panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('drag'); });
  panel.addEventListener('dragleave', () => panel.classList.remove('drag'));
  panel.addEventListener('drop', async (e) => {
    e.preventDefault();
    panel.classList.remove('drag');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    area.value = await f.text();
    await submit();
  });

  file?.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    area.value = await f.text();
    await submit();
  });

  /*
   * 允许脚本/自动化直接喂数据（验收与将来做「命令行生成一份 app.html」都靠这个）：
   *   window.zzzReport(rawJson)
   */
  window.zzzReport = (raw) => run(raw);

  /*
   * 也允许页面留一个 `data-json` 的引子来自动跑（例如把数据另存成 data.json 后，
   * 用 `app.html?auto=data.json` 打开）。不存在就不要自动跑：
   * 自动 fetch 一个不存在的文件会在 console 里留一条 error，验收要求 0 error。
   */
  const auto = new URLSearchParams(location.search).get('auto');
  if (auto) {
    (async () => {
      try {
        const res = await fetch(new URL(auto, HERE));
        if (!res.ok) return;
        area.value = await res.text();
        await submit();
      } catch (e) { console.error(e); }
    })();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupInput);
} else {
  setupInput();
}
