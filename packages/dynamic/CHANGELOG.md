# Changelog

## 0.0.3-alpha.3

### Patch Changes

- 40ebcbc: All bump
- Updated dependencies [40ebcbc]
  - @bilibili-notify/api@0.0.2-alpha.1
  - koishi-plugin-bilibili-notify@4.0.0-alpha.5
  - @bilibili-notify/internal@0.0.2-alpha.0
  - @bilibili-notify/push@0.0.2-alpha.0

## 0.0.3-alpha.2

### Patch Changes

- Updated dependencies [ed0e7c9]
- Updated dependencies [a9b2cca]
  - @bilibili-notify/api@0.0.2-alpha.0
  - koishi-plugin-bilibili-notify@4.0.0-alpha.4

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
- 通过 cron 定时轮询 UP 主最新动态（默认每 2 分钟）
- 支持图文、视频、专栏、转发等各类动态类型
- 动态屏蔽过滤（关键词、正则、白名单）
- 视频动态支持附带 BV 号链接
- 可选接入 `bilibili-notify-image` 生成动态卡片图片
