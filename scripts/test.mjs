#!/usr/bin/env node
// 仓库回归入口：所有测试串行运行；临时文件只放本次创建的 output 子目录。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => !['--all', '--browser'].includes(arg)) || args.length > 1) {
  console.error('用法：node scripts/test.mjs [--all|--browser]');
  process.exit(1);
}
const unit = [
  'packages/sdk/test/test-package-exports.mjs',
  'packages/sdk/test/test-qr.mjs',
  'packages/sdk/test/test-sdk-transport.mjs',
  'packages/sdk/test/test-driver-injection.mjs',
  'packages/sdk/test/test-cdp-resources.mjs',
  'skills/zzz-stats/test/test-login-input.mjs',
  'skills/zzz-stats/test/test-qr-wait.mjs',
  'skills/zzz-stats/test/test-verify-cleanup.mjs',
  'skills/zzz-stats/test/test-image-server.mjs',
  'skills/zzz-stats/test/test-core-pure.mjs',
  'skills/zzz-stats/test/test-render-contract.mjs',
  'packages/server/test/test-sdk-integration.mjs',
  'scripts/test-preview-privacy.mjs',
];
const browser = [
  'packages/sdk/test/test-cdp-chrome.mjs',
  'skills/zzz-stats/test/test-report-browser.mjs',
];
const selected = args.includes('--browser') ? browser : args.includes('--all') ? [...unit, ...browser] : unit;
const output = join(root, 'output');
mkdirSync(output, { recursive: true });
const work = mkdtempSync(join(output, '.tests-'));
let failed = 0;
function run(script, extra = []) {
  console.log(`\n=== ${script} ===`);
  const result = spawnSync(process.execPath, [join(root, script), ...extra], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, TMPDIR: work, TMP: work, TEMP: work },
  });
  if (result.error) console.error(result.error);
  const ok = result.status === 0 && !result.error;
  if (!ok) failed++;
  console.log(`EXIT=${result.status ?? result.signal ?? 'spawn-error'}`);
  return ok;
}
try {
  let report;
  if (selected.includes(browser[1])) {
    report = join(work, 'report.html');
    if (!run('skills/zzz-stats/scripts/build-report.mjs', ['--data', join(root, 'fixtures/baseline'), '--out', report])) {
      throw new Error('浏览器验收的基线报表构建失败');
    }
  }
  for (const script of selected) {
    run(script, script === browser[1] ? ['--data', join(root, 'fixtures/baseline'), '--report', report] : []);
  }
  console.log(`\n测试文件：${selected.length - failed} 通过 / ${failed} 失败`);
} catch (error) {
  console.error(error);
  failed = Math.max(failed, 1);
} finally {
  if (dirname(work) !== output || !work.startsWith(join(output, '.tests-')) || realpathSync(work) !== work) {
    throw new Error(`拒绝清理非本次测试目录：${work}`);
  }
  console.log(`清理已核对的测试目录：${work}`);
  rmSync(work, { recursive: true });
}
process.exitCode = failed ? 1 : 0;
