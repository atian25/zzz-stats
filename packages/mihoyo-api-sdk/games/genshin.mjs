import { authkeyAdapter } from './authkey.mjs';
// 原神 App → SToken → hk4e_cn 角色 → authkey → 三频道日志已有外部真实验证。
// 本包不计算 UP/保底；分页保留每页原始响应和字符串记录 ID。
export const genshin = authkeyAdapter({
  game: 'genshin', gameBiz: 'hk4e_cn', channels: ['301', '302', '200'],
  endpoint: 'https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog',
  verification: '协议已有外部真实端到端验证；本包仅假网络验收',
});
