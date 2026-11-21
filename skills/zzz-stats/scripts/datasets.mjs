#!/usr/bin/env node
/**
 * 账号目录名 + `output/` 结构的共用实现。
 *
 * 运行期产物是「一个账号一个目录」，用户拿走 `output/<账号名>/` 这一个目录就能部署：
 *
 *   output/
 *   ├── <账号名>/
 *   │   ├── data/                 meta.json / index.json / *_pool_stat_*.json
 *   │   └── report.html           自包含单文件报表
 *   ├── login-qr.png              凭据性临时文件（与账号目录无关，登录成功即删）
 *   ├── sms-code.txt
 *   └── qr-refresh
 *
 * 为什么这条规则要单独成文件：collect / save-in-page-json 决定**往哪写**，
 * build-report / sync-icons / screenshot 决定**去哪读**，五处各写一遍必然漂移。
 * 漂移的后果不是「报个错」，而是「写得进去、读不出来」——采集说成功了，
 * 出图却报找不到数据集。而账号名又要做文件系统安全化，两份实现不一致更麻烦。
 *
 * 另一条底线：账号名来自页面文本（用户昵称），属于**不可信输入**。
 * 它会被拼进文件路径，所以必须保证结果永远是 `output/` 下的**单级**目录名，
 * 绝不能因为昵称里带 `../` 就写到 `output/` 外面去。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 工作表下的产物子目录。数据、报表、凭据临时文件全在这一个目录里。 */
export const OUTPUT_SUBDIR = 'output';

/** `output/` 的绝对路径。 */
export const outputRoot = (workDir) => resolve(workDir, OUTPUT_SUBDIR);

/**
 * 昵称 → 单级目录名。不合法时返回 `''`（由调用方决定退回什么）。
 *
 * 规则（都是实测踩过的形状，不是想当然）：
 *   - 去掉路径分隔符 `/` `\`：昵称里出现斜杠时，直接拼进路径就会造出多级目录
 *   - 去掉控制字符：换行、NUL 会让路径在日志和终端里错乱，NUL 更是直接抛异常
 *   - 去掉 Windows 非法字符 `: * ? " < > |`：仓库可能在 Windows 上被克隆
 *   - 去掉首尾空白与点：`.` / `..` 是目录穿越；`foo.` 在 Windows 上会被截断成 `foo`
 *   - 允许 emoji、空格、`·`（实测昵称里都有）
 *   - 空串或全是非法字符 → 交回调用方退回 UID
 */
export function sanitizeSegment(raw) {
  let s = String(raw ?? '');
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  s = s.replace(/[/\\]/g, '');
  s = s.replace(/[:*?"<>|]/g, '');
  s = s.replace(/[\s\u00a0]+/g, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/\.+$/, '').trim();
  if (!s || s === '.' || s === '..') return '';
  // Windows 的保留设备名不允许作为目录名，撞上就加个后缀（macOS 上无所谓，但仓库会被克隆到 Windows）
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = `${s}_`;
  // 按码点截断，别把 emoji 的代理对切成半个字符
  return [...s].slice(0, 60).join('');
}

/**
 * 决定账号目录名。
 *
 * 昵称优先；拿不到（`null` / 空 / 全是非法字符）就退回 UID。
 * 两个都没有时用 `account` 兜底——总比写到 `output/` 根上强。
 *
 * @returns {{ name: string, source: 'nickname' | 'uid' | 'fallback' }}
 */
export function resolveAccountName(nickname, uid) {
  const fromNickname = sanitizeSegment(nickname);
  if (fromNickname) return { name: fromNickname, source: 'nickname' };
  const fromUid = sanitizeSegment(uid);
  if (fromUid) return { name: fromUid, source: 'uid' };
  return { name: 'account', source: 'fallback' };
}

/**
 * `output/<账号名>/data/` 的绝对路径。
 *
 * 拼完再验一次「确实在 output/ 下面」：安全化已经挡掉了分隔符，
 * 但这条断言是最后一道闸，成本一行，防的是以后有人改了 `sanitizeSegment` 却忘了这里。
 */
export function accountDataDir(workDir, name) {
  const root = outputRoot(workDir);
  const dir = join(root, name, 'data');
  if (!dir.startsWith(root + '/') && dir !== root) {
    throw new Error(`账号名不合法（会写到 output/ 外面）：${JSON.stringify(name)}`);
  }
  return dir;
}

/** 遍历 `output/*` 下的子目录，返回目录名列表。 */
function listOutputSubdirs(workDir) {
  const root = outputRoot(workDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * 运行期「有哪些数据集」的唯一口径：`output/<账号名>/data/index.json` 存在才算一份。
 *
 * 只认这个结构，**不要**再回退到 `data/`（旧结构）或 `fixtures/`（开发期概念）。
 * 兜底每扩大一处，就多一种「读到别人数据、却生成一份看着正常的报表」的可能。
 */
export function listOutputDatasets(workDir) {
  return listOutputSubdirs(workDir)
    .map((name) => join(outputRoot(workDir), name, 'data'))
    .filter((p) => existsSync(join(p, 'index.json')));
}

/** `output/<账号名>/report.html`，供截图脚本找产物。 */
export function listOutputReports(workDir) {
  return listOutputSubdirs(workDir)
    .map((name) => join(outputRoot(workDir), name, 'report.html'))
    .filter((p) => existsSync(p));
}
