# ADR-0041：仓库源映射到固定Release索引

- **状态**：2026-11-10主人批准固定Release附件方案；进度见[第6期计划](../1.0/phase-6-plan.md)。
- **影响面**：第三方市场添加入口、`.bn/`作者配置、创建器和发布模板。
- **延伸**：[ADR-0013](0013-extension-marketplace.md)；需求见[Issue #56](https://github.com/Akokk0/bilibili-notify/issues/56)。

## 背景

现有市场需要完整HTTPS索引地址。Issue #56希望填写`作者/仓库名`即可添加来源，并提供创建和发布工具。拓展仍需先构建成发行包，不能取仓库源码直接执行。

## 决策

1. GitHub仓库简写和仓库URL映射到固定滚动Release中的`marketplace.json`附件；完整HTTPS索引地址继续可用。
2. 根目录保留`extension.json`，`.bn/`只放作者配置；发布模板由配置和构建产物生成完整索引，上传固定Release。
3. 复用既有包URL、sha256、大小、契约要求、命名空间、选版、下载校验和安装规则。
4. 仓库简写只负责发现索引，不改变第三方源的信任级别，GitHub账号名也不代替索引中的命名空间。

## 明确不做

- 不在每次发版后将生成索引提交回源码仓库。
- 不另建依赖GitHub查询API寻找最新Release的发现流程。
- 不跳过包校验，也不移动根清单来配合市场约定。

## 后果

作者需保留固定索引Release及附件，发布模板负责更新。客户端将仓库输入归一到现有来源地址，沿用市场处理；输入弹窗只做局部调整。

## 实现约定（6-03）

固定标签为`bn-marketplace`，附件名为`marketplace.json`。`owner/repo`和GitHub仓库首页网址（含`.git`、末尾斜杠）归一到`https://github.com/owner/repo/releases/download/bn-marketplace/marketplace.json`；仓库大小写不构成不同来源。普通HTTPS索引地址仍原样使用。

作者配置放在`.bn/marketplace.json`，版本1，包含`schemaVersion`、`repository`（GitHub的`owner/repo`）、`name`、`namespace`与`owner`（`name`和可选`url`）；创建器和发布器负责校验。`namespace`独立填写，必须与根清单id的前段一致，不由GitHub账号推断；固定标签和附件名不做逐仓配置。

本轮只支持无需认证即可访问索引和ZIP的公开仓库；不新增私有仓库令牌、权限或登录入口。完整HTTPS输入仍按既有流程处理，不能访问时如实报取源失败。新增钉版本的使用方式不在本次批准范围中。
