# ADR-0048：拓展市场配置放在 bn-extension 目录，发布仓库从环境取得

- **状态**：2026-11-12 定案。
- **部分取代**：可见配置目录随 `create-bn-ext@0.1.0-alpha.1` 发行，后续模板的目录由 [ADR-0049](0049-hidden-extension-marketplace-config.md) 修订。
- **取代范围**：[ADR-0041](0041-extension-repository-source.md) 决策 2 和实施约定中的作者配置路径、仓库字段。

## 背景

拓展作者可以先在本地开发，再选择发布仓库。GitHub Actions 提供运行工作流的仓库名，本地发布时可以读取 Git 远端。将仓库名另存进市场配置，会让 fork 或改名后的工程还带着旧地址。

## 决策

1. 创建器将作者配置写入工程根下的 `bn-extension/marketplace.json`。文件保留 `schemaVersion: 1`、`name`、`namespace` 和 `owner`。根清单 `extension.json` 的 id 前缀须与 `namespace` 一致。
2. 创建向导只询问工程目录、拓展 ID 和显示名。默认生成的 Git 工程没有远端，`owner.name` 初值取拓展命名空间，作者可编辑。显式传入 `--repository owner/repo` 时，创建器预设 `origin`，并以 GitHub 所有者作为作者名初值。
3. 发布工具在 GitHub Actions 中使用 `GITHUB_REPOSITORY`，在本地使用 GitHub `origin` 的推送地址。

## 明确不做

新版发布工具只读取新路径，并拒绝配置中的 `repository` 字段。迁移由作者在升级工具时执行。

## 后果

旧工程升级时将 `.bn/marketplace.json` 移到新目录，再删除 `repository` 字段。继续使用旧版工具的工程仍按旧约定发布。BN 用户添加来源时沿用 ADR-0041 的固定索引地址。
