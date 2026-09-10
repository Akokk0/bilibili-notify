/**
 * `@bilibili-notify/contract` —— 独立端的 wire 契约:apps/server ↔ apps/web 的 HTTP/WS。
 *
 * ⛔ **拓展与它的对家之间那条 wire 不在这里** —— 那归拓展自己,住 `extensions/<id>/`
 * 并跟着它一起发版(ADR-0012 决策 36)。核心不该认识任何一个拓展的协议。
 *
 * 只放两端共同消费的**纯类型与纯常量**;运行时只允许依赖 internal 那个零依赖的
 * `constants` 子入口(绝不碰带 zod 的根入口):web 端 `import type` 零成本,server 端可放心
 * import 值(CHANNELS / LOG_LEVELS)。校验逻辑(zod schema)是服务端职责,留在 apps/server
 * 各自模块里,用这里的类型做注解防漂移。
 */
export * from "./devtools";
export * from "./maid-skill";
export * from "./resources";
export * from "./rest";
export * from "./skin";
export * from "./system";
export * from "./update";
export * from "./ws";
