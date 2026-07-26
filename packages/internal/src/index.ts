// AI 服务商注册表。本体在零依赖的 constants(设置页经 /constants 子路径消费),
// 这里给后端消费者补一条根入口的路 —— 与 FEATURE_KEYS 同样的两路一值。
export {
	AI_PROVIDER_IDS,
	AI_PROVIDERS,
	type AIProviderId,
	type AIProviderMeta,
	type AIProviderProfileShape,
	EMPTY_AI_PROVIDER_PROFILE,
	providerMeta,
	resolveAIProfile,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./constants";
export * from "./platform";
export * from "./schema";
export * from "./util";
