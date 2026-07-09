---
"koishi-plugin-bilibili-notify": patch
"@bilibili-notify/ai": patch
"@bilibili-notify/api": patch
"@bilibili-notify/live": patch
"@bilibili-notify/storage": patch
"@bilibili-notify/subscription": patch
---

跟随 `@bilibili-notify/push` / `@bilibili-notify/internal` / `@bilibili-notify/image` 的本轮 alpha bump,补齐全部 internal dependent 包的 patch 版本号。

**为什么需要**:`.changeset/config.json` 设了 `updateInternalDependencies: "patch"`,本意是 dependent 自动 patch bump,但 pre 模式 + `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange` 组合下传播没生效,首轮 Version PR 只 bump 了 changeset 显式列出的 6 个包。结果:消费 push / internal / image 的 koishi/ 子插件(core / ai / image / live)与中间层 packages/*(api / ai / live / storage / subscription / koishi-runtime)版本号没动 → pnpm publish 跳过 → npm 上这些子插件 tarball 仍是上一版,内嵌 deps 范围还是 `^旧-alpha.0`,实际新装时靠 prerelease caret 兜底拿到新版 transitive deps,**运行时行为变了但 npm tag 没动 + changelog 看不到**。

显式列入本轮所有直接 / 间接 dependent,把版本号对齐,确保每个受影响的 npm 包都被重 publish 一次,changelog 完整记录。
