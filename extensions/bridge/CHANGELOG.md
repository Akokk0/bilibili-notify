# Changelog · 机器人框架桥接

拓展 `bridge` 的版本历史。它随 `ext/bridge@<VERSION>` git tag 单独发布,与独立端本体
的版本无关;发出去的包出现在拓展市场的官方索引里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/);每段标题下的第一段
是**概述**,会被抽进索引的 `notes`,市场那张卡上念的就是这句(≤ 120 字)。

---

## [0.0.1] — 2026-09-11

把 koishi / AstrBot 里配好的机器人借给 BN 当推送目标:插件那头填 BN 地址与 token,桥主动连过来,每个 bot 就是一条连接。

### Added

- 桥协议 1.3:握手、bot 名单、发消息与回执、入站消息、心跳;`ping` 带 `id` 时 `pong` 原样回,面板「测试」量得出真实往返
- 面板:接入(token)住拓展自己的设置里,每条接入可停用 / 重新生成 token;连接编辑器从连着的桥上挑 bot
- 能力按 bot 报:小程序卡三态、markdown 支持
- 一次性取图口:图片走 blob URL,桥自己来拿
