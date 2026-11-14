---
name: release
description: 发布 BN 本体、SDK、创建器、官方拓展或 Docker 基座镜像。用户要求发版、发布 npm 工具或推送发行 tag 时使用。
---

# 发版

先从当前请求与已有决定确定发行对象，按下表读取对应流程。版本由主人确定；沿用对话中已明确的对象、版本、渠道和发布授权，只询问缺少或改变的决定。先完成对应流程要求的准备和验证，再执行获授权的公开发行。

| 发行对象 | 流程 |
| --- | --- |
| BN 本体，含 `@bilibili-notify/bn` | [本体发行](release-standalone.md)，tag 为 `v<VERSION>`，驱动 Docker、Desktop、npm 与应用内更新载荷 |
| SDK `@bilibili-notify/extension`、创建器 `create-bn-ext` | [手动 Actions 工具发行](release-tooling.md)，分别选择包及其版本 |
| `extensions/<id>/` 中的官方拓展 | [官方拓展发行](../../../docs/agents/extension-marketplace.md#官方的怎么发)，tag 为 `extension/<id>@<VERSION>`，驱动 `extension-release.yml`；先核对清单版本、更新记录和实际 ZIP，独立维护其市场条目 |
| Docker Chromium 基座镜像 | [基座镜像流程](../../../docs/agents/build-release.md#dockerfile)，手动运行 `base-image.yml`，使用独立的递增 `b<N>` tag；先推送基座，再更新 `BN_BASE_IMAGE`，不创建本体版本 tag |

仓外拓展按该工程的 README、市场配置和发行命令处理；它的 `v<VERSION>` 不触发 BN 本体的流水线。只更新技能或文档时按本地变更交付。

本体、npm 工具与官方拓展的共享全量门禁以 `gate.yml` 与[构建与发布参考](../../../docs/agents/build-release.md)为准，基座镜像按自身工作流校验。实际发布后分别核对产物与渠道；本地夹具、dry-run、某一条 Actions 成功不能代替全部获批对象的发行验收。

(Koishi 插件与 AstrBot 插件已暂停更新,维护线在 `koishi-astrbot-maintenance` 分支,各自的发版机制只在那条分支上;用户要发那两端的维护版时先切过去、按该分支的文档来,别在 dev 上找扳机。)
