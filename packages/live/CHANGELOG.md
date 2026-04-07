# Changelog

## 0.0.3-alpha.2

### Patch Changes

- 40ebcbc: All bump
- Updated dependencies [40ebcbc]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.5
  - @bilibili-notify/internal@0.0.2-alpha.0
  - @bilibili-notify/push@0.0.2-alpha.0

## 0.0.3-alpha.1

### Patch Changes

- 921f0ad: Workspace replace
- Updated dependencies [921f0ad]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.3

## 0.0.3-alpha.0

### Patch Changes

- 2a11604: Alpha
- Updated dependencies [2a11604]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.2

## 0.0.2-alpha.0

### Patch Changes

- fdc2c7b: fix: move internal packages to devDependencies so they are bundled into the output
- Updated dependencies [fdc2c7b]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.1

## [0.0.1] - 2026-04-04

### Added

- 首次作为独立插件发布（原属核心包）
- 通过 WebSocket 实时监听 B 站直播间
- 开播 / 直播中 / 下播推送
- SC（超级留言）推送
- 上舰（大航海）推送
- 直播结束弹幕词云生成
- 直播结束直播总结生成
- 特别关注用户弹幕通知
- 特别关注用户进入直播间通知
- 自定义开播 / 直播中 / 下播消息模板
- 自定义上舰消息模板及舰长图片链接
- 可选接入 `bilibili-notify-image` 生成卡片图片
