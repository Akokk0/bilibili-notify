/**
 * `@bilibili-notify/contract` —— 独立端的 wire 契约。**两条 wire**:
 * 主体是 apps/server ↔ apps/web 的 HTTP/WS;`./bridge` 那条是 apps/server ↔
 * **独立发版的第三方桥接插件**,所以它自带协议版本号与演进纪律。
 *
 * 只放两端共同消费的**纯类型与纯常量**;运行时只允许依赖 internal 那个零依赖的
 * `constants` 子入口(绝不碰带 zod 的根入口):web 端 `import type` 零成本,server 端可放心
 * import 值(CHANNELS / LOG_LEVELS)。校验逻辑(zod schema)是服务端职责,留在 apps/server
 * 各自模块里,用这里的类型做注解防漂移。
 */
export * from "./bridge";
export * from "./devtools";
export * from "./maid-skill";
export * from "./resources";
export * from "./rest";
export * from "./skin";
export * from "./update";
export * from "./ws";
