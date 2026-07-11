# 写 CHANGELOG(三端共用)

发版流程的**必经一步**,不是可选的收尾。三端各写各的文件、同一套规则与格式:

| 端 | 文件 | 基线(上一个发布点) |
| --- | --- | --- |
| **koishi** | `koishi/CHANGELOG.md` | CHANGELOG 顶部版本(= `koishi/package.json#version`,可用 `npm view koishi-plugin-bilibili-notify version` 复核) |
| **独立端** | `apps/CHANGELOG.md` | 最新 tag:`git tag -l 'v*' --sort=-creatordate \| head -1` |
| **AstrBot** | `astrbot/CHANGELOG.md` | CHANGELOG 顶部版本(= `astrbot/core/metadata.yaml#version`) |

## 步骤

1. **定基线** — 见上表。完成:拿到一个具体的 tag / 版本。
2. **收集** — `git log <基线>..HEAD --oneline --no-merges`。完成:本批 commit 全部在手。
3. **按端归属** — 每条 commit 判断影响哪一端。**这一步最容易错,见下方专节**。完成:每条 commit 都归了端,或被判为「哪端都不写」。
4. **归类成稿** — 按 `### Added` / `### Changed` / `### Fixed` 写进对应文件。完成:符合下方「写法」的每一条。
5. **拍板** — 版本号 + CHANGELOG 摘要给用户确认。完成:用户明确同意。**不要自己决定版本号。**

## 按端归属:别靠目录猜

`packages/*` 是三端共享的(koishi 内联它们;`apps/server` 与 `astrbot/sidecar` 经 `workspace:*` 消费),但**共享 ≠ 三端都受影响**。一个包被改了,不代表用到它的每一端都感知得到 —— 各端只用了它的一部分能力。

**必须去那一端的源码里验证它是否真的用到了被改的能力。** 实例(2026-07-11 这批):

| commit | 改的地方 | 看起来 | 实际 |
| --- | --- | --- | --- |
| `5c8714f` | `packages/image`(koishi 内联了它) | 两端都受影响 | koishi 根本不调 `updateConfig`,零影响 |
| `7b6bd91` | `packages/internal` 的 schema | 两端都受影响 | koishi 端没有 qq-official adapter,零影响 |
| `974ed46` | `apps/web` | 独立端 | 确实只有独立端 |

验证手法就是 grep 那一端的源码 —— `koishi/src/`、`apps/`、`astrbot/sidecar/src/` + `astrbot/core/`:

```bash
grep -rl "qq-official\|backup" koishi/src/     # 0 → koishi 不涉及
grep -rl "updateConfig" koishi/src/            # 0 → 那个日志修复对 koishi 无效果
```

判错的代价是**在 CHANGELOG 里向用户承诺一个他根本得不到的修复**,或者反过来漏掉一个他需要知道的破坏性变更。

## 不写进 CHANGELOG 的

用户感知不到的一律不写:CI / workflow、构建工具链、`docs/`、`chore`、测试、重构。CHANGELOG 是写给用户的,不是提交历史的镜像。

判据:**这条改动会改变用户看到的行为、装到的东西、或者要动的手吗?** 不会 → 不写。

## 写法

风格两端统一(Keep a Changelog):

```md
## [0.2.0] — 2026-07-11

<一段概述:本版最值得说的一两件事,一句话讲完>

### Added

- <面向用户的描述> (hash)

### Fixed

- <面向用户的描述> (hash, hash)

---
```

- **版本标题** `## [版本] — YYYY-MM-DD`,版本之间用 `---` 分隔。
- **commit hash 放条目末尾的括号里**,多个用逗号分隔。(koishi 5.0.0-alpha.9 之前的旧条目是 changesets 生成的 `hash: 描述` 前缀格式,原样保留、不回改。)
- **写用户能感知的事,不写实现**。「玻璃片透明度改回默认存不下去」是用户的话;「`JSON.stringify` 丢弃 `undefined` 键」是我们的话。
- **一个功能一条,不按 commit 拆**。备份/恢复横跨 7 个 commit,写成一条,hash 全列。
- **坏了就说坏了**。「这个功能对用 QQ 官方机器人的人从第一天起就是坏的」——不粉饰、不含糊,用户需要知道自己是不是受影响的那一个。
- **发现上一版 CHANGELOG 写错了,在新版里更正**。alpha.8 漏列了 `-image`,照着它操作的用户会把一个已经无法工作的插件留在原地 —— 所以 alpha.9 里明确更正。错误不会因为发出去了就消失。
