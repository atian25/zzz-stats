#!/usr/bin/env node
/**
 * verify-cleanup.mjs 的回归用例。
 *
 * 为什么需要它：扫码采集本身要人扫码，CI / 无头环境跑不了；
 * 但「`output/` 下那三个凭据文件删得干不干净 / 幂等 / 不误删账号数据」这几件事
 * 完全可以对着假文件验证。这段逻辑是**安全相关**的——漏删一张二维码就是一次登录码泄漏，
 * 所以不敢只靠「我看了一眼代码，没问题」。
 *
 * 现在多了一层更要紧的东西：清理目录是 `output/` 根，而账号目录（内含 UID 与每金记录）
 * 就在同一层。**删错就是删用户数据**，所以「只删三个固定文件、永不删目录、
 * 不碰任何子目录」必须有对应用例盯着。
 *
 * 跑法（不需要浏览器、不联网、不碰真实数据）：
 *   node skills/zzz-stats/scripts/test-verify-cleanup.mjs
 *
 * 输出「通过 N / 失败 0」并 exit 0 即算过。
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { purgeVerifyArtifacts, purgeAndLog, CREDENTIAL_FILES } from './verify-cleanup.mjs';

const ROOT = join(tmpdir(), `zzz-verify-cleanup-test-${process.pid}`);
let seq = 0;
let pass = 0;
let fail = 0;

const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? ' ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' ' + extra : ''}`); }
};

/**
 * 造一个「真实采集时会看到什么」的目录：三个凭据文件 + 一个账号目录 + 一个无关文件。
 * 账号目录里放的是真实结构（data/ + report.html），用来验证不会被误删。
 */
function setup({ withAccount = true, withBystander = true } = {}) {
  const dir = join(ROOT, `case-${seq += 1}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'login-qr.png'), 'qr-bytes');
  writeFileSync(join(dir, 'sms-code.txt'), '123456');
  writeFileSync(join(dir, 'qr-refresh'), '');
  if (withAccount) {
    mkdirSync(join(dir, '绳匠A', 'data'), { recursive: true });
    writeFileSync(join(dir, '绳匠A', 'data', 'meta.json'), '{"uid":"10000001"}');
    writeFileSync(join(dir, '绳匠A', 'report.html'), '<html></html>');
  }
  if (withBystander) writeFileSync(join(dir, 'diagnostics.log'), 'not a credential');
  return dir;
}

console.log('verify-cleanup 回归用例\n');
rmSync(ROOT, { recursive: true, force: true });

// 1. 删干净：三个固定文件，别的一概不动
{
  console.log('# 1. 三个固定文件删干净，账号目录与无关文件不动');
  const dir = setup();
  const r = purgeVerifyArtifacts({ dir });
  check('删了 3 个凭据文件', r.removed.length === 3, JSON.stringify(r.removed.slice().sort()));
  check('删的正好是那三个', r.removed.slice().sort().join(',') === [...CREDENTIAL_FILES].sort().join(','));
  check('login-qr.png 删了', !existsSync(join(dir, 'login-qr.png')));
  check('sms-code.txt 删了', !existsSync(join(dir, 'sms-code.txt')));
  check('qr-refresh 删了', !existsSync(join(dir, 'qr-refresh')));
  check('账号数据目录还在', existsSync(join(dir, '绳匠A', 'data', 'meta.json')));
  check('账号报表还在', existsSync(join(dir, '绳匠A', 'report.html')));
  check('无关文件保留', existsSync(join(dir, 'diagnostics.log')));
  check('output/ 目录本身保留', existsSync(dir));
  check('无失败项', r.failed.length === 0);
}

// 2. 幂等：成功路径删过之后，finally / 信号处理兜底再删一次不应该出错
{
  console.log('# 2. 幂等（成功路径 + finally / 信号处理两次以上调用）');
  const dir = setup();
  purgeVerifyArtifacts({ dir });
  const before = readdirSync(dir).sort().join(',');
  const r2 = purgeVerifyArtifacts({ dir });
  check('第二次 removed 为空', r2.removed.length === 0);
  check('第二次无失败', r2.failed.length === 0);
  check('残留条目不变', readdirSync(dir).sort().join(',') === before, before);
}

// 3. 目录不存在（用户从未采集过 / 已删过）不抛错
{
  console.log('# 3. 目录不存在时安静返回');
  const r = purgeVerifyArtifacts({ dir: join(ROOT, 'never-existed') });
  check('removed 为空', r.removed.length === 0);
  check('failed 为空', r.failed.length === 0);
}

// 4. --keep-verify
{
  console.log('# 4. --keep-verify 全保留');
  const dir = setup();
  const before = readdirSync(dir).sort().join(',');
  const r = purgeVerifyArtifacts({ dir, keep: true });
  check('skipped = true', r.skipped === true);
  check('一个都没删', readdirSync(dir).sort().join(',') === before);
}

// 5. 日志可观测
{
  console.log('# 5. 清理要打日志（用户能看见）');
  const dir = setup();
  const lines = [];
  purgeAndLog({ dir, log: (m) => lines.push(m), when: '登录成功' });
  check('删了会 log 一行', lines.length === 1 && /已清理二维码等临时文件（3 个）/.test(lines[0]), lines[0] || '(无输出)');

  const lines2 = [];
  purgeAndLog({ dir, log: (m) => lines2.push(m), when: '收尾' });
  check('幂等那次不刷屏', lines2.length === 0, JSON.stringify(lines2));
}

// 6. keep 时要明确说「没清」，否则用户误以为清了
{
  console.log('# 6. --keep-verify 时明确提示未清理');
  const dir = setup();
  const lines = [];
  purgeAndLog({ dir, keep: true, log: (m) => lines.push(m), when: '收尾' });
  check('提示里带 --keep-verify', lines.length === 1 && /keep-verify/.test(lines[0]), lines[0] || '(无输出)');
}

// 7. 不碰子目录：同名子目录 / 账号目录里的同名文件都不能删
{
  console.log('# 7. 只认 output/ 根下的三个文件名，不递归、不碰子目录');
  const dir = setup();
  mkdirSync(join(dir, 'login-qr.png.d'), { recursive: true });
  mkdirSync(join(dir, 'someone', 'data'), { recursive: true });
  writeFileSync(join(dir, 'someone', 'data', 'sms-code.txt'), 'nested-credential');
  const r = purgeVerifyArtifacts({ dir });
  check('同名目录不被当文件删', existsSync(join(dir, 'login-qr.png.d')));
  check('子目录里的同名文件不被误删', existsSync(join(dir, 'someone', 'data', 'sms-code.txt')));
  check('仍然只删 3 个', r.removed.length === 3, String(r.removed.length));
}

// 8. 空目录也保留：output/ 里有账号目录时天然不空，但哪怕真空也不能删
{
  console.log('# 8. 清完是空目录也不删目录本身');
  const dir = setup({ withAccount: false, withBystander: false });
  const r = purgeVerifyArtifacts({ dir });
  check('三个都删了', r.removed.length === 3);
  check('空目录保留', existsSync(dir));
}

// 9. 旧结构残留不会漏：`_verify/` 目录整体不在清理范围，但也不该被当成凭据
{
  console.log('# 9. 历史 `_verify/` 目录原样保留（不属于新清理范围）');
  const dir = setup();
  mkdirSync(join(dir, '_verify'), { recursive: true });
  writeFileSync(join(dir, '_verify', 'login-qr-20261121120001-1.png'), 'stale');
  const r = purgeVerifyArtifacts({ dir });
  check('_verify/ 里的旧文件不被这次清理碰到', existsSync(join(dir, '_verify', 'login-qr-20261121120001-1.png')));
  check('清理数量仍是 3', r.removed.length === 3, String(r.removed.length));
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
