---
"koishi-plugin-bilibili-notify": patch
"@bilibili-notify/api": minor
---

网络传输层从 axios 切换到基于 fetch 的实现

补发独立端 alpha.17 已实测通过、但此前从未随 koishi 侧 changeset 发布的传输层重写(实现早已合入,只是缺 changeset,koishi 用户此前一直依赖发布于该批改动之前的旧版 `@bilibili-notify/api`,未受益于这批降风控优化):

- 自带一个轻量 cookie jar(持久化格式与旧版兼容,升级不掉登录),逐跳捕获 Set-Cookie
- 为每个实例生成前后一致的浏览器指纹(User-Agent 与 sec-ch-ua 版本互相咬合),减少指纹错配招致的风控
- WBI 签名请求持续被风控时不再快速重试放大;粉丝数改用更轻量的关系接口拉取;直播间号解析结果与登录账号信息缓存复用不再重复请求
- 移除 axios / axios-cookiejar-support / tough-cookie / jsdom / luxon 依赖
