import {
	type AiCandidateView,
	type AiSubscriptionView,
	type AiTool,
	type CreatorReader,
	creatorOf,
	type LiveNowView,
	parseCreator,
} from "@bilibili-notify/ai";
import { displayNameOf } from "@bilibili-notify/contract";
import {
	type CreatorCandidate,
	type CreatorProfileReport,
	type Failure,
	fail,
	type Identity,
	ok,
	type Result,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { CREATOR_READER_TEXTS } from "./creator-reader-texts.js";
import type { CreatorStatsReader } from "./creator-stats.js";

/**
 * 只按**真正读到的那点东西**声明依赖,而不是整个 `SubscriptionStore` /
 * `SubscriptionStateStore`。这两个 store 各带十来个写方法,全要过来等于宣称本模块
 * 可能改数据 —— 而这是「只读档」的接线处,签名本身就该说清它做不到写。
 * 顺带让测试不必为了调一个纯投影函数去伪造一整个 store。
 */
interface SubscriptionReader {
	list(): Subscription[];
}
interface ProfileSource {
	get(
		id: string,
	): { cachedProfile?: { name?: string; followers?: number; bio?: string } } | undefined;
}
/**
 * 订阅此刻在不在播从哪儿取:BN 手里的在播表,以及「这个来源在不在跑」。
 * 来源停了,它名下的在播状态就作废了(ADR-0019 决策 61),这时答「不知道」而不是「未开播」。
 */
export interface LiveNowReader {
	/** 在播表里这条订阅的那一行(在播才有)。 */
	row(
		subscriptionId: string,
	): { startedAt?: number; details: { title?: string; totalViewers?: number } } | undefined;
	/** 这个来源此刻在跑吗。 */
	running(sourceKey: string): boolean;
}

/**
 * 把订阅**查询**能力接给女仆 —— 独立端唯一的 `setCreatorReader` 调用处。
 *
 * 「只读」如今是**结构性**的:`CommentaryGenerator` 的工具表里根本没有会改订阅
 * 的工具了(三个写工具已整体下架,见 `packages/ai/src/tools.ts`)。这与从前不同
 * —— 从前只读是靠这里少传一个 `subMgmt` 字段换来的,那是个一改就破的约定。
 *
 * 读口是**必须**接的:不接的话连 list_subscriptions 都查不到,女仆会一口
 * 咬定「当前没有订阅」,而主人明明订了十几个 —— 那种答案比不会答更糟,因为它
 * 听起来像个事实。
 */
export function attachReadOnlyTools(
	engine: {
		setCreatorReader(reader: CreatorReader): void;
		setProvidedTools(get: () => readonly AiTool[]): void;
	},
	stores: {
		subscriptionStore: SubscriptionReader;
		subscriptionStateStore: ProfileSource;
		/** 订阅所属平台的叫法(问来源登记表,见 `subscriptions/platform-label.ts`)。 */
		platformLabel: (sourceKey: string) => string;
		/** 订阅的身份标签(问来源登记表与拓展装载器,见 `subscriptions/platform-label.ts`)。 */
		identityLabel: (identity: Identity) => string;
		/** 来源登记表里读得到的那一点:资料回落前用它确认来源在册。 */
		sources: { get(sourceKey: string): unknown };
		/** 在某个来源里搜人(宿主外壳 `searchSourceCreators`,已绑好登记表与日志)。 */
		searchCreators: (
			sourceKey: string,
			query: string,
		) => Promise<Result<{ candidates: CreatorCandidate[] }>>;
		/** 没订阅、停用或还没缓存时,向在册来源取一次资料;不写资料缓存。 */
		fetchProfile(identity: Identity): Promise<Result<CreatorProfileReport>>;
		/** 作品与统计的读口(装配处给);不给 = 这两样答「当前不可用」。 */
		stats?: CreatorStatsReader;
		liveNow?: LiveNowReader;
		/** 来源在上下文里登记的只读工具;每次请求现取,登记与撤销立刻生效。 */
		providedTools: () => readonly AiTool[];
	},
): void {
	/** 按 `creator` 找**启用着**的订阅:停用的、没订阅的都当不在(关掉的人不该再出现在女仆的回答里)。 */
	const subscribedBy = (creator: string): Subscription | undefined =>
		stores.subscriptionStore.list().find((sub) => {
			if (!sub.enabled) return false;
			const identity = subscriptionIdentityOf(sub);
			return creatorOf(identity.sourceKey, identity.externalId) === creator;
		});
	/** 作品与统计共用的前置:订阅着、统计读口接着、总开关开着。过了回订阅与读口,没过回失败。 */
	const statsGate = (
		creator: string,
	): { sub: Subscription; stats: CreatorStatsReader } | Failure => {
		const sub = subscribedBy(creator);
		if (!sub) return fail("not_found", CREATOR_READER_TEXTS.notSubscribed(creator));
		if (!stores.stats) return fail("unavailable", CREATOR_READER_TEXTS.statsUnwired);
		if (!stores.stats.isEnabled()) return fail("not_configured", CREATOR_READER_TEXTS.statsOff);
		return { sub, stats: stores.stats };
	};
	// 每次工具调用现取,不是接线那一刻的快照:接线发生在启动时,订阅却是
	// 运行期随时增删的。
	engine.setCreatorReader({
		subscriptions: () =>
			aiSubscriptionViews(
				stores.subscriptionStore,
				stores.subscriptionStateStore,
				stores.platformLabel,
				stores.identityLabel,
				stores.liveNow,
			),
		async searchCreators(sourceKey, query) {
			const found = await stores.searchCreators(sourceKey, query);
			if (!found.ok) return found;
			// 头像等工具用不上的格不带;`creator` 就是下一步中立工具认的值。
			return ok({
				candidates: found.candidates.map(
					(c): AiCandidateView => ({
						creator: creatorOf(sourceKey, c.externalId),
						name: c.name,
						...(c.followers === undefined ? {} : { followers: c.followers }),
						...(c.bio === undefined ? {} : { bio: c.bio }),
					}),
				),
			});
		},
		async profile(creator) {
			const sub = subscribedBy(creator);
			const cached = sub?.enabled
				? stores.subscriptionStateStore.get(sub.id)?.cachedProfile
				: undefined;
			if (cached?.name) {
				return ok({
					profile: {
						name: cached.name,
						...(cached.followers === undefined ? {} : { followers: cached.followers }),
						...(cached.bio ? { bio: cached.bio } : {}),
					},
				});
			}
			const identity = parseCreator(creator);
			if (!identity || !stores.sources.get(identity.sourceKey)) {
				return fail(
					"not_found",
					sub
						? CREATOR_READER_TEXTS.profileNotCached(creator)
						: CREATOR_READER_TEXTS.notSubscribed(creator),
				);
			}
			const found = await stores.fetchProfile(identity);
			if (!found.ok) return found;
			return ok({
				profile: {
					name: found.name,
					...(found.followers === undefined ? {} : { followers: found.followers }),
					...(found.bio === undefined ? {} : { bio: found.bio }),
				},
			});
		},
		async recentPosts(creator, limit) {
			const gate = statsGate(creator);
			if ("code" in gate) return gate;
			return ok({ posts: await gate.stats.recentPosts(gate.sub.id, limit) });
		},
		async stats(creator, days) {
			const gate = statsGate(creator);
			if ("code" in gate) return gate;
			const row = await gate.stats.statsRow(gate.sub.id, days);
			if (!row) return fail("not_found", CREATOR_READER_TEXTS.noStatsRow(creator));
			return ok({ stats: { days, ...row } });
		},
	});
	engine.setProvidedTools(stores.providedTools);
}

/** 订阅此刻的在播(见 {@link LiveNowReader})。 */
function liveNowFromTable(
	live: LiveNowReader,
	subscriptionId: string,
	sourceKey: string,
): LiveNowView {
	if (!live.running(sourceKey)) return { state: "unknown" };
	const row = live.row(subscriptionId);
	if (!row) return { state: "idle" };
	return {
		state: "live",
		title: row.details.title,
		startedAt: row.startedAt,
		totalViewers: row.details.totalViewers,
	};
}

/**
 * 订阅配置 → AI 工具看得懂的视图。
 *
 * `post` / `live` 的口径是「该特性下**有没有推送目标**」而不是配置里的开关:
 * 一个特性配了却没有任何目标,推不出去任何东西,对女仆来说就等于没订。`live`(「直播 ✓」)是直播类推送:
 * 开播(`liveStart`)或周期「正在直播」(`liveStreaming`)任一有目标就算。
 *
 * 名字按「平台资料缓存 → 身份标签」取(两支同一条 `displayNameOf`;主人填的备注是自由文字,不当名字用)。
 * cachedProfile 是外置的运行时数据(不在 Subscription 里),与 `/api/subscriptions` 的 join 同源。
 *
 * 每条订阅同一种形状(ADR-0030 决策 1):`creator` 是「来源键:外部 id」,平台名由宿主递进来的函数取
 * (它问来源登记表),视图本身不认哪个来源是哪个平台。在播一格从在播表答(见 {@link LiveNowReader});
 * 没接上时没有这一格。
 */
export function aiSubscriptionViews(
	subscriptionStore: SubscriptionReader,
	subscriptionStateStore: ProfileSource,
	platformLabel: (sourceKey: string) => string,
	identityLabel: (identity: Identity) => string,
	liveNowReader?: LiveNowReader,
): AiSubscriptionView[] {
	const view: AiSubscriptionView[] = [];
	for (const sub of subscriptionStore.list()) {
		// 停用的订阅不进视图:主人把某个 UP 关掉了,女仆的答案里就不该还有他。
		if (!sub.enabled) continue;
		const identity = subscriptionIdentityOf(sub);
		const liveNow: LiveNowView | undefined =
			liveNowReader && liveNowFromTable(liveNowReader, sub.id, identity.sourceKey);
		view.push({
			creator: creatorOf(identity.sourceKey, identity.externalId),
			name: displayNameOf(
				{
					profileName: subscriptionStateStore.get(sub.id)?.cachedProfile?.name,
				},
				identityLabel(identity),
			),
			platform: platformLabel(identity.sourceKey),
			post: sub.routing.post.length > 0,
			live: sub.routing.liveStart.length > 0 || sub.routing.liveStreaming.length > 0,
			...(liveNow ? { liveNow } : {}),
		});
	}
	return view;
}
