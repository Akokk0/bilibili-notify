// AI 服务商注册表。本体在零依赖的 constants(设置页经 /constants 子路径消费),
// 这里给后端消费者补一条根入口的路 —— 与 FEATURE_KEYS 同样的两路一值。
// 失败规矩的零件(ADR-0026)。本体在零依赖的 constants(面板经 /constants 子路径消费),
// 这里给后端补一条根入口的路。

export * from "./auth-state";
export * from "./bilibili-guard";
export {
	type ActivePersonaShape,
	AI_PROVIDER_IDS,
	AI_PROVIDERS,
	type AIPersonaShape,
	type AIPresetShape,
	type AIProviderId,
	type AIProviderMeta,
	type AIProviderProfileShape,
	API_FLAVOR_IDS,
	type APIFlavorId,
	addressNounFor,
	aiProfileAt,
	BILIBILI_SOURCE_KEY,
	BUILTIN_AI_PRESETS,
	CONNECTION_PLATFORMS,
	type ConnectionPlatform,
	canReceiveReply,
	colorFromSeed,
	countsAsDelivery,
	countsAsFailure,
	DEFAULT_HISTORY_RETENTION_DAYS,
	DEFAULT_ROAST_SCHEDULE,
	DIVIDER_TYPE,
	EMPTY_AI_PROVIDER_PROFILE,
	extensionColorSeed,
	FAILURE_CODES,
	type Failure,
	type FailureCode,
	fail,
	featuresForEvents,
	HISTORY_RETENTION_DAY_OPTIONS,
	type HistoryRetentionDays,
	type Identity,
	IMAGE_REF_EXTENSIONS,
	IMAGE_REF_PATTERN,
	type ImageRef,
	type Issue,
	identityColor,
	isMirrorPrefix,
	isPrivateTarget,
	issuesFromZod,
	isTargetPaused,
	isWebhookPlatform,
	LINK_LIMITS,
	LINK_REPLY_FORMS,
	type LinkLimits,
	type LinkReplyForm,
	listsForLinkParsing,
	MIRROR_PREFIX_RE,
	ok,
	PLATFORM_REGISTRY,
	PUSH_STATUSES,
	platformDescriptor,
	providerMeta,
	RESERVED_EXTENSION_IDS,
	RESERVED_INTEGRATION_KEYS,
	type Result,
	resolveActivePersona,
	resolveAIProfile,
	resolveChatThinkingLevel,
	type SourceKey,
	SUBSCRIPTION_EVENT_FEATURES,
	sameIdentity,
	shouldSendAtAll,
	subscriptionIdentityOf,
	THINKING_LEVELS,
	type ThinkingLevel,
	UP_COLORS,
	type UpColorIdentity,
	upColor,
	WEB_SEARCH_BACKEND_IDS,
	WEB_SEARCH_BACKENDS,
	WEBHOOK_PLATFORMS,
	type WebhookPlatform,
	type WebSearchBackendId,
	type WebSearchBackendMeta,
	webSearchBackendMeta,
} from "./constants";
export * from "./format";
export * from "./key-value-store";
export * from "./link-preview";
export * from "./live-monitor";
export * from "./membership";
export * from "./platform";
export * from "./platform-descriptor";
export * from "./post";
export * from "./problem";
/**
 * 推送源契约 —— 核心的三个 adapter 与拓展的桥都实现它。见 `push-source.ts` 的文件头。
 */
export {
	type AddressCandidate,
	type ConnectionAuth,
	type ConnectionCandidate,
	type InboundGroupMessage,
	type InboundHandlers,
	type InboundMeta,
	type InboundPrivateMessage,
	inboundIdentity,
	type PlatformAdapter,
	type PlatformAdapterContext,
	type ProbeResult,
} from "./push-source";
export * from "./schema";
export * from "./source";
export * from "./util";
