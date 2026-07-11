---
name: release
description: 走三端发版流程(koishi npm / 独立端 Docker+Desktop / AstrBot 独立仓)。Use when 用户要发版、发布新版本、打 tag 发布、跑 npm/Docker/astrbot 发布。
---

# 发版

三端发版机制**互不相同、节奏独立**:改 `koishi/package.json` 版本号只发 koishi、`v<VERSION>` tag 只发独立端、脚本只发 astrbot,**互不牵动**。**先确定发哪端**(用户没指明就先问清,别默认),再读对应清单按步执行:

- **koishi**(npm 包)→ 写 CHANGELOG + 改 `koishi/package.json` 的 `version` + push dev,即发布(**不可逆**,别顺手改这个字段)。读 [release-koishi.md](release-koishi.md)
- **独立端**(Server / Web / Desktop)→ 写 CHANGELOG + git tag `v<VERSION>` 触发 Docker + Desktop。读 [release-standalone.md](release-standalone.md)
- **AstrBot**(独立插件仓)→ 写 CHANGELOG + 改 `astrbot/core/metadata.yaml` 的 `version` + push dev,即发布(**不可逆**)。读 [release-astrbot.md](release-astrbot.md)

## 写 CHANGELOG 是发版的一部分

三端的发版清单**第一步都是「写 CHANGELOG」**,不是可选的收尾。规则三端共用,读 [changelog.md](changelog.md) —— 尤其是「**按端归属别靠目录猜**」那一节:`packages/*` 是三端共享的,但改了共享包**不代表三端都受影响**(各端只用了它的一部分能力),得去那一端的源码里验证它是否真的用到了被改的能力。判错就等于向用户承诺一个他根本得不到的修复。

**顺序在三端都要紧**:CHANGELOG 先落地,再碰扳机 —— koishi 的 `package.json#version`、AstrBot 的 `metadata.yaml#version`、独立端的 `v<VERSION>` tag。三个扳机都不可逆,漏了 CHANGELOG 只能补发一版。

版本号**永远由用户拍板**,不要自己决定。

机制总览(为什么分三端、tag 方案)见 `docs/agents/build-release.md`。
