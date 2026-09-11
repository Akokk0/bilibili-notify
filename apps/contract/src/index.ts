/**
 * `@bilibili-notify/contract` —— 独立端的 wire 契约:apps/server ↔ apps/web 的 HTTP/WS。
 *
 * ⛔ **拓展与它的对家之间那条 wire 不在这里** —— 那归拓展自己,住 `extensions/<id>/`
 * 并跟着它一起发版(ADR-0012 决策 36)。核心不该认识任何一个拓展的协议。
 *
 * 只放两端共同消费的**纯类型与纯常量**,而且一律只从**零依赖的子入口**进 —— internal 的
 * `constants`、拓展那一面的 `@bilibili-notify/extension/wire`。两个包的**根**入口绝不碰:
 * 它们牵着 zod 与整个域模型,而这边要的只是几个形状。这么定的好处在两头:web 端
 * `import type` 零成本,server 端可放心 import 值(CHANNELS / LOG_LEVELS)。校验逻辑
 * (zod schema)是服务端职责,留在 apps/server 各自模块里,用这里的类型做注解防漂移。
 */

/**
 * 拓展的配置字段表与 bot 视图 —— 本体住 `@bilibili-notify/extension`(拓展要用它声明自己的
 * 表单),这里借一道给面板:web 只认 contract。同 `MiniAppCardSupport` 那条。
 */
export type { ExtensionBotView, ExtensionConfigField } from "@bilibili-notify/extension/wire";
export * from "./devtools";
export * from "./maid-skill";
export * from "./resources";
export * from "./rest";
export * from "./skin";
export * from "./system";
export * from "./update";
export * from "./ws";
