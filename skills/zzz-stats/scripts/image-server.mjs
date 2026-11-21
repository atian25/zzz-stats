#!/usr/bin/env node
/**
 * 二维码本地图片服务。
 *
 * 为什么要有它：二维码怎么交给用户，本质是个**成本问题**。实测三条路（一张 260×260 的真二维码）：
 *   - SVG 内联进回答：7361 字符 ≈ 2100 tokens/张。刷新 3 次就是 6300 tokens。
 *     而且它在流式输出里要等文本传完才渲染，用户看到的是先一个灰块。
 *   - base64 塞 <image src>：多数富组件直接丢弃（不支持 data: 协议）。
 *   - 图片 URL：~10 tokens。
 * 差 200 倍。图形的字节不该走对话文本 —— 所以脚本自己起一个**只读**本地 http 服务，
 * 把二维码文件挂出去，回答里只放一行 URL。
 *
 * 为什么单独成文件：这段逻辑要能在**不启动浏览器、不用真扫码**的情况下被测。
 * 「白名单只服务一个文件」「`?t=` 破缓存」这两条都是安全/功能相关的硬要求，
 * 靠肉眼读代码不算验过。留在 collect.mjs 里就测不了（那个文件一 load 就 main()）。
 *
 * 四条安全约束，缺一不可：
 *   1. 只监听 127.0.0.1（不对外网暴露）
 *   2. **白名单只服务 `login-qr.png` 这一个文件名**，其他一律 404。
 *      服务根目录是 `output/`，那下面就是账号数据目录（含 UID 与每金记录）——
 *      按目录放开等于把 `output/<账号名>/data/` 挂出去，绝不允许。
 *   3. 不认子目录、不认 `..`（白名单已经挡掉，这两条是第二道闸）
 *   4. 用完即关 —— 由 main 的 finally 调用 stopImageServer()
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 白名单：整个服务只认这一个文件名。 */
export const IMAGE_SERVER_FILE = 'login-qr.png';

let imageServer = null;

/**
 * 起服务。端口从 0 开始让系统分配，避免固定的 8899 撞车。
 *
 * @param {string} dir 服务根目录（`output/`）
 * @param {(msg: string) => void} log
 * @returns {Promise<{server: import('node:http').Server, port: number, dir: string}>}
 */
export function startImageServer(dir, log) {
  return new Promise((resolvePromise, reject) => {
    const rootDir = resolve(dir);
    const server = createServer((req, res) => {
      try {
        /*
         * 只取 pathname，**丢掉查询串**。
         * URL 带 `?t=<毫秒>` 是为了破缓存（固定文件名 + 覆盖写的老坑），
         * 服务端只要认出文件名就行；不解析查询串的话 `?t=` 会让整个 URL 对不上白名单。
         */
        const urlPath = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
        const name = urlPath.replace(/^\/+/, '');
        if (name !== IMAGE_SERVER_FILE) {
          res.writeHead(404).end('not found');
          return;
        }
        const file = join(rootDir, name);
        if (!existsSync(file)) {
          res.writeHead(404).end('not found');
          return;
        }
        const body = readFileSync(file);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': body.length,
          // 二维码是动态文件，别让浏览器缓存旧图（`?t=` 之外再加一道头）
          'Cache-Control': 'no-store, must-revalidate',
        });
        res.end(body);
      } catch {
        try { res.writeHead(500).end('error'); } catch {}
      }
    });

    server.on('error', reject);
    // 端口 0 = 让系统挑一个空闲端口
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      imageServer = { server, port, dir: rootDir };
      log(`二维码图片服务：http://127.0.0.1:${port}/（仅本机、只读、只服务 ${IMAGE_SERVER_FILE}、取完即关）`);
      resolvePromise(imageServer);
    });
  });
}

export function stopImageServer() {
  if (!imageServer) return;
  try { imageServer.server.close(); } catch {}
  imageServer = null;
}

/** 当前服务端口（没起来时 null）。collect.mjs 拼 URL 用。 */
export function imageServerPort() {
  return imageServer?.port ?? null;
}

/**
 * 二维码的图片 URL。
 *
 * **每次调用都带一个新的 `?t=`**：盘上文件名固定（`login-qr.png`），
 * 覆盖写时浏览器/图片组件/CDN 都可能继续显示旧图 —— 用户扫到的就是一张作废的码。
 * 新时间戳 = 新 URL，缓存自然失效。
 *
 * `?t=` 用「毫秒时间戳 + 单调序号」而不是只有时间戳：同一毫秒内连取两次会拿到同一个值，
 * 那种「看着做了破缓存、其实没破」的情况最难发现（实测过，两次调用拿到完全相同的 URL）。
 * 序号保证每次调用都不同，时间戳保留人类可读的先后关系。
 */
let urlSeq = 0;
export function qrUrl(file = IMAGE_SERVER_FILE) {
  const port = imageServerPort();
  if (!port) return null;
  urlSeq += 1;
  return `http://127.0.0.1:${port}/${file}?t=${Date.now()}-${urlSeq}`;
}
