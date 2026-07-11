---
name: release
description: 走三端发版流程(koishi npm / 独立端 Docker+Desktop / AstrBot 独立仓)。Use when 用户要发版、发布新版本、打 tag 发布、跑 npm/Docker/astrbot 发布。
---

# 发版

三端发版机制**互不相同、节奏独立**:改 `koishi/package.json` 版本号只发 koishi、`v<VERSION>` tag 只发独立端、脚本只发 astrbot,**互不牵动**。**先确定发哪端**(用户没指明就先问清,别默认),再读对应清单按步执行:

- **koishi**(npm 包)→ 改 `koishi/package.json` 的 `version` + push dev,即发布(**不可逆**,别顺手改这个字段)。读 [release-koishi.md](release-koishi.md)
- **独立端**(Server / Web / Desktop)→ git tag `v<VERSION>` 触发 Docker + Desktop。读 [release-standalone.md](release-standalone.md)
- **AstrBot**(独立插件仓)→ build + 脚本 squash push。读 [release-astrbot.md](release-astrbot.md)

机制总览(为什么分三端、tag 方案)见 `docs/agents/build-release.md`。
