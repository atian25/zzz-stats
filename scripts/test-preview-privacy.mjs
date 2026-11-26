#!/usr/bin/env node
/**
 * `--preview` 隐私分流的回归用例。
 *
 * 为什么需要它：这条规则是**安全相关**的——判错一次就是把真名和真 UID 截进公开仓库，
 * 而打码图一旦推送就收不回来（`git show <旧commit>:docs/preview.png` 永远取得到）。
 * 历史上已经踩过两次，所以「分流对了」不能靠我看一眼代码说没问题。
 *
 * 但真跑一遍要起 Chrome、截整页长图，CI 与无人值守环境跑不了；
 * 于是把两件纯逻辑抽进 preview-privacy.mjs，在这里对着假数据逐条断言：
 *   1. 产物里的 synthetic 标记怎么被读出来（含各种坏写法）；
 *   2. 该走哪条分支（含 fail-safe：没标记 / 标记写错 一律当真实数据）；
 *   3. 截图前那道断言在两条分支上必须是**相反**的期待。
 *
 * 跑法（不需要浏览器、不联网、不碰真实数据）：
 *   node scripts/test-preview-privacy.mjs
 *
 * 输出「通过 N / 失败 0」并 exit 0 即算过。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractReport, previewPrivacyPolicy, checkPreviewGuard, PREVIEW_MASK, PREVIEW_RAW,
} from './preview-privacy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? ' ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' ' + extra : ''}`); }
};

/** 拼一段「像产物那样」的 HTML：内嵌 ECharts、注入 report、再跟 charts.js。 */
function buildHtml(report, { marker = 'window.__REPORT__ = ' } = {}) {
  return [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
    '<script>',
    '/* echarts 源码里有 "</body>" 这类字符串 */',
    'var x = "</body>";',
    '</script>',
    '<script>',
    `${marker}${JSON.stringify(report)};`,
    '</script>',
    '<script>var R = window.__REPORT__;</script>',
    '</body></html>',
  ].join('\n');
}

console.log('preview-privacy 回归用例\n');

/* ------------------------------------------------------------------ 1. 读取 */
{
  console.log('# 1. extractReport：从产物 HTML 里取出内嵌的 report');
  const real = {
    schema: 'zzz-stats/report@1',
    meta: { nickname: '绳匠A', uid: '10000001', synthetic: true },
    metrics: { pulls: 3714 },
  };
  const got = extractReport(buildHtml(real));
  check('取出的是完整对象', got && got.schema === 'zzz-stats/report@1');
  check('嵌套字段没丢', got?.meta?.nickname === '绳匠A' && got?.metrics?.pulls === 3714);
  check('synthetic 读成布尔 true', got?.meta?.synthetic === true);
  check('没被 ECharts 里的 </body> 干扰', got !== null && got.meta.uid === '10000001');

  /*
   * 这条最要紧：`JSON.stringify()` 不产生裸换行（字符串里的换行会转成 `\n` 两个字符），
   * 「取到本行末」才成立。昵称里带真换行时如果按行截就会截断 JSON，必须仍然解析成功。
   */
  const withNewline = { meta: { nickname: '玩\n家A', synthetic: true } };
  const nl = extractReport(buildHtml(withNewline));
  check('昵称里带换行也不会被截断', nl?.meta?.nickname === '玩\n家A', `nick=${JSON.stringify(nl?.meta?.nickname)}`);

  const quotes = { meta: { nickname: '「席」; "x"', synthetic: true } };
  check('昵称里带引号与分号也能解析', extractReport(buildHtml(quotes))?.meta?.nickname === '「席」; "x"');

  check('没有注入标记 → null', extractReport('<html><body>nothing</body></html>') === null);
  check('不是字符串 → null', extractReport(null) === null && extractReport(undefined) === null);
  check('空串 → null', extractReport('') === null);

  const broken = '<script>\nwindow.__REPORT__ = {"meta": {;\n</script>';
  check('JSON 坏了 → null（不抛异常）', extractReport(broken) === null);

  const nonObject = '<script>\nwindow.__REPORT__ = null;\n</script>';
  check('JSON 是 null → null', extractReport(nonObject) === null);

  const noSemicolon = '<script>\nwindow.__REPORT__ = {"meta":{"synthetic":true}}\n</script>';
  check('行尾没有分号也能解析', extractReport(noSemicolon)?.meta?.synthetic === true);
}

/* ------------------------------------------------------------ 2. 分支判定 */
{
  console.log('# 2. previewPrivacyPolicy：只有严格布尔 true 才走「不打码」');
  const syn = previewPrivacyPolicy({ meta: { synthetic: true } });
  check('synthetic: true → 不点眼睛（0）', syn.privacy === PREVIEW_RAW && syn.privacy === 0);
  check('synthetic: true → 期待未打码', syn.expectMasked === false);

  const real = previewPrivacyPolicy({ meta: { nickname: '天' } });
  check('没有 synthetic 字段 → 强制打码（2）', real.privacy === PREVIEW_MASK && real.privacy === 2);
  check('没有 synthetic 字段 → 期待已打码', real.expectMasked === true);

  /*
   * 坏写法一律往安全那边倒。手写 meta.json 时 `"true"` 是最容易出现的错误，
   * 如果它也放行，一次笔误就等于把真实账号的名字放进 README。
   */
  check('synthetic: "true" 字符串 → 当作真实数据', previewPrivacyPolicy({ meta: { synthetic: 'true' } }).expectMasked === true);
  check('synthetic: 1 → 当作真实数据', previewPrivacyPolicy({ meta: { synthetic: 1 } }).expectMasked === true);
  check('synthetic: "yes" → 当作真实数据', previewPrivacyPolicy({ meta: { synthetic: 'yes' } }).expectMasked === true);
  check('synthetic: false → 当作真实数据', previewPrivacyPolicy({ meta: { synthetic: false } }).expectMasked === true);
  check('synthetic: null → 当作真实数据', previewPrivacyPolicy({ meta: { synthetic: null } }).expectMasked === true);
  check('meta 整个缺失 → 当作真实数据', previewPrivacyPolicy({}).expectMasked === true);
  check('report 为 null（产物读不出来）→ 当作真实数据', previewPrivacyPolicy(null).expectMasked === true);
  check('report 为 null 时仍然强制打码', previewPrivacyPolicy(null).privacy === 2);
  check('真实分支给出原因说明', /real/.test(previewPrivacyPolicy({}).reason), previewPrivacyPolicy({}).reason);
  check('模拟分支给出原因说明', previewPrivacyPolicy({ meta: { synthetic: true } }).reason === 'synthetic');
}

/* -------------------------------------------------------------- 3. 断言 */
{
  console.log('# 3. checkPreviewGuard：两条分支的期待是相反的');
  const mask = previewPrivacyPolicy({ meta: {} });
  const raw = previewPrivacyPolicy({ meta: { synthetic: true } });

  /* 真实数据：必须遮住 */
  check('真实 + 已打码 → 过', checkPreviewGuard(mask, { eye: '2', nick: '绳*****', uid: 'UID 10*****01' }).ok);
  check('真实 + 没点眼睛（eye=0）→ 不过', !checkPreviewGuard(mask, { eye: '0', nick: '绳匠A', uid: 'UID 10000001' }).ok);
  check('真实 + 只到 eye=1 → 不过（昵称还没遮）', !checkPreviewGuard(mask, { eye: '1', nick: '绳匠A', uid: 'UID 10*****01' }).ok);
  check('真实 + 昵称没遮 → 不过', !checkPreviewGuard(mask, { eye: '2', nick: '绳匠A', uid: 'UID 10*****01' }).ok);
  check('真实 + UID 没遮 → 不过', !checkPreviewGuard(mask, { eye: '2', nick: '绳*****', uid: 'UID 10000001' }).ok);
  check('真实 + eye 读不到 → 不过', !checkPreviewGuard(mask, { eye: null, nick: '绳*****', uid: 'UID 10*****01' }).ok);
  check('真实 + 页面整个没渲染 → 不过', !checkPreviewGuard(mask, { eye: null, nick: '', uid: '' }).ok);

  /* 模拟数据：必须没遮，而且不能是空的 */
  check('模拟 + 保持全显示 → 过', checkPreviewGuard(raw, { eye: '0', nick: '绳匠A', uid: 'UID 10000001' }).ok);
  check('模拟 + 被误点到 2 → 不过', !checkPreviewGuard(raw, { eye: '2', nick: '绳*****', uid: 'UID 10*****01' }).ok);
  check('模拟 + 被误点到 1 → 不过', !checkPreviewGuard(raw, { eye: '1', nick: '绳匠A', uid: 'UID 10*****01' }).ok);
  check('模拟 + 昵称含 *（别处写死打码）→ 不过', !checkPreviewGuard(raw, { eye: '0', nick: '绳*****', uid: 'UID 10000001' }).ok);
  check('模拟 + UID 含 * → 不过', !checkPreviewGuard(raw, { eye: '0', nick: '绳匠A', uid: 'UID 10*****01' }).ok);

  /*
   * 这两条是「放松成不管」的解毒剂：模拟数据也必须断言页面渲染出来了。
   * 否则一次 JS 崩溃导致昵称空白，图会静悄悄截成一张缺字的图。
   */
  check('模拟 + 昵称为空 → 不过', !checkPreviewGuard(raw, { eye: '0', nick: '', uid: 'UID 10000001' }).ok);
  check('模拟 + UID 为空 → 不过', !checkPreviewGuard(raw, { eye: '0', nick: '绳匠A', uid: '' }).ok);
  check('模拟 + 只有空白 → 不过', !checkPreviewGuard(raw, { eye: '0', nick: '   ', uid: '  ' }).ok);
  check('policy 为 null（不该发生）→ 不过', !checkPreviewGuard(null, { eye: '0', nick: '绳匠A', uid: 'UID 10000001' }).ok);
  check('seen 为 null → 不过', !checkPreviewGuard(raw, null).ok);

  /* 失败时必须有可读的原因，否则日志里只剩「没过」 */
  const bad = checkPreviewGuard(mask, { eye: '0', nick: '绳匠A', uid: 'UID 10000001' });
  check('不过时给出原因', !bad.ok && typeof bad.why === 'string' && bad.why.length > 0, bad.why);
  const bad2 = checkPreviewGuard(raw, { eye: '2', nick: '绳*****', uid: 'UID 10*****01' });
  check('模拟分支不过时也给出原因', !bad2.ok && /eye=2/.test(bad2.why), bad2.why);
}

/* --------------------------------------------------- 4. 仓库里的真实 fixtures */
{
  console.log('# 4. 仓库自带的 fixtures 都已标记为 synthetic');
  for (const name of ['baseline', 'multigold']) {
    let m = null;
    try { m = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', name, 'meta.json'), 'utf8')); } catch { /* ignore */ }
    check(`${name}/meta.json 可读`, m !== null);
    check(`${name}/meta.json 的 synthetic === true`, m?.synthetic === true);
    /*
     * 脱敏三件套一起查：标记为模拟数据的目录，UID 和昵称也必须是假的。
     * 万一有人把真实数据集整份拷进 fixtures 只加了标记，这里当场拦下。
     */
    check(`${name} 的 uid 是假值（1000000x）`, /^1000000\d$/.test(String(m?.uid ?? '')), `uid=${m?.uid}`);
    /*
     * 占位名是「绳匠A / 绳匠B」（用户要求换成绳匠，改前用的是另一套占位名）。
     * 正则跟着改名走——只改 fixtures 不改这里，这条断言会假通过（谁都不是占位名），
     * 等于把「有人拷了真实数据集进来」这个风险静悄悄地放过。
     */
    check(`${name} 的昵称是中性占位名`, /^绳匠[A-Z]$/.test(String(m?.nickname ?? '')), `nick=${m?.nickname}`);
  }
}

/* --------------------------------------------- 5. 产物端到端（可选，无产物时跳过） */
{
  console.log('# 5. 端到端：build-report 产物里的 report.meta.synthetic');
  /*
   * 不在这里跑构建（那要几十秒，还要临时目录）；如果调用方已经构建好了
   * output/<账号名>/report.html，就顺手验一遍透传真的生效。
   * 没有产物时只打一行说明，不算失败——这个用例要能在干净 checkout 上跑。
   */
  const candidates = [];
  try {
    const { readdirSync, existsSync } = await import('node:fs');
    const outDir = join(process.cwd(), 'output');
    if (existsSync(outDir)) {
      for (const d of readdirSync(outDir)) {
        const p = join(outDir, d, 'report.html');
        if (existsSync(p)) candidates.push(p);
      }
    }
  } catch { /* ignore */ }

  if (!candidates.length) {
    console.log('  · 跳过（没有 output/<账号名>/report.html，先构建再看这条）');
  } else {
    for (const p of candidates) {
      const rep = extractReport(readFileSync(p, 'utf8'));
      const pol = previewPrivacyPolicy(rep);
      console.log(`  · ${p} → ${pol.reason}，眼睛点到 ${pol.privacy}`);
      check('字段确实被透传（有 synthetic 布尔值）', typeof rep?.meta?.synthetic === 'boolean');
    }
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
