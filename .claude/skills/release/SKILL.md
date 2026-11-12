---
name: release
description: 发布本体或SDK/创建器。Use when 用户要发版、发布npm工具或打tag。
---

# 发版

先按发行对象选流程：SDK `@bilibili-notify/extension` 或创建器 `create-bn-ext` 走 [手动Actions工具发行](release-tooling.md)；本体走下方tag流程。版本号**永远由用户拍板**。

独立端(Server / Web / Desktop)是 dev 上唯一的产品形态:**写 CHANGELOG + git tag `v<VERSION>`**,tag 同时触发 Docker 镜像、Desktop 安装包、npm成品与应用内更新载荷,四者互不阻塞。读 [release-standalone.md](release-standalone.md) 按步执行。

(Koishi 插件与 AstrBot 插件已暂停更新,维护线在 `koishi-astrbot-maintenance` 分支,各自的发版机制只在那条分支上;用户要发那两端的维护版时先切过去、按该分支的文档来,别在 dev 上找扳机。)

机制总览(tag 方案、四条 workflow)见[构建与发布参考](../../../docs/agents/build-release.md)。
