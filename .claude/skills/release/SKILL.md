---
name: release
description: 走独立端发版流程(git tag 触发 Docker + Desktop + 应用内更新载荷)。Use when 用户要发版、发布新版本、打 tag 发布。
---

# 发版

独立端(Server / Web / Desktop)是 dev 上唯一的产品形态:**写 CHANGELOG + git tag `v<VERSION>`**,tag 同时触发 Docker 镜像、Desktop 安装包与应用内更新载荷,三者互不阻塞。读 [release-standalone.md](release-standalone.md) 按步执行。

(Koishi 插件与 AstrBot 插件已暂停更新,维护线在 `koishi-astrbot-maintenance` 分支,各自的发版机制只在那条分支上;用户要发那两端的维护版时先切过去、按该分支的文档来,别在 dev 上找扳机。)

## 写 CHANGELOG 是发版的一部分

发版清单**第一步是「写 CHANGELOG」**,不是可选的收尾。规则读 [changelog.md](changelog.md)。

**顺序要紧**:CHANGELOG 先落地,再碰 `v<VERSION>` tag —— tag 不可逆,漏了 CHANGELOG 只能补发一版。

版本号**永远由用户拍板**,不要自己决定。

机制总览(tag 方案、三条 workflow)见 `docs/agents/build-release.md`。
