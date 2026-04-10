---
"koishi-plugin-bilibili-notify-dynamic": minor
"koishi-plugin-bilibili-notify-live": patch
"koishi-plugin-bilibili-notify-image": patch
"koishi-plugin-bilibili-notify": patch
"@bilibili-notify/api": patch
"@bilibili-notify/push": patch
---

feat(dynamic): add AI comment on dynamic push notifications

fix(live): replace @node-rs/jieba with jieba-wasm to remove Koishi unsafe flag

fix(live): fix stale closed snapshot in closeListener causing connections to never close on dispose

fix(live): correct live status badge when pushed by live service

fix(image): extend retry delay and silence errors when Puppeteer browser crashes

fix(image): inline remote images before acquiring page to prevent idle timeout

style(image): remove white borders and shadows from avatars for flat design

refactor(live): extract word cloud and live summary into private methods

refactor(logger): replace new Logger() with ctx.logger() across all services
