/**
 * `@bilibili-notify/contract` —— 独立端的 wire 契约:apps/server ↔ apps/web 的 HTTP/WS。
 *
 * ⛔ **拓展与它的对家之间那条 wire 不在这里** —— 那归拓展自己,住 `extensions/<id>/`
 * 并跟着它一起发版(ADR-0012 决策 36)。核心不该认识任何一个拓展的协议。
 *
 * 只放两端共同消费的**纯类型与纯常量**,而且一律只从 internal 的**零依赖子入口**进 ——
 * 各领域子入口与拓展那一面的 `@bilibili-notify/internal/extension/wire`。internal 的**根**入口只许
 * `import type`(编译期擦掉),**值**绝不从根进:它们牵着 zod 与整个域模型,而这边要的只是几个形状。这么定的好处在两头:web 端
 * `import type` 零成本,server 端可放心 import 值(CHANNELS / LOG_LEVELS)。校验逻辑
 * (zod schema)是服务端职责,留在 apps/server 各自模块里,用这里的类型做注解防漂移。
 */

export type {
	PlatformAdapterDescriptor,
	SettingsField,
	SettingsListField,
	SettingsScalarField,
} from "@bilibili-notify/internal";
/**
 * 拓展的设置项 / 外观 / bot 视图 / 状态视图(积木)—— 本体住
 * `@bilibili-notify/internal/extension/wire`(拓展门与宿主都从那里取),这里借一道给面板:
 * web 只认 contract。同 `CapabilitySupport` 那条。
 */
export type {
	ExtensionBlock,
	ExtensionButton,
	ExtensionItemView,
	ExtensionTableCell,
	ExtensionTableColumn,
	ExtensionTone,
	ExtensionView,
	ExtensionViewSummary,
	ExtensionViewText,
	ExtensionViewTextSegment,
} from "@bilibili-notify/internal/extension/wire";
export * from "./builtin-sources";
export * from "./card-skin";
export * from "./devtools";
export * from "./extension-view";
export * from "./health";
export * from "./maid-skill";
export * from "./nouns";
export * from "./persona";
export * from "./resource-import";
export * from "./resources";
export * from "./rest";
export * from "./skin";
export * from "./system";
export * from "./update";
export * from "./ws";
