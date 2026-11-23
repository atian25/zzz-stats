#!/usr/bin/env node
/**
 * `--preview` 的隐私分流规则：**模拟数据集不打码，真实数据强制打码**。
 *
 * 单独成文件的理由和 verify-cleanup.mjs / qr-wait.mjs 一样：这是**安全相关**的判断，
 * 而真正跑一遍要起 Chrome、截整页图，CI 与无人环境都跑不了。
 * 把「该不该遮」和「遮住了没有算不算过」这两件纯逻辑抽出来，才能对着假数据逐条断言。
 *
 * ## 为什么要分流
 *
 * README 的预览图就一张，谁都能看。历史上它连着两版把真名和真 UID 截进了公开仓库，
 * 所以 `--preview` 一度**无条件**强制打码到 2，截图前还要断言 `#nick` 与 `#uid` 都含 `*`。
 * 那道断言是对的，不能拆——但它对 `fixtures/` 里的假数据没有意义：
 * `fixtures/baseline` 是「玩家A / 10000001」，本来就是编的，
 * 遮成「玩*****」只是让预览图变难看，还会掩盖真实的排版。
 *
 * ## 判据只有一个：数据集自己声明
 *
 * `fixtures/<数据集>/meta.json` 里写 `"synthetic": true`，构建时透传到 `report.meta.synthetic`，
 * 这里**只读产物里的这个标记**。不猜、不嗅探、不按 UID 长度或昵称形状推断——
 * 「这个号看起来像假的」这种判断每个都可能猜错一次，而猜错的代价是真名进公开仓库。
 *
 * **没有标记一律当真实数据**（fail-safe）：
 *   - 字段缺失 / 不是布尔 `true`（写 `"true"` 字符串都不算）/ 产物里读不到 report
 *     → 走强制打码 + 原断言。
 *
 * 换句话说，新增一个数据集时忘了写标记，默认行为是「更安全的那一边」，不是「更好看的那一边」。
 */

/** 真实数据：强制点到全打码（三态里的状态 2）。 */
export const PREVIEW_MASK = 2;
/** 模拟数据：不点眼睛，保持默认的全显示（状态 0）。 */
export const PREVIEW_RAW = 0;

/**
 * 从构建好的报表 HTML 里取出内嵌的 `window.__REPORT__`。
 *
 * 为什么按「行」取而不是正则匹配整段 JSON：报表把 ECharts 源码内联进了 HTML，
 * 那段源码的字符串里含有 `</body>` 之类的东西（见 screenshot.mjs 里同名注释），
 * 用正则跨块匹配容易咬到别的脚本。
 *
 * 这里靠一个事实：注入的那一行是
 *     window.__REPORT__ = {"schema":"zzz-stats/report@1",...};
 * 而 `JSON.stringify()` **不产生裸换行**（字符串里的换行会转成 `\n` 两个字符），
 * 所以「从标记起到本行末」正好是完整 JSON。JSON 里的分号、引号都不影响。
 *
 * @returns {object|null} 解析失败一律 null，调用方按「真实数据」处理。
 */
export function extractReport(html) {
  if (typeof html !== 'string' || !html) return null;
  const marker = 'window.__REPORT__ = ';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length;
  const nl = html.indexOf('\n', start);
  const line = (nl < 0 ? html.slice(start) : html.slice(start, nl)).trim();
  // 行尾的 `;` 属于注入语句，不属于 JSON
  const json = line.endsWith(';') ? line.slice(0, -1) : line;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 由产物决定 `--preview` 的隐私策略。
 *
 * @param {object|null} report `extractReport()` 的结果
 * @returns {{privacy: number, expectMasked: boolean, reason: string}}
 *   privacy      要把眼睛按钮点几下之后的状态（`PREVIEW_RAW` / `PREVIEW_MASK`）
 *   expectMasked 截图前断言该期待「已打码」还是「未打码」
 *   reason       给日志用：为什么走了这条分支
 */
export function previewPrivacyPolicy(report) {
  /*
   * 只认严格的布尔 true。
   * `"synthetic": "true"` / `1` / 省略 都当真实数据——
   * 手写 JSON 时最容易写成字符串，而那种错误必须往安全那边倒。
   */
  if (report?.meta?.synthetic === true) {
    return { privacy: PREVIEW_RAW, expectMasked: false, reason: 'synthetic' };
  }
  return {
    privacy: PREVIEW_MASK,
    expectMasked: true,
    reason: report ? 'real（meta.synthetic 不是布尔 true）' : 'real（产物里读不到 window.__REPORT__）',
  };
}

/**
 * 截图前的隐私断言。
 *
 * 宁可不出图，也不出一张带真名的图：返回 `ok: false` 时调用方必须中止、不写文件。
 *
 * 两条分支的期待是**相反**的，这是刻意的：
 *   - 真实数据 → 必须已经遮住（`*` 必须在）；
 *   - 模拟数据 → 必须没有遮（`*` 不许在），并且昵称/UID 都不许是空的
 *     （空说明页面没渲染出来，截出来的是坏图）。
 *
 * @param {{privacy:number, expectMasked:boolean}} policy
 * @param {{eye:string|null, nick:string, uid:string}} seen 页面上读到的实际状态
 * @returns {{ok: boolean, why: string}}
 */
export function checkPreviewGuard(policy, seen) {
  const eye = seen?.eye ?? null;
  const nick = String(seen?.nick ?? '');
  const uid = String(seen?.uid ?? '');
  const hasStar = (s) => s.includes('*');

  /*
   * 策略本身拿不到（调用方传错、或未来改了签名）时一律判不过。
   * 这道断言是最后一道闸门，它的默认行为只能是「拦住」，不能是「放行」。
   */
  if (!policy || typeof policy.expectMasked !== 'boolean') {
    return { ok: false, why: '隐私策略缺失（policy 无效），无法确认这张图能不能发' };
  }

  if (policy.expectMasked) {
    if (eye !== '2') return { ok: false, why: `eye=${eye}（真实数据应为 2，即全打码）` };
    if (!hasStar(nick)) return { ok: false, why: `nick=${JSON.stringify(nick)} 不含 *（昵称没被遮住）` };
    if (!hasStar(uid)) return { ok: false, why: `uid=${JSON.stringify(uid)} 不含 *（UID 没被遮住）` };
    return { ok: true, why: '' };
  }

  if (eye !== '0') return { ok: false, why: `eye=${eye}（synthetic 数据应保持 0，不该被点）` };
  if (hasStar(nick)) return { ok: false, why: `nick=${JSON.stringify(nick)} 含 *（synthetic 数据不该打码）` };
  if (hasStar(uid)) return { ok: false, why: `uid=${JSON.stringify(uid)} 含 *（synthetic 数据不该打码）` };
  if (!nick.trim()) return { ok: false, why: 'nick 为空（页面没渲染出昵称）' };
  if (!uid.trim()) return { ok: false, why: 'uid 为空（页面没渲染出 UID）' };
  return { ok: true, why: '' };
}
