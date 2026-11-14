---
name: bn-extension-development
description: Develop and fix bilibili-notify extensions using the public SDK, in standalone projects or official workspace extensions. Use for sources, push adapters, ctx integration, packaging, and release dry-runs; not for changing the BN host itself.
---

# BN 拓展开发

在当前拓展工程中完成用户请求，保留项目已有的指引、能力范围和发行授权。此流程面向拓展，SDK 与创建器自身的 npm 发行属于各自的开发流程。

## 定位契约

从拓展工程根读取 `extension.json`、`package.json` 与 `README.md`，确认声明的是订阅来源、推送适配器还是两者，以及当前宿主兼容要求。先判断它是创建器生成的仓外工程，还是 BN 主仓 `extensions/<id>/` 中的官方拓展；命令与发行方式使用各自工程已定义的入口。

读取该工程实际使用的 SDK 的 `AGENT_GUIDE.md`。仓外工程的入口是 `node_modules/@bilibili-notify/extension/AGENT_GUIDE.md`，workspace 工程读取本仓 SDK 对应文档。具体实现再查同一 SDK 的 `DEVELOPMENT.md`、`index.d.mts` 和 `build.d.mts`；仓外所需资料随包提供，不依赖私有 BN 主仓。依赖尚未安装时先执行 `vp install`，所用 API 以实际安装的 SDK 与宿主兼容范围为准。

## 实现与验证

1. 把请求转换为公开可观察的行为，明确正常结果、失败和停用后的表现。沿现有公开测试入口先复现或补刻画，再修改；测试使用合成输入和受控的上游响应。
2. 订阅来源使用 `SourceDef`，推送适配器使用 `PlatformAdapterDef`；按已安装类型接线，副作用经 ctx。新增能力与当前清单声明对应，避免在契约之外接入宿主内部模块。
3. 运行实际构建入口，核对具名 `activate`、从 schema 导出的清单字段和自包含产物。接口类型通过不代表上报载荷、收尾或重试行为正确，按改动验证这些行为。
4. JS/TS 操作经 vp；执行项目脚本用 `vp run`，测试从 `vite-plus/test` 导入。创建器工程定向验证后运行已有的 `vp run verify`；其他工程按 `package.json` 和工程指引执行对应的 lint、格式、类型、测试、构建与 ZIP 校验。官方拓展使用主仓的包过滤和打包入口，不凭空添加 `verify` 脚本。

需要宿主联调时，读 SDK 作者指南的“源码拓展联调”。优先复用用户指定且兼容的开发宿主；需要新实例时，按实际发行状态选可用版本，对应包已发布时使用 `vp dlx @bilibili-notify/bn@alpha dev`；尚不可用时使用用户提供的本地成品，或按 BN 主仓指引启动源码宿主。源码开发 BN 使用主仓 `vp run dev:apps`，不把“源码已实现”当成“npm 包已发布”。

安装拓展依赖后，从拓展页挂载源码工程绝对路径；BN 负责加载 `src/index.ts`、监听和重载，工程无需先构建或单独启动。多个工程可挂到同一宿主。按改动核对预检失败保留旧实例、只重载对应项、解除不删除源码及停用语义。记录宿主版本和用途；结束时收掉自己新增的挂载和服务，保留用户原有实例及挂载。

## 打包与发布

仅做开发或打包时，以本地产物和验证结果交付。用户要求发行时，按工程类型读取对应流程：

- 仓外创建器工程使用 `.bn-extension/marketplace.json`；在 GitHub Actions 核对 `GITHUB_REPOSITORY`，在本地核对 `git remote get-url --push origin`，按 README 运行已有 `vp run release --tag v<清单版本> --dry-run`。
- BN 主仓的官方拓展使用主仓 `docs/agents/extension-marketplace.md`，无需创建 `.bn-extension/`；清单、更新记录与 `extension/<id>@<版本>` tag 对齐，沿官方工作流预检和发布。

dry-run 通过只证明本地校验与预览完成。真实发布按用户已授权的目标和版本执行；不要把“运行 dry-run”扩成发布授权。发布器负责版本 ZIP、校验值与固定索引的顺序；已有版本字节冲突时使用新版本，按文档接续中断任务。

交付说明修改、实际执行的命令及结果，并区分本地夹具、真实上游、真实 GitHub Actions 和真实发行各自验过的范围。
