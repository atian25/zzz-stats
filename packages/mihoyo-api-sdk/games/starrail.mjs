import { authkeyAdapter } from './authkey.mjs';
// 未验证：没有星铁账号，登录授权与采集按原神形态实现，仅假网络测试。
// getLdGachaLog、21/22 与普通接口的关系仍未验证，不宣称完整频道覆盖。
export const starrail = authkeyAdapter({
  game: 'starrail', gameBiz: 'hkrpg_cn', channels: ['1', '2', '11', '12', '21', '22'],
  endpoint: 'https://public-operation-hkrpg.mihoyo.com/common/gacha_record/api/getGachaLog',
  verification: '未验证真实授权采集；实现仅按原神形态，只有假网络验收',
});
