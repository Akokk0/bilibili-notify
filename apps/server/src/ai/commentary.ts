import {
	CommentaryGenerator,
	PROMPT_NEUTRAL_NOUNS,
	webSearchExecutorFromSettings,
} from "@bilibili-notify/ai";
import type {
	CreatorCandidate,
	CreatorProfileReport,
	GlobalSettings,
	Identity,
	Logger,
	Result,
	ServiceContext,
} from "@bilibili-notify/internal";
import { resolveAIProfile } from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { logText, t } from "../i18n/index.js";
import type { LiveTable } from "../live/live-table.js";
import { builtinPersonasOf, toGeneratorConfig } from "../runtime/ai-config.js";
import type { SubscriptionStateStore } from "../runtime/subscription-state-store.js";
import {
	platformLabelOf,
	sourceNounsFor,
	subscriptionIdentityLabelOf,
} from "../subscriptions/platform-label.js";
import type { SourceRegistry } from "../subscriptions/registry.js";
import type { SourceStatusReader } from "../subscriptions/source-status.js";
import type { CreatorStatsReader } from "./creator-stats.js";
import { attachReadOnlyTools, type LiveNowReader } from "./read-only-tools.js";
import type { AiToolProviderRegistry } from "./tool-provider-registry.js";

export interface CommentaryDeps {
	serviceCtx: ServiceContext;
	globals: () => GlobalSettings;
	logger: Logger;
	subscriptionStore: SubscriptionStore;
	subscriptionStateStore: SubscriptionStateStore;
	sources: SourceRegistry;
	extensionPlatformLabel?: (extensionId: string) => string | undefined;
	extensionPostNoun?: (extensionId: string) => string | undefined;
	searchCreators(
		sourceKey: string,
		query: string,
	): Promise<Result<{ candidates: CreatorCandidate[] }>>;
	fetchProfile(identity: Identity, signal?: AbortSignal): Promise<Result<CreatorProfileReport>>;
	liveTable?: Pick<LiveTable, "get">;
	sourceStatus: SourceStatusReader;
	creatorStats?: CreatorStatsReader;
	aiToolProviders: AiToolProviderRegistry;
}

// ---------- AI (optional) ----------
// 构造仅依赖 apiKey / baseUrl 是否齐备 —— 与 `enabled` 解耦,后者交给作品与直播设置里
// 折好的 aiEnabled 在每次推送前热判断。这样用户在 dashboard 把 AI 开关切关再切开
// 不需要重启服务。配置变了走下方 `reloadCommentary`。
//
// `AiSettings` → CommentaryGeneratorSettings 的翻译(含字段改名与「人格看指针」)
// 本体在 `runtime/ai-config.ts` —— 「试一句」与统计页的锐评用的是同一份映射,人格该
// 从哪儿读只能有一个答案。指针指向一个还没添加的服务商时 resolveAIProfile 兜一套
// 空值回来,下方 createCommentary 的 `!p.apiKey || !p.baseUrl` 就会照既有规矩停用 AI。
const buildAiConfig = (deps: CommentaryDeps) =>
	toGeneratorConfig(deps.globals().ai, builtinPersonasOf(deps.globals()));

const liveNowReader = (deps: CommentaryDeps): LiveNowReader | undefined => {
	const table = deps.liveTable;
	if (!table) return undefined;
	// `row` 直接是在播表的行(`{ startedAt, details }`),AI 工具那头读新形状。
	return {
		row: (id) => table.get(id),
		running: (sourceKey) => deps.sourceStatus.running(sourceKey),
	};
};

export function createCommentary(deps: CommentaryDeps): CommentaryGenerator | null {
	const p = resolveAIProfile(deps.globals().ai);
	if (!p.apiKey || !p.baseUrl) return null;
	const labelDeps = {
		sources: deps.sources,
		extensionPlatformLabel: deps.extensionPlatformLabel,
		extensionPostNoun: deps.extensionPostNoun,
	};
	try {
		const c = new CommentaryGenerator({
			serviceCtx: deps.serviceCtx,
			config: buildAiConfig(deps),
			toolNouns: (keys) =>
				sourceNounsFor(
					keys,
					{ ...labelDeps, subscriptions: () => deps.subscriptionStore.list() },
					{
						creatorNoun: t("nouns.creator"),
						postNoun: t("nouns.post"),
						sources: t("nouns.sources"),
					},
				),
			nouns: (keys) =>
				sourceNounsFor(
					keys,
					{
						...labelDeps,
						subscriptions: () => deps.subscriptionStore.list(),
					},
					PROMPT_NEUTRAL_NOUNS,
				),
		});
		// 接工具能力 —— **只读档**。少了这一步,女仆连「我订了哪些 UP」都查不到,
		// 会一口咬定「当前没有订阅」;带上写能力则等于让她能真的加减订阅。
		// 两种都不是我们要的,取舍写在 attachReadOnlyTools 的文档里。
		attachReadOnlyTools(c, {
			timezone: () => deps.globals().timezone,
			subscriptionStore: deps.subscriptionStore,
			subscriptionStateStore: deps.subscriptionStateStore,
			// 平台名问来源登记表,登记表里没有的(拓展)才问装载器 —— 与锐评同一条链。
			platformLabel: (sourceKey) => platformLabelOf(sourceKey, labelDeps),
			identityLabel: (identity) => subscriptionIdentityLabelOf(identity, labelDeps),
			sources: deps.sources,
			// 女仆的搜人走宿主外壳(超时、中止、抛错收成 unavailable),不直接碰来源。
			searchCreators: deps.searchCreators,
			// 没订阅、停用或还没缓存时,同一份来源闸上按身份向平台查一次;不写资料缓存。
			fetchProfile: deps.fetchProfile,
			// 女仆查直播状态统一从在播表答;来源没在跑时 BN 手里没有它的在播状态。
			liveNow: liveNowReader(deps),
			// 作品与统计:统计仓、总开关、统计总览读口(接线层给的,总览比推送链路晚一步建)。
			...(deps.creatorStats ? { stats: deps.creatorStats } : {}),
			// 每次请求现取:来源随上下文登记与撤销。
			providedTools: () => deps.aiToolProviders.tools(),
		});
		// 联网搜索的执行器**每次工具调用现取** —— 后端 / key 是运行期随时改的
		// 配置,快照会让「刚填的 key 不生效,重启才行」。没填 key 时取到 null,
		// 生成器那侧静默不挂 web_search。
		c.setWebSearchSource(() => webSearchExecutorFromSettings(deps.globals().ai.search));
		c.start();
		return c;
	} catch (err) {
		deps.logger.warn(logText("log.ai.initializeFailed"), { error: err });
		return null;
	}
}

export function reloadCommentary(
	current: CommentaryGenerator | null,
	deps: CommentaryDeps,
): CommentaryGenerator | null {
	// AI 实例热重载:lazy 构造 + 配置失效降级 + 已存在时增量 updateConfig。
	// 直播的总结请求器构造时拿的 commentary 是快照,调用方拿到回值后必须经它的 setCommentary
	// 把引用同步过去,否则永远沿用启动时的 null;作品装配经 `deps.ai()` 每条现取,不用同步。
	const a = deps.globals().ai;
	// 当前选中那份实例的连接是否配齐 —— 换实例也会走到这里(activeProfile
	// 指针本身就在 ai 里,变了就算 aiChanged)。
	const ap = resolveAIProfile(a);
	const needsCommentary = Boolean(ap.apiKey && ap.baseUrl);
	if (!needsCommentary && current) {
		return null;
	}
	if (needsCommentary && !current) {
		const next = createCommentary(deps);
		if (next) deps.logger.info(logText("log.ai.activated"));
		return next;
	}
	if (current) {
		const next = buildAiConfig(deps);
		current.updateConfig(next);
		// 报**真正推给生成器的那份人格**(指针指的那份),不是 `a.persona` ——
		// 后者永远冻在老值上,照它打日志等于给排查的人指错方向。
		deps.logger.info(logText("log.ai.configurationUpdated"), {
			profile: a.activeProfile,
			provider: ap.provider,
			model: ap.model,
			personaName: next.persona.name,
			traits: next.persona.traits,
		});
		return current;
	}
	return null;
}
