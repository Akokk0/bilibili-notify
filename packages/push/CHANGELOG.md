# Changelog

## 0.0.2-beta.1

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

## 0.0.2-alpha.0

### Patch Changes

- 40ebcbc: All bump

## [0.0.1] - 2026-04-04

### Added

- 首次发布
- UID → 推送目标映射（`PushArrMap`）
- 按推送类型路由消息（直播、动态、SC、上舰、词云、直播总结、特别关注弹幕、特别关注进场）
- 多 Bot 故障转移与自动重试
- 推送限流（消息间隔 500ms）
- 管理员私信错误通知
