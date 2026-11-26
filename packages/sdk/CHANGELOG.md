# Changelog

## [0.1.2](https://github.com/atian25/zzz-stats/compare/zzz-stats-sdk-v0.1.1...zzz-stats-sdk-v0.1.2) (2026-11-26)


### 文档

* **sdk:** 补 README，覆盖安装、五个导出与调用示例 ([69c6f9e](https://github.com/atian25/zzz-stats/commit/69c6f9e735889bc11fe09669113d1292546778e9))
* 合并包级 AGENTS 到仓库根目录 ([249135a](https://github.com/atian25/zzz-stats/commit/249135a9f0cf56ee733325b5bb0639a80bc2a54d))

## [0.1.1](https://github.com/atian25/zzz-stats/compare/zzz-stats-sdk-v0.1.0...zzz-stats-sdk-v0.1.1) (2026-11-26)


### 新增

* **release:** 配 release-please 与 npm 可信发布 ([0852b1d](https://github.com/atian25/zzz-stats/commit/0852b1d7c5d9fbb2444ad9093a7840e791427492))


### 修复

* **sdk:** 关闭自启浏览器，隔离 CDP 标签页并透传连接地址 ([bfec7b7](https://github.com/atian25/zzz-stats/commit/bfec7b7e674be44665617fdbd20ed62ec03f4d15))


### 重构

* **sdk:** 二维码改用 qrcode，移除 vendor 路径与手写 PNG ([f56d907](https://github.com/atian25/zzz-stats/commit/f56d907af6ce9045afa3bed0c4fa9b754ca79f7d))
* **sdk:** 收敛五个公共接口，剥离宿主策略并贯通事件与取消 ([672e842](https://github.com/atian25/zzz-stats/commit/672e8423ba4e5404d01f73eec612d5b22cdad636))
* **sdk:** 输入回调化，文件与 stdin 移到 CLI 适配器 ([7a8f10b](https://github.com/atian25/zzz-stats/commit/7a8f10bdd341bea300d05b3e0ce84ba2ae5f0189))
* **sdk:** 驱动改为正常模块解析与显式注入，移除宿主 profile 搜索 ([1c8d7aa](https://github.com/atian25/zzz-stats/commit/1c8d7aad9529a89c871fee5d71fca324d5fb3ce9))
* **skill:** 改为依赖 SDK 包，规则文档移出 skill ([7ec3748](https://github.com/atian25/zzz-stats/commit/7ec3748a7164c6ab28d493be8411c78822e98f59))
* **test:** 用例按层拆分，api.md 跟着采集走 ([e373aae](https://github.com/atian25/zzz-stats/commit/e373aae5eebeeaba9c84245c06db61b13de91336))
* 加 pnpm workspace 与三个包定义，服务改用包名 import ([6c1c277](https://github.com/atian25/zzz-stats/commit/6c1c27733576536341481c4a6f01150f78b6a54e))
* 采集进 packages/sdk，报表渲染器留在 skill/lib，服务搬到 packages/server ([681f0d6](https://github.com/atian25/zzz-stats/commit/681f0d6ccdbd3683a25f469a4b0ac2045f30075d))


### 文档

* **readme:** 截图改为固定高度，露出详情最近 10 条记录 ([16554f6](https://github.com/atian25/zzz-stats/commit/16554f6eeaad5ae4444cc1438e494557bf972020))
* **readme:** 报表截图延到详情区，露出最近 5 个角色 ([2ca58a4](https://github.com/atian25/zzz-stats/commit/2ca58a450b4e9fc696f9dfcbc11cd856a1ce370f))
* **readme:** 预览图重新截，补上打码 ([414551d](https://github.com/atian25/zzz-stats/commit/414551d3e64fb622d3b36bb485ca4b13198bc9e5))
* **sdk:** 更新公共契约、基线修复状态与资源限制 ([6d7646b](https://github.com/atian25/zzz-stats/commit/6d7646b4d95959b256df21a2edcb790f39719e41))
* 注释与 SKILL.md 里的旧路径同步到 packages/sdk 与 packages/server ([8649054](https://github.com/atian25/zzz-stats/commit/8649054212421af57ee9edc7e40197d18e160aa1))
* 补 SDK 与 server 的分层文档，规范迁到仓库 docs ([a6c08ad](https://github.com/atian25/zzz-stats/commit/a6c08ad6b42b80662de8c688fd4f7924ce38bf62))
