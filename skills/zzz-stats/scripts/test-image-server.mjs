#!/usr/bin/env node
/**
 * image-server.mjs 的回归用例。
 *
 * 为什么需要它：图片服务的根目录是 `output/`，而**账号数据目录就在同一层**
 * （`output/<账号名>/data/meta.json` 含 UID 与每金记录）。白名单一旦破，
 * 就是「本机任意进程都能把用户抽卡数据取走」。这类东西不能靠读代码确认。
 *
 * 顺带验「固定文件名 + `?t=` 破缓存」：二维码在盘上是同一个名字，
 * 覆盖写之后如果没有新的 URL，任何缓存层都可能让用户扫到上一张作废的码。
 *
 * 跑法（不需要浏览器、不联网，只起一个 127.0.0.1 的临时端口）：
 *   node skills/zzz-stats/scripts/test-image-server.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startImageServer, stopImageServer, qrUrl, IMAGE_SERVER_FILE } from './image-server.mjs';

const ROOT = join(tmpdir(), `zzz-image-server-test-${process.pid}`);
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? ' ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' ' + extra : ''}`); }
};

/** 1×1 的合法 PNG，两个不同内容用来验「换图后 URL 变了、内容也变了」。 */
const PNG_A = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc000000301010018dd8db00000000049454e44ae426082', 'hex');
const PNG_B = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc000000301010018dd8db00000000049454e44ae426082', 'hex');
// B 改一个字节（IDAT 内容），保证与 A 不同
PNG_B[PNG_B.length - 20] = 0x00;

const fetchStatus = async (url) => {
  const res = await fetch(url);
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
};

console.log('image-server 回归用例\n');

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, '天猪', 'data'), { recursive: true });
mkdirSync(join(ROOT, 'joker'), { recursive: true });
writeFileSync(join(ROOT, '天猪', 'data', 'meta.json'), '{"uid":"10000001","nickname":"天猪"}');
writeFileSync(join(ROOT, '天猪', 'report.html'), '<html>report</html>');
writeFileSync(join(ROOT, 'joker', 'report.html'), '<html>joker</html>');
writeFileSync(join(ROOT, IMAGE_SERVER_FILE), PNG_A);

const { port } = await startImageServer(ROOT, () => {});

try {
  // 1. 白名单：只有 login-qr.png
  {
    console.log('# 1. 白名单：只服务 login-qr.png');
    const base = `http://127.0.0.1:${port}`;
    const qr = await fetchStatus(`${base}/${IMAGE_SERVER_FILE}`);
    check('login-qr.png → 200', qr.status === 200, String(qr.status));
    check('Content-Type 是 image/png', qr.headers.get('content-type') === 'image/png', qr.headers.get('content-type') || '');
    check('带 no-store', /no-store/.test(qr.headers.get('cache-control') || ''), qr.headers.get('cache-control') || '');

    // 2. 账号数据一律 404（这是最关键的一条）
    console.log('# 2. 账号数据与报表必须 404（白名单生效）');
    for (const p of [
      '%E5%A4%A9%E7%8C%AA/data/meta.json',   // 天猪/data/meta.json
      '%E5%A4%A9%E7%8C%AA/report.html',
      'joker/report.html',
      'report.html',
      'meta.json',
      'index.json',
    ]) {
      const r = await fetchStatus(`${base}/${p}`);
      check(`${decodeURIComponent(p)} → 404`, r.status === 404, String(r.status));
    }

    /*
     * 3. 目录穿越 / 变体文件名。
     *
     * 注意 `./login-qr.png` 这类**必须仍然是 200**：URL 规范化后它就是白名单文件本身，
     * 挡它没有安全收益，反而会让「换个写法就取不到图」变成新的坑。
     * 真正要挡的是「能落到别的文件上」的写法。
     */
    console.log('# 3. 目录穿越与变体文件名');
    for (const p of ['../etc/passwd', '..%2F..%2Fetc%2Fpasswd', '/login-qr.png/x', 'login-qr.png.bak', 'login-qr.PNG', 'LOGIN-QR.PNG', '%2e%2e/天猪/data/meta.json']) {
      const r = await fetchStatus(`${base}/${p}`);
      check(`${decodeURIComponent(p)} → ${r.status === 404 ? '404' : '非 404 ⚠'}`, r.status === 404, String(r.status));
    }
    const dotted = await fetchStatus(`${base}/./login-qr.png`);
    check('./login-qr.png 规范化后仍是白名单文件 → 200', dotted.status === 200, String(dotted.status));
  }

  // 4. 破缓存：同一端口两次取图，?t= 不同、内容不同
  {
    console.log('# 4. 固定文件名 + ?t= 破缓存（同一端口两次取到不同内容）');
    const u1 = qrUrl();
    const r1 = await fetchStatus(u1);
    const u2 = qrUrl();
    check('两次 URL 不同', u1 !== u2, `${u1} vs ${u2}`);
    check('URL 带 ?t=', /\?t=\d+-\d+/.test(u2), u2);

    // 覆盖同名文件（模拟刷新二维码），旧 URL 与 新 URL 都应仍能取到（服务只认文件名），
    // 关键点：新 URL 一定拿到新内容
    writeFileSync(join(ROOT, IMAGE_SERVER_FILE), PNG_B);
    const r2 = await fetchStatus(u2);
    check('覆盖后新 URL 取到新内容', r2.status === 200 && Buffer.compare(r2.body, PNG_B) === 0, `${r2.body.length}B vs ${PNG_B.length}B`);
    check('取到的不再是旧内容', Buffer.compare(r2.body, PNG_A) !== 0);
    check('旧 URL 也能取到（服务端只认文件名，不认 t）', r1.status === 200, String(r1.status));
  }

  // 5. 文件不存在 → 404（不是 500、不是空 200）
  {
    console.log('# 5. 二维码文件不存在 → 404');
    rmSync(join(ROOT, IMAGE_SERVER_FILE));
    const r = await fetchStatus(qrUrl());
    check('404 而不是 500/200', r.status === 404, String(r.status));
  }
} finally {
  stopImageServer();
}

// 6. 停服之后端口不再应答
{
  console.log('# 6. 停服后不再应答');
  let ok = false;
  try { await fetch(`http://127.0.0.1:${port}/login-qr.png`, { signal: AbortSignal.timeout(1000) }); }
  catch { ok = true; }
  check('连接被拒', ok);
  check('qrUrl 返回 null', qrUrl() === null, String(qrUrl()));
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
