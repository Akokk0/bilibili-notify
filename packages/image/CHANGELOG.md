# Changelog

## 0.0.3-beta.4

### Patch Changes

- 8b6aa5a: feat(dynamic): add AI comment on dynamic push notifications

  fix(live): replace @node-rs/jieba with jieba-wasm to remove Koishi unsafe flag

  fix(live): fix stale closed snapshot in closeListener causing connections to never close on dispose

  fix(live): correct live status badge when pushed by live service

  fix(image): extend retry delay and silence errors when Puppeteer browser crashes

  fix(image): inline remote images before acquiring page to prevent idle timeout

  style(image): remove white borders and shadows from avatars for flat design

  refactor(live): extract word cloud and live summary into private methods

  refactor(logger): replace new Logger() with ctx.logger() across all services

- Updated dependencies [8b6aa5a]
  - @bilibili-notify/api@0.0.2-beta.2

## 0.0.3-alpha.3

### Patch Changes

- 40ebcbc: All bump
- Updated dependencies [40ebcbc]
  - @bilibili-notify/api@0.0.2-alpha.1

## 0.0.3-alpha.2

### Patch Changes

- Updated dependencies [ed0e7c9]
- Updated dependencies [a9b2cca]
  - @bilibili-notify/api@0.0.2-alpha.0

## 0.0.3-alpha.1

### Patch Changes

- 921f0ad: Workspace replace

## 0.0.3-alpha.0

### Patch Changes

- 2a11604: Alpha

## 0.0.2-alpha.0

### Patch Changes

- fdc2c7b: fix: move internal packages to devDependencies so they are bundled into the output

## [0.0.1] - 2026-04-04

### Added

- 首次发布
- 直播卡片渲染（开播 / 直播中 / 下播）
- 动态卡片渲染（图文、视频、专栏、转发等）
- SC（超级留言）卡片渲染
- 上舰（大航海）卡片渲染
- 弹幕词云图片生成
- 可配置卡片渐变背景色、底板颜色、边框、字体
- 图片渲染串行队列，避免 Puppeteer 并发问题
- 远程图片预取并内联为 base64，解决跨域渲染问题
- 图片缓存（TTL 30 分钟，最多 300 条）
