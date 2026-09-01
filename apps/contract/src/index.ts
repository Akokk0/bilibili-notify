/**
 * `@bilibili-notify/contract` —— 独立端(apps/server ↔ apps/web)的 HTTP/WS wire 契约。
 *
 * 只放两端共同消费的**纯类型与纯常量**,保持零运行时依赖:web 端 `import type` 零成本,
 * server 端可放心 import 值(CHANNELS / LOG_LEVELS)。校验逻辑(zod schema)是服务端
 * 职责,留在 apps/server 各自模块里,用这里的类型做注解防漂移。
 */
export * from "./maid-skill";
export * from "./rest";
export * from "./skin";
export * from "./update";
export * from "./ws";
