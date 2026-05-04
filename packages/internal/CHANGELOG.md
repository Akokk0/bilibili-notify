# Changelog

## 0.0.3

### Patch Changes

- 7d01398: 修复账号失效时控制台仍显示「已登录」、整天无推送的 bug，并重构登录态管线：

  - BilibiliAPI 在响应体识别到 code -101 时通过新的 `onAuthLost` 回调通知上层
    （60 秒防抖），cookie 刷新返回 -101 时也走同一路径，不再静默重置 HTTP
    客户端。
  - 新增 `LoginStatusController` 集中管理登录态：所有 14 处 emit 收敛到
    reporter；启动期 `getMyselfInfo` 返回 -101 不再误报 LOGGED_IN；之前静默
    swallow 的异常路径也会上报。控制器只在 `(status, msg, data)` 实际变化
    时 emit，避免心跳带来的 UI 抖动。
  - 新增配置项 `loginHealthCheckMinutes`（默认 30 分钟，范围 5–180），在已
    登录态下定期 probe，运行中失效会立即翻转 UI、广播内部事件
    `bilibili-notify/auth-lost`；恢复后广播 `bilibili-notify/auth-restored`，
    让 dynamic / live 自动重启检测，无需手动重启插件。
  - live 删除手写的 3 次 retry（API 层已 retry 3 次），失败时改为 emit
    `plugin-error` 而非静默 return。
  - 新增调试命令 `bili status auth` 查看当前登录状态。
  - 控制台 UI 删除一闪而过的「登录成功」中转视图（与「已登录」重复）及无
    listener 的「重启插件」按钮。
  - `BiliLoginStatus` 枚举删除 `LOGGING_IN`（从未 emit）与 `LOGIN_SUCCESS`
    （已被 `LOGGED_IN` 取代），故 api 包按 minor 级别 bump。
  - 工具函数 `withLock` 提升到 `@bilibili-notify/internal` 供后续复用。
  - 修复 `auth-restored` 在"运行中失效 → 扫码恢复"路径下不会触发的回归：
    之前用"上一帧 status === NOT_LOGIN"作判据，但失效后用户扫码会经过
    LOGIN_QR / LOGGING_QR 中间态，导致 dynamic / live 永远收不到恢复事件
    无法重启监测；改用 sticky 的 `needsRestore` 标志解决。
  - 修复登录刚成功瞬间 controller 把 LOGIN_QR 留下的 base64 字符串作为
    `data` fallback 传给前端，导致前端访问 `data.card.face` 抛错的小问题；
    现在仅当 `snapshot.data` 形态像 card 时才沿用，前端也加了 `data?.card`
    的安全访问。
  - 整理 `UserCardInfoData` 类型：拆出 `UserCard` / `UserCardSpace` /
    `UserCardInfo` 子类型并补齐控制台 UI 实际使用的 `attention` /
    `vip.vipStatus` / `vip.label.img_label_uri_hans_static` / `space.l_img`
    字段，删除前端 settings.vue 内联的 80+ 行 workaround 类型定义。
  - 收敛 `auth-lost` 事件来源：由 api response interceptor 的
    `onAuthLost` 回调单点广播，dynamic 在 -101 分支不再重复 emit；同时
    删除 dynamic 自己的"账号未登录"私信，避免与 server-manager 节流私
    信内容重复。

## 0.0.2

### Patch Changes

- 40ebcbc: All bump

## 0.0.2-alpha.0

### Patch Changes

- 40ebcbc: All bump

## [0.0.1] - 2026-04-04

### Added

- 首次发布
- `BILIBILI_NOTIFY_TOKEN` Symbol，用于内部包安全访问核心服务
