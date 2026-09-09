# ADR-0007:dev 只做独立端,koishi / AstrBot 退到维护线

- **状态**:**已实现并 push**(2026-09-03 经 `/grill-me` 拍板,同日 10 个原子 commit + CI 修复;CI 与 `:test` 镜像绿)
- **记录方式**:⚠️ **事后追认** —— 据定案记录与已落地的实现整理,非当时原文。
- **影响面**:整个仓库布局(`koishi/` 与 `astrbot/` 连根拔掉)、桌面构建链路、`packages/*` 的宿主钩子、CI 与发版 workflow
- **🔗 后续**:「薄适配插件」那条路后来长成了 [ADR-0009](0009-bot-framework-bridge.md) 的桥接,再长成 [ADR-0012](0012-extensions.md) 的拓展

## 背景

仓里同时养着三个产品形态:koishi 插件、AstrBot 插件、独立端。三者共享 `packages/` 的业务核心,而核心为了同时伺候三个宿主,处处留着**可选钩子**(「宿主没注入就走旧路径」)。

主人 2026-09-03 的原话:「以后 dev 分支就只开发独立端了,koishi 和 astrbot 都停更了,以后要换成独立端加 adaptor 插件的形式桥接」。

## 决策

1. **koishi 与 AstrBot 一起从 dev 清理出去**,兼容配置全清,pnpm 回默认布局(isolated)。
2. **不切第二个分支,而是把 `koishi-maintenance` 改名成 `koishi-astrbot-maintenance`** —— 它基于清理前的 commit,天然含着 `astrbot/` 的最后状态。两端各自的发版 workflow 只认这条分支。
3. 🔴 **引擎层的宿主钩子一律改必填,删掉「不注入就走旧路径」那一半。** `packages/dynamic` / `live` / `push` / `image` 从此**只认独立端一个宿主**。留可选钩子等于永远替一个不存在的宿主背着一套分支。
4. **桌面版改吃 `apps/server/dist` 那份单文件 bundle**,`prepare-resources` 不再遍历 node_modules;资产清单 `scripts/server-bundle-assets.mjs` 三处共用。
5. **删掉 `koishi-bot` / `astrbot` 等平台字面量,但要保住适配器接入点** —— 未来是「**薄插件连到跑着的独立端**」,不是进程内嵌引擎。接入点是 `schema/targets.ts` 的平台 union + `apps/server/src/platforms/` 一平台一实现。

## 明确不做(拷问中被否决的)

- **只清 koishi、留着 astrbot**:两个一起清。
- **新开一条分支放维护线**:改名现有的那条(决策 2)。
- **给引擎层留「宿主可选」的钩子**:见决策 3。

## 后果

- **维护线那条分支仍是 hoisted + koishi 5.2.1 那一套,别往上套 dev 的规矩。**
- 收到 koishi / AstrBot 的 bug 报告,先说明两端已暂停、方向是桥接;真要修维护版就切过去。
- 清理当天 CI 首轮红过一次:**外层 node_modules 兜底的幻影依赖**(vitest / user-event)。这是「本地全绿、CI 干净安装才红」那一类,后来促成了「测试一律 `import ... from "vite-plus/test"`」这条规矩。
- 老仓库 `Akokk0/koishi-plugin-bilibili-notify` 已归档。

## 仍未决 / 未验

- tauri 全量构建当时约好交给下一次 tag(后来验过)。
- `:test` 镜像没真 `docker run` 起过。
