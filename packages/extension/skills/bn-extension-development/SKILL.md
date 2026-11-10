---
name: bn-extension-development
description: Develop and fix standalone bilibili-notify extensions using the public SDK. Use for subscription sources, push adapters, ctx integration, extension packaging, and release dry-runs; not for changing the BN host itself.
---

# BN 拓展开发

在当前拓展工程中完成用户请求，保留项目已有的指引、能力范围和发行授权。此流程面向拓展，SDK 与创建器自身的 npm 发行属于各自的开发流程。

## 定位契约

从项目根读取 `extension.json`、`package.json` 与 `README.md`，确认声明的是订阅来源、推送适配器还是两者，以及当前宿主兼容要求。

读取已安装 SDK 的 `node_modules/@bilibili-notify/extension/AGENT_GUIDE.md`。具体实现再查同目录的 `DEVELOPMENT.md`、`index.d.mts` 和 `build.d.mts`；这些资料随包提供，不需要私有 BN 主仓。依赖尚未安装时先执行 `vp install`。

## 实现与验证

1. 把请求转换为公开可观察的行为，明确正常结果、失败和停用后的表现。沿现有公开测试入口先复现或补刻画，再修改；测试使用合成输入和受控的上游响应。
2. 订阅来源使用 `SourceDef`，推送适配器使用 `PlatformAdapterDef`；按已安装类型接线，副作用经 ctx。新增能力与当前清单声明对应，避免在契约之外接入宿主内部模块。
3. 运行实际构建入口，核对具名 `activate`、从 schema 导出的清单字段和自包含产物。接口类型通过不代表上报载荷、收尾或重试行为正确，按改动验证这些行为。
4. JS/TS 操作经 vp；执行项目脚本用 `vp run`。定向验证改动后运行 `vp run verify`，让 lint、格式、类型、测试、构建和 ZIP 校验共同通过。测试从 `vite-plus/test` 导入运行入口。

## 打包与发布

仅做开发或打包时，以本地产物和验证结果交付。用户要求发行时，先读项目 README 的发布与恢复流程，核对 `.bn/marketplace.json`、清单版本和目标仓库，再运行 `vp run release --tag v<清单版本> --dry-run`。

dry-run 通过只证明本地校验与预览完成。真实发布按用户已授权的目标和版本执行；不要把“运行 dry-run”扩成发布授权。发布器负责版本 ZIP、校验值与固定索引的顺序；已有版本字节冲突时使用新版本，按文档接续中断任务。

交付说明修改、实际执行的命令及结果，并区分本地夹具、真实上游、真实 GitHub Actions 和真实发行各自验过的范围。
