#!/usr/bin/env node
/**
 * 从 assets/avatars（96px 圆头像）与 assets/items（96px 方图标）生成
 * assets/report/icons/ 下的 64px 压缩版。
 *
 * 为什么单独一步：报表构建时要把图标 base64 内嵌进 HTML，
 * 直接嵌 96px 原图会让 report.html 涨到 6 MB+；缩到 64px 后约 3.5 MB，肉眼无差别。
 * 头像另外做圆形蒙版（透明底），避免方形 PNG 缩放后边缘发糊。
 *
 * 需要 Pillow：
 *   python3 -m pip install pillow
 *   node scripts/make-icons.mjs
 *
 * 只有新增角色/音擎图标时才需要重跑；日常出报表不用管。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets/report/icons');

if (!existsSync(join(ROOT, 'assets/avatars')) && !existsSync(join(ROOT, 'assets/items'))) {
  console.error('找不到 assets/avatars 或 assets/items，先准备图标缓存。');
  process.exit(1);
}

mkdirSync(join(OUT, 'avatars'), { recursive: true });
mkdirSync(join(OUT, 'items'), { recursive: true });

const py = `
from PIL import Image, ImageDraw
import glob, os, sys

root, out = sys.argv[1], sys.argv[2]
def save_round(src, dst, size=64):
    im = Image.open(src).convert('RGBA').resize((size, size), Image.LANCZOS)
    mask = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(im, (0, 0), mask)
    canvas.save(dst, 'PNG', optimize=True)

def save_square(src, dst, size=64):
    Image.open(src).convert('RGBA').resize((size, size), Image.LANCZOS).save(dst, 'PNG', optimize=True)

na = ni = 0
for p in sorted(glob.glob(os.path.join(root, 'assets/avatars/*.png'))):
    save_round(p, os.path.join(out, 'avatars', os.path.basename(p))); na += 1
for p in sorted(glob.glob(os.path.join(root, 'assets/items/*.png'))):
    save_square(p, os.path.join(out, 'items', os.path.basename(p))); ni += 1
print(f'avatars {na} / items {ni}')
`;

try {
  const res = execFileSync('python3', ['-c', py, ROOT, OUT], { encoding: 'utf8' });
  console.log(`assets/report/icons 已生成：${res.trim()}`);
} catch (e) {
  console.error('生成失败。先装 Pillow：python3 -m pip install pillow');
  console.error(e.stderr?.toString().split('\n').slice(-3).join('\n') ?? e.message);
  process.exit(1);
}
