#!/usr/bin/env node
/**
 * verify-cleanup.mjs 的回归用例。
 *
 * 为什么需要它：扫码采集本身要人扫码，CI / 无头环境跑不了；
 * 但「`_verify/` 删得干不干净 / 幂等 / 空目录移除」这几件事完全可以对着假文件验证。
 * 这段逻辑是**安全相关**的——漏删一张二维码就是一次登录码泄漏，
 * 所以不敢只靠「我看了一眼代码，没问题」。
 *
 * 跑法（不需要浏览器、不联网、不碰真实数据）：
 *   node skills/zzz-stats/scripts/test-verify-cleanup.mjs
 *
 * 输出「通过 N / 失败 0」并 exit 0 即算过。
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { purgeVerifyArtifacts, purgeAndLog } from './verify-cleanup.mjs';

const ROOT = join(tmpdir(), `zzz-verify-cleanup-test-${process.pid}`);
let seq = 0;
let pass = 0;
let fail = 0;

const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? ' ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' ' + extra : ''}`); }
};

/** 造一个「真实采集会留下什么」的目录：凭据文件 + 一个不该被删的东西。 */
function setup({ withBystander = true } = {}) {
  const dir = join(ROOT, `case-${seq += 1}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'login-qr-20261121120001-1.png'), 'qr-1');
  writeFileSync(join(dir, 'login-qr-20261121120002-2.png'), 'qr-2');
  writeFileSync(join(dir, 'login-qr-20261121120003-3.png'), 'qr-3');
  writeFileSync(join(dir, 'login-qr.png'), 'latest-copy');
  writeFileSync(join(dir, 'sms-code.txt'), '123456');
  writeFileSync(join(dir, 'qr-refresh'), '');
  if (withBystander) writeFileSync(join(dir, 'diagnostics.log'), 'not a credential');
  return dir;
}

console.log('verify-cleanup 回归用例\n');
rmSync(ROOT, { recursive: true, force: true });

// 1. 删干净：所有历史序号 + 副本 + 验证码 + 信号；不误删别的东西
{
  console.log('# 1. 删干净（含历史序号）且不误删');
  const dir = setup();
  const r = purgeVerifyArtifacts({ dir });
  check('删了 6 个凭据文件', r.removed.length === 6, JSON.stringify(r.removed.slice().sort()));
  check('login-qr.png 副本也被删', !existsSync(join(dir, 'login-qr.png')));
  check('三个历史序号的二维码全删', ['login-qr-20261121120001-1.png', 'login-qr-20261121120002-2.png', 'login-qr-20261121120003-3.png'].every((f) => !existsSync(join(dir, f))));
  check('sms-code.txt 删了', !existsSync(join(dir, 'sms-code.txt')));
  check('qr-refresh 删了', !existsSync(join(dir, 'qr-refresh')));
  check('非凭据文件保留', existsSync(join(dir, 'diagnostics.log')));
  check('目录非空 → 目录本身保留', r.dirRemoved === false && existsSync(dir));
  check('无失败项', r.failed.length === 0);
}

// 2. 幂等：成功路径删过之后，finally 兜底再删一次不应该出错
{
  console.log('# 2. 幂等（成功路径 + finally 兜底两次调用）');
  const dir = setup();
  purgeVerifyArtifacts({ dir });
  const before = readdirSync(dir).length;
  const r2 = purgeVerifyArtifacts({ dir });
  check('第二次 removed 为空', r2.removed.length === 0);
  check('第二次无失败', r2.failed.length === 0);
  check('残留文件数不变', readdirSync(dir).length === before, `${before}`);
}

// 3. 空目录移除
{
  console.log('# 3. 清完是空目录 → 目录本身也删');
  const dir = setup({ withBystander: false });
  const r = purgeVerifyArtifacts({ dir });
  check('空目录被移除', r.dirRemoved === true && !existsSync(dir));
}

// 4. 目录不存在（用户从未采集过 / 已删过）不抛错
{
  console.log('# 4. 目录不存在时安静返回');
  const r = purgeVerifyArtifacts({ dir: join(ROOT, 'never-existed') });
  check('removed 为空', r.removed.length === 0);
  check('failed 为空', r.failed.length === 0);
}

// 5. --keep-verify
{
  console.log('# 5. --keep-verify 全保留');
  const dir = setup();
  const before = readdirSync(dir).sort().join(',');
  const r = purgeVerifyArtifacts({ dir, keep: true });
  check('skipped = true', r.skipped === true);
  check('一个都没删', readdirSync(dir).sort().join(',') === before);
}

// 6. 日志可观测
{
  console.log('# 6. 清理要打日志（用户能看见）');
  const dir = setup();
  const lines = [];
  purgeAndLog({ dir, log: (m) => lines.push(m), when: '登录成功' });
  check('删了会 log 一行', lines.length === 1 && /已清理二维码等临时文件（6 个）/.test(lines[0]), lines[0] || '(无输出)');

  const lines2 = [];
  purgeAndLog({ dir, log: (m) => lines2.push(m), when: '收尾' });
  check('幂等那次不刷屏', lines2.length === 0, JSON.stringify(lines2));
}

// 7. keep 时要明确说「没清」，否则用户误以为清了
{
  console.log('# 7. --keep-verify 时明确提示未清理');
  const dir = setup();
  const lines = [];
  purgeAndLog({ dir, keep: true, log: (m) => lines.push(m), when: '收尾' });
  check('提示里带 --keep-verify', lines.length === 1 && /keep-verify/.test(lines[0]), lines[0] || '(无输出)');
}

// 8. 只认文件名，不认目录内的子目录（防止误删用户别的东西）
{
  console.log('# 8. 不碰子目录');
  const dir = setup();
  mkdirSync(join(dir, 'login-qr-nested.png'), { recursive: true });
  const r = purgeVerifyArtifacts({ dir });
  check('同名子目录不被当文件删', existsSync(join(dir, 'login-qr-nested.png')) && r.removed.length === 6);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
