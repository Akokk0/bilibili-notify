---
name: release-notes
description: 写 bilibili-notify 三端(独立端/koishi/AstrBot)发布公告,按增删改组织、压到 600 字内。Use when 用户要写或更新 release notes / 更新公告 / 发版公告,或发版后整理对外更新说明。
---

# 写发布公告

bilibili-notify **三端**(独立端 / koishi / AstrBot)合并成**一份**公告,正文按 CHANGELOG 的**增删改**组织。

## 步骤

1. **收集素材** —— 三端本次更新:独立端读 `apps/CHANGELOG.md`、AstrBot 读 `astrbot/CHANGELOG.md` 的最新版本段;koishi 读本次发版消费的 changeset(`vp exec changeset status --since=origin/main` 看新增,配 `.changeset/*.md` 取描述)。完成:三端的本次变更项都已列出。
2. **归类成稿** —— 按下方骨架与规则写成 `release-notes/<版本>.txt`。完成:每条都归入某一增删改类、端归属正确。
3. **压字数** —— `wc -m release-notes/<版本>.txt`,字符数 **≤ 600**。超了就砍括号补充 / 命令 / 警告细节,不砍条目。完成:`wc -m` ≤ 600。

## 文件

- 路径 `release-notes/<版本>.txt`(该目录 gitignored,公告不入库)。
- `<版本>` = 最新独立端 tag 去掉 `v`:`git tag -l 'v0.1.0-alpha.*' --sort=-creatordate | head -1` → 如 `0.1.0-alpha.11`。纯 AstrBot 单独公告才加 `astrbot-` 前缀(避免与独立端同版本号体系撞)。

## 骨架

```
【bilibili-notify 更新公告 · YYYY-MM-DD】

独立端 v0.1.0-alpha.N
koishi (core vX | dyn vY)
AstrBot vZ

【新增】
- … (端)
【修复】
- … (端)
【变更】
- … (端)
```

## 规则

- **版本号全部堆在标题下方**,每端一行;正文**不按端分块**。
- **正文按增删改分类**(`【新增】【修复】【变更】`,必要时 `【移除】`),不按功能模块、不按端。
- 朴素 `【】` 分类,**无** ■ / 分隔线 / 花哨符号。
- 端独有项 → 条末 `()` 标端(`(koishi)` / `(独立端)` / `(AstrBot)`);**通用项不标**。
- 面向用户:去掉 commit hash、命令行、内部实现细节,只留用户能感知的变化。
