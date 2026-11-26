import { loginByAppQr } from '../auth/app.mjs';
import { SdkError } from '../common/errors.mjs';

export function placeholder({ game, channels, endpoint, verification }) {
  return Object.freeze({
    game, login: loginByAppQr, channels: Object.freeze(channels), endpoint, verification,
    /**
     * @param {{credential:object, role:object, channels?:string[], signal?:AbortSignal,
     * onProgress?:Function, dependencies?:object}} options
     * 未来各游戏返回各自原样结果，不统一聚合壳、不做 UP/保底统计。
     */
    async collect(options = {}) {
      throw new SdkError('NOT_IMPLEMENTED', `${game} 抽卡采集尚未实现`, { stage: 'collect' });
    },
  });
}
