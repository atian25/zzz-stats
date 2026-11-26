#!/usr/bin/env node
/**
 * qr-wait.mjs 的回归用例。
 *
 * 为什么需要它：这里修的是一个**只在特定环境组合下才显形**的 bug ——
 * `collect.mjs` 早先把两条刷新通道写成了二选一：
 *
 *   if (stdin.isTTY) { stdin.on('data', onKey) }
 *   if (!stdinRaw && existsSync(REFRESH_SIGNAL)) {...}   // ← 有 TTY 就永远不查
 *
 * agent 代跑时正是「进程挂在终端里（有 TTY），但 agent 发不了按键」，
 * 于是写信号文件 100% 没有反应，日志还在打「仍在等待…」，白等几十秒。
 * 这种 bug 靠读代码不容易看出来（两段代码各自看都合理），必须有用例盯着。
 *
 * 跑法（不需要浏览器、不联网、不碰真实数据）：
 *   node skills/zzz-stats/scripts/test-qr-wait.mjs
 *
 * 输出「通过 N / 失败 0」并 exit 0 即算过。
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isRefreshKey,
  takeRefreshRequest,
  refreshChannelHint,
  expiredRefreshHint,
  createRefreshInput,
  REFRESH_SIGNAL_FILE,
} from '../scripts/qr-wait.mjs';
import { createQrClock, waitForLogin as waitForLoginSdk } from '../../../packages/sdk/qr-wait.mjs';
// 接外壳文件通道，但每条用例仍执行 SDK 的真实循环。
const waitForLogin = (opts) => waitForLoginSdk({
  ...opts,
  takeRefreshRequest: () => takeRefreshRequest({ keyPressed: opts.input.take(), signalFile: opts.signalFile }),
  emitQr: opts.emitQr,
  progress: opts.progress,
});

const ROOT = join(tmpdir(), `zzz-qr-wait-test-${process.pid}`);
let seq = 0;
let fakeNow = 0;
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? ' ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' ' + extra : ''}`); }
};

/** 造一个「扫码期间」的 output/ 目录；withSignal 决定信号文件在不在。 */
function setup({ withSignal = true } = {}) {
  const dir = join(ROOT, `case-${seq += 1}`);
  mkdirSync(dir, { recursive: true });
  if (withSignal) writeFileSync(join(dir, REFRESH_SIGNAL_FILE), '');
  return { dir, signalFile: join(dir, REFRESH_SIGNAL_FILE) };
}

console.log('qr-wait 回归用例\n');
rmSync(ROOT, { recursive: true, force: true });

// 1. 核心 bug：TTY 场景（stdinRaw=true）下写信号文件也必须触发刷新
{
  console.log('# 1. 有 TTY 时信号文件仍然生效（本次修的 bug）');
  const { dir, signalFile } = setup();
  /*
   * 注意这里**没有 keyPressed**，而真实场景是 stdinRaw=true。
   * takeRefreshRequest 的签名里根本没有 stdinRaw —— 这是刻意的：
   * 它一旦参与判断，两条通道就会重新变成二选一。
   */
  const r = takeRefreshRequest({ keyPressed: false, signalFile });
  check('TTY 场景下信号文件触发刷新', r.refresh === true);
  check('来源标记为 signal', r.via === 'signal', String(r.via));
  check('信号文件被消费掉', r.removed === true && !existsSync(signalFile));
  rmSync(dir, { recursive: true, force: true });
}

// 2. 非 TTY 场景同样生效（不能因为修 #1 而把这条弄坏）
{
  console.log('# 2. 无 TTY 时信号文件同样生效');
  const { dir, signalFile } = setup();
  const r = takeRefreshRequest({ keyPressed: false, signalFile });
  check('触发刷新', r.refresh === true);
  check('文件被删除', !existsSync(signalFile));
  rmSync(dir, { recursive: true, force: true });
}

// 3. 按键通道：两种终端场景都要能触发
{
  console.log('# 3. 按 r 在两种场景下都能触发');
  for (const label of ['有 TTY', '无 TTY']) {
    const { dir, signalFile } = setup({ withSignal: false });
    const r = takeRefreshRequest({ keyPressed: true, signalFile });
    check(`${label}：按键触发刷新`, r.refresh === true);
    check(`${label}：来源标记为 key`, r.via === 'key', String(r.via));
    check(`${label}：没有文件被误删`, r.removed === false && existsSync(dir));
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4. 两条通道同时命中：刷新一次，不要变成两次重取
{
  console.log('# 4. 按键与信号文件同时命中 → 只算一次请求');
  const { dir, signalFile } = setup();
  const r = takeRefreshRequest({ keyPressed: true, signalFile });
  check('刷新（一次）', r.refresh === true);
  check('来源标成 key+signal', r.via === 'key+signal', String(r.via));
  check('文件仍然被清掉', !existsSync(signalFile));
  rmSync(dir, { recursive: true, force: true });
}

// 5. 没有请求时不能误触发
{
  console.log('# 5. 什么都发生时不要刷新');
  const { dir, signalFile } = setup({ withSignal: false });
  const r = takeRefreshRequest({ keyPressed: false, signalFile });
  check('不刷新', r.refresh === false);
  check('来源为 null', r.via === null, String(r.via));
  const empty = takeRefreshRequest({});
  check('连 signalFile 都不传也不报错', empty.refresh === false);
  rmSync(dir, { recursive: true, force: true });
}

// 6. 只认单个 r/R：其他键、方向键转义序列、粘贴内容一律忽略
{
  console.log('# 6. 按键判定只认单个 r');
  for (const [buf, want, label] of [
    [Buffer.from('r'), true, 'r'],
    [Buffer.from('R'), true, 'R（大小写都认）'],
    [Buffer.from('rr'), false, 'rr（连按两次粘贴进来）'],
    [Buffer.from('r '), false, 'r + 空格'],
    [Buffer.from('\x1b[A'), false, '↑ 方向键转义序列'],
    [Buffer.from('\x1b'), false, 'ESC'],
    [Buffer.from('\n'), false, '回车'],
    [Buffer.from('q'), false, 'q'],
    [Buffer.from(''), false, '空 buffer'],
    ['r', true, '字符串 r 也认'],
    [null, false, 'null 不抛错'],
    [undefined, false, 'undefined 不抛错'],
  ]) {
    check(`isRefreshKey(${label}) === ${want}`, isRefreshKey(buf) === want, String(isRefreshKey(buf)));
  }
}

/*
 * 7. 同名的是目录（用户自己造了个叫 qr-refresh 的目录）：
 *    必须当成「没有信号」，不能每轮都失败一次并白白吃掉刷新次数。
 */
{
  console.log('# 7. 同名目录不算信号，且不会被删除');
  const dir = join(ROOT, `case-${seq += 1}`);
  mkdirSync(join(dir, REFRESH_SIGNAL_FILE), { recursive: true });
  const r = takeRefreshRequest({ keyPressed: false, signalFile: join(dir, REFRESH_SIGNAL_FILE) });
  check('不刷新', r.refresh === false);
  check('目录原样保留', existsSync(join(dir, REFRESH_SIGNAL_FILE)));
  rmSync(dir, { recursive: true, force: true });
}

// 8. 信号文件在下一轮不会再命中（消费掉才不会被重复计时）
{
  console.log('# 8. 同一个信号文件只算一次请求');
  const { dir, signalFile } = setup();
  const first = takeRefreshRequest({ keyPressed: false, signalFile });
  const second = takeRefreshRequest({ keyPressed: false, signalFile });
  check('第一次命中', first.refresh === true);
  check('第二次不再命中', second.refresh === false);
  rmSync(dir, { recursive: true, force: true });
}

// 9. 提示文案：两种场景都必须把两条通道都说出来
{
  console.log('# 9. 提示文案两条通道都提（TTY 与非 TTY）');
  const signalFile = '/tmp/output/qr-refresh';
  const tty = refreshChannelHint({ signalFile, stdinRaw: true });
  check('TTY 提示提到按 r', /按 r/.test(tty), tty);
  check('TTY 提示也提到信号文件', tty.includes(signalFile), tty);
  check('TTY 提示说明两者都有效', /都有效|互不影响/.test(tty), tty);

  const nonTty = refreshChannelHint({ signalFile, stdinRaw: false });
  check('非 TTY 提示提到信号文件', nonTty.includes(signalFile), nonTty);
  check('非 TTY 提示仍提到按 r 这条通道', /按 r/.test(nonTty), nonTty);

  const expTty = expiredRefreshHint({ signalFile, stdinRaw: true });
  check('过期提示（TTY）两条都提', /按 r/.test(expTty) && expTty.includes(signalFile), expTty);
  const expNonTty = expiredRefreshHint({ signalFile, stdinRaw: false });
  check('过期提示（非 TTY）提信号文件', expNonTty.includes(signalFile), expNonTty);
}

// 10. 计时器：换新码必须重置起点，过期警告能再次触发
{
  console.log('# 10. 计时器：reissue 重置起点与过期警告');
  let now = 1_000_000;
  const clock = createQrClock({ ttlMs: 120_000, now: () => now });

  check('初始未过期', clock.expired() === false);
  check('初始剩余 = ttl', clock.remainingMs() === 120_000, String(clock.remainingMs()));

  now += 60_000;
  check('过半仍未过期', clock.expired() === false);
  check('剩余约 60 秒', clock.remainingMs() === 60_000, String(clock.remainingMs()));
  check('未过期时不报过期警告', clock.takeExpiryWarning() === false);

  now += 60_000;
  check('到点即过期', clock.expired() === true);
  check('剩余不会变负数', clock.remainingMs() === 0, String(clock.remainingMs()));
  check('过期警告第一次触发', clock.takeExpiryWarning() === true);
  check('过期警告只报一次', clock.takeExpiryWarning() === false);

  // 换新码
  const before = clock.issuedAt;
  clock.reissue();
  check('reissue 后 issuedAt 前移', clock.issuedAt === now, `${before} → ${clock.issuedAt}`);
  check('reissue 后 ageMs 归零', clock.ageMs() === 0, String(clock.ageMs()));
  check('reissue 后不再过期', clock.expired() === false);
  check('reissue 后剩余回到满值', clock.remainingMs() === 120_000, String(clock.remainingMs()));

  // 新码再过期时，必须还能再提醒一次（这是「用户永远扫不到有效码」那个 bug 的另一半）
  now += 120_000;
  check('新码到期后能再次报过期', clock.takeExpiryWarning() === true);
}

// 11. 时钟注入生效（不是偷偷用 Date.now）
{
  console.log('# 11. 计时器用注入的时钟，不读真实时间');
  const clock = createQrClock({ ttlMs: 1000, now: () => 0 });
  check('固定时钟下 ageMs 恒为 0', clock.ageMs() === 0);
  check('固定时钟下永不过期', clock.expired() === false);
  check('默认时钟也能构造', typeof createQrClock({ ttlMs: 1000 }).ageMs() === 'number');
}

/*
 * 12. **真实执行**等待循环。
 *
 * 前 11 组测的是零件，这一组跑的是 collect.mjs 实际调用的那个函数本体。
 * 加它的直接原因：抽循环时漏了 `let wantRefresh`，`node --check` 完全没反应
 * （赋值未声明变量在 ESM 严格模式下是运行时 ReferenceError），
 * 而我手写的仿真 harness 又没跑到那段代码 —— 于是「语法检查过了」被当成「改对了」。
 * 零件测 + 真跑，两样都要有。
 */
{
  console.log('# 12. 真实循环：TTY 场景下信号文件触发刷新');
  const { dir, signalFile } = setup();
  const clock = createQrClock({ ttlMs: 120_000, now: () => fakeNow });
  const input = createRefreshInput();   // 有 TTY，但 agent 不按键 —— 正是出 bug 的场景
  const logs = [];
  let calls = 0;
  const saved = [];

  const r = await waitForLogin({
    // 前两轮未登录，第三轮登录成功
    isLoggedIn: async () => (++calls >= 3 ? 'logged-in' : 'waiting'),
    probe: async () => '页面 100 字：「登录」',
    refreshQr: async () => 'clicked',
    grabQr: async () => ({ src: 'data:image/png;base64,AAAA', w: 200, h: 200 }),
    emitQr: (qr) => { saved.push(qr); },
    progress: (st) => logs.push(st),
    input,
    clock,
    signalFile,
    stdinRaw: true,
    maxWaitMs: 60_000,
    pollMs: 1,
    now: () => fakeNow,
    sleep: async () => { fakeNow += 100; },
  });

  check('循环正常结束（登录成功）', r.ok === true);
  check('刷新发生了一次', r.refreshes === 1, String(r.refreshes));
  check('信号文件被消费', !existsSync(signalFile));
  check('调用了 emitQr', saved.length === 1, String(saved.length));
  check('刷新后重新拿到新码并 emitQr', saved[0]?.src === 'data:image/png;base64,AAAA');
  rmSync(dir, { recursive: true, force: true });
}

// 13. 真实循环：按键通道在跳
{
  console.log('# 13. 真实循环：按键通道同样生效');
  const { dir, signalFile } = setup({ withSignal: false });
  const clock = createQrClock({ ttlMs: 120_000, now: () => fakeNow });
  const input = createRefreshInput();
  let calls = 0;
  const logs = [];
  input.press(Buffer.from('r'));   // 循环开始前按一下
  const r = await waitForLogin({
    isLoggedIn: async () => (++calls >= 2 ? 'logged-in' : 'waiting'),
    probe: async () => '页面 1 字',
    refreshQr: async () => 'clicked',
    grabQr: async () => ({ src: 'data:image/png;base64,AAAA', w: 200, h: 200 }),
    emitQr: () => {},
    input,
    clock,
    log: (m) => logs.push(m),
    signalFile,
    stdinRaw: true,
    pollMs: 1,
    now: () => fakeNow,
    sleep: async () => { fakeNow += 100; },
  });
  check('按键触发刷新', r.refreshes === 1, String(r.refreshes));
  check('没有误报错', r.ok === true);
  rmSync(dir, { recursive: true, force: true });
}

// 14. 真实循环：无关按键不触发；限流与上限仍然生效
{
  console.log('# 14. 真实循环：无关按键不触发，上限与间隔仍然生效');
  const { dir, signalFile } = setup({ withSignal: false });
  const clock = createQrClock({ ttlMs: 120_000, now: () => fakeNow });
  const input = createRefreshInput();
  const logs = [];
  let calls = 0;

  // 按 q / 方向键各一次，都不该触发
  const ignored = [input.press(Buffer.from('q')), input.press(Buffer.from('\x1b[A'))];
  check('无关按键 press 返回 false', ignored.every((v) => v === false), JSON.stringify(ignored));

  const r = await waitForLogin({
    isLoggedIn: async () => (++calls >= 4 ? 'logged-in' : 'waiting'),
    probe: async () => '页面 1 字',
    refreshQr: async () => 'clicked',
    grabQr: async () => ({ src: 'data:image/png;base64,AAAA', w: 200, h: 200 }),
    emitQr: () => {},
    input,
    clock,
    log: (m) => logs.push(m),
    signalFile,
    stdinRaw: false,
    pollMs: 1,
    now: () => fakeNow,
    sleep: async () => { fakeNow += 100; },
  });
  check('无关按键没有引发刷新', r.refreshes === 0, String(r.refreshes));

  // 上限：连按 5 次，最多只刷 3 次
  let calls2 = 0;
  const input2 = createRefreshInput();
  const logs2 = [];
  const r2 = await waitForLogin({
    isLoggedIn: async () => (++calls2 >= 12 ? 'logged-in' : 'waiting'),
    probe: async () => '页面 1 字',
    refreshQr: async () => 'clicked',
    grabQr: async () => ({ src: 'data:image/png;base64,AAAA', w: 200, h: 200 }),
    emitQr: () => {},
    input: input2,
    clock: createQrClock({ ttlMs: 120_000, now: () => fakeNow }),
    progress: (st) => logs2.push(st),
    signalFile: join(dir, 'never'),
    stdinRaw: false,
    pollMs: 1,
    minGapMs: 0,           // 只验次数上限，不验间隔
    now: () => fakeNow,
    sleep: async () => {
      fakeNow += 100;
      // 每轮都再按一次，模拟用户猛按
      input2.press(Buffer.from('r'));
    },
  });
  check('最多只刷 3 次', r2.refreshCount === 3, String(r2.refreshCount));
  check('达到上限后上报 refresh-denied', logs2.filter((x) => x === 'refresh-denied').length >= 1, logs2.join(' | '));
  rmSync(dir, { recursive: true, force: true });
}

/*
 * 15. 真实循环：刷新后计时重置（这是「用户永远扫不到有效码」那个 bug 的防线）。
 * 用一个会推进的假时钟：先熬到过期，再触发刷新，新码的剩余时间必须回到满值。
 */
{
  console.log('# 15. 真实循环：刷新后计时起点重置，新码不再立刻被判过期');
  const { dir, signalFile } = setup({ withSignal: false });
  let t = 0;
  const clock = createQrClock({ ttlMs: 1000, now: () => t });
  const input = createRefreshInput();
  const logs = [];
  let calls = 0;
  let issuedAt = clock.issuedAt;

  const r = await waitForLogin({
    isLoggedIn: async () => (++calls >= 6 ? 'logged-in' : 'waiting'),
    probe: async () => '页面 1 字',
    refreshQr: async () => 'clicked',
    grabQr: async () => ({ src: 'data:image/png;base64,AAAA', w: 200, h: 200 }),
    emitQr: () => {},
    input,
    clock,
    progress: (st) => logs.push(st),
    signalFile,
    stdinRaw: false,
    pollMs: 1,
    now: () => t,
    sleep: async () => {
      t += 400;   // 每轮推 400ms，第 3 轮就过期
      if (calls === 3) input.press(Buffer.from('r'));   // 过期后按一下换图
    },
  });

  check('出现过期事件', logs.includes('expired'), logs.join(' | '));
  check('发生了刷新', r.refreshes === 1, String(r.refreshes));
  check('issuedAt 被前移', clock.issuedAt > issuedAt, `${issuedAt} → ${clock.issuedAt}`);
  check('刷新后 ageMs 从 0 起算', clock.ageMs() < 1000, String(clock.ageMs()));
  check('新码重新可用（不再判过期）', clock.expired() === false);
  rmSync(dir, { recursive: true, force: true });
}

// 16. 真实循环：等不到登录就返回 ok=false，不会假报成功
{
  console.log('# 16. 真实循环：超时返回 ok=false');
  const { dir, signalFile } = setup({ withSignal: false });
  let t = 0;
  const r = await waitForLogin({
    isLoggedIn: async () => 'waiting',
    probe: async () => '页面 1 字',
    refreshQr: async () => 'clicked',
    grabQr: async () => null,
    emitQr: () => {},
    input: createRefreshInput(),
    clock: createQrClock({ ttlMs: 1000, now: () => t }),
    log: () => {},
    signalFile,
    stdinRaw: false,
    maxWaitMs: 2000,
    pollMs: 1,
    now: () => t,
    sleep: async () => { t += 700; },
  });
  check('ok=false', r.ok === false);
  check('没有刷新', r.refreshes === 0, String(r.refreshes));
  rmSync(dir, { recursive: true, force: true });
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
