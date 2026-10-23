/**
 * 服务端自主生成锐评 —— 取数 → 调 AI → 解析,一条不依赖前端的路。
 *
 * 在这之前,锐评只能由页面发起:`POST /roast` 生成、前端拿到结果、再原样回传给
 * `/roast/push` 推出去。那条链路的地基是「主人看过卡片才决定推」,服务端从不自己
 * 生成。定时推送没有前端也没有人在场,于是把生成部分抽到这里,让路由和调度器共用
 * 同一份实现 —— 否则两条路会各自演化,页面上看到的和定时发出去的迟早不是一回事。
 *
 * **取数用注入的回调**,不在这里自己实现:`/overview` 的取数背着 TTL 缓存、跨 UP 的热力图遮罩和
 * 时区对齐。路由与调度器传进来的都是 `createStatsOverview` 那个函数(经 `roastOverviewFetcher` 收成失败为
 * `null` 的形状),直接调用,不再绕一圈进程内 HTTP。
 */

import { CommentaryGenerator, webSearchExecutorFromSettings } from "@bilibili-notify/ai";
import type {
	StatsOverviewResponse,
	StatsRoastResult,
	StatsSoloRoastResult,
	UpStatsRow,
} from "@bilibili-notify/contract";
import { type Failure, fail, ok, type Result, type Subscription } from "@bilibili-notify/internal";
import { promptNounsOf } from "../ai/prompt-nouns.js";
import type { RouteDeps } from "../routes/types.js";
import { resolveAiOverride, toGeneratorConfig } from "../runtime/ai-config.js";
import {
	buildRoastPrompt,
	buildSoloRoastPrompt,
	parseRoastReply,
	parseSoloRoastReply,
	type RoastInput,
} from "./roast.js";
import { roastPlatformLabel, roastRowName } from "./roast-subject.js";

/** 生成只用得到这两样,不牵整份 RouteDeps —— 调度器不该为了生成一份周报去凑 puppeteer。 */
export type RoastGenDeps = Pick<RouteDeps, "runtime" | "store">;

/** 取数回调。路由与调度器各自提供,内部都是直接调 `/overview` 的那个取数函数;取不到是 `null`。 */
export type OverviewFetcher = (days: number, tz: number) => Promise<StatsOverviewResponse | null>;

/**
 * 生成的结果:`{ ok: true, result }` 或一个失败(`code` + `message`,ADR-0026)。
 *
 * 失败在**产生的地方**就带上码与给人看的话,路由直接 `respondFailure`、调度器直接拿 `message` 私聊
 * —— 从前这里只留一个分类 `kind`,路由与调度器再各拿它去翻文案与状态码,措辞改一处忘一处。
 */
export type RoastGenResult<T> = Result<{ result: T }>;

/**
 * 每种失败的码与话。话是路由的错误体、调度器私聊的那一句共用的一套措辞。
 *
 * - 「没配 / 没开」是 `not_configured`(要主人去配,等是等不好的):智能女仆没开,以及榜单要至少 2 位
 *   订阅才评得出鸽王(先去订阅够);
 * - 服务没起、取数失败、模型出错、回复读不懂是 `unavailable`(稍后重试);
 * - 订阅 id 对不上、该 UP 这个窗口没数据是 `not_found`。
 */
const GEN_FAILURE = {
	notReady: () => fail("unavailable", "服务尚未就绪,请稍后重试"),
	aiDisabled: () => fail("not_configured", "智能女仆尚未启用"),
	/** 数据统计总开关关着:锐评只读统计,数据停更还去评旧数据没有意义(ADR-0027 决策 9)。 */
	statsDisabled: () => fail("not_configured", "数据统计已关闭,开启后才能锐评"),
	overviewFailed: () => fail("unavailable", "统计数据读取失败,请稍后重试"),
	tooFewUps: () => fail("not_configured", "至少要订阅 2 位 UP 主才评得出鸽王"),
	notSubscribed: () => fail("not_found", "该 UP 主不在订阅列表里"),
	noData: () => fail("not_found", "该 UP 主暂无统计数据"),
	parseFailed: () => fail("unavailable", "女仆的回复解析失败,请重试"),
	/** 模型那头的错(密钥不对、余额不足、网络):对端给的原因就是主人要看的,原话进 `message`。 */
	aiError: (err: unknown): Failure => {
		const reason = err instanceof Error ? err.message : String(err);
		return fail("unavailable", reason.trim() === "" ? "模型没有说明原因" : reason);
	},
} as const;

/**
 * overview 的一行 → 喂给 prompt 的输入。两处生成同一套字段。
 *
 * 两支订阅的行都收(ADR-0020 决策 12:一张榜混着比):回指的键是行的键 —— 订阅 id(决策 18);名字走
 * `roast-subject.ts` 那两条链(决策 3),平台一列 B 站写「B 站」、拓展写清单里的平台名。`sub` 对不上
 * (取完数这一刻订阅被删了)时名字按行上带的身份兜底。
 */
function toRoastInput(
	deps: RoastGenDeps,
	row: UpStatsRow,
	sub: Subscription | undefined,
): RoastInput {
	return {
		subscriptionId: row.subscriptionId,
		platform: roastPlatformLabel(deps, row.identity),
		name: roastRowName(deps, row, sub),
		net7d: row.net7d,
		netWindow: row.netWindow,
		videoPosts: row.videoPosts,
		posts: row.posts,
		liveSessions: row.liveSessions,
		liveHours: row.liveHours,
		lastActivityAt: row.lastActivityAt,
	};
}

/** 这两个函数只读 `ai` 的这个投影,不为它们抄一遍完整类型。 */
type RoastAiSettings = ReturnType<RoastGenDeps["store"]["getGlobals"]>["ai"];

/**
 * 锐评的一次性生成器。engines.commentary 那台是常驻的,这里刻意自建(见调用点
 * 注释),所以搜索源也得自己接 —— 常驻那台的接线惠及不到它。
 */
function makeRoastGenerator(deps: RoastGenDeps, aiSettings: RoastAiSettings): CommentaryGenerator {
	const generator = new CommentaryGenerator({
		serviceCtx: deps.runtime.serviceCtx,
		config: toGeneratorConfig(aiSettings),
		nouns: promptNounsOf(deps),
	});
	generator.setWebSearchSource(() => webSearchExecutorFromSettings(aiSettings.search));
	return generator;
}

/**
 * `engines.roast` 开着才给 override 盖 webSearch 章。关着时**原样递回 base**
 * (可能是 undefined)—— 「没覆盖递 undefined 而不是空对象」是被测试钉住的契约,
 * 空对象会让「有没有 override」这个判断失真。
 */
function roastSearchOverride(
	aiSettings: RoastAiSettings,
	base?: Parameters<CommentaryGenerator["comment"]>[3],
): Parameters<CommentaryGenerator["comment"]>[3] {
	return aiSettings.search.engines.roast ? { ...base, webSearch: true } : base;
}

/** 榜单锐评:全体订阅(两支混着)一起评,需要至少 2 位做对照 —— 两支加起来数人头。 */
export async function generateBoardRoast(
	deps: RoastGenDeps,
	opts: { days: number; tz: number; fetchOverview: OverviewFetcher },
): Promise<RoastGenResult<StatsRoastResult>> {
	const engines = deps.runtime.engines;
	if (!engines) return GEN_FAILURE.notReady();

	const globals = deps.store.getGlobals();
	const aiSettings = globals.ai;
	if (!aiSettings.enabled) return GEN_FAILURE.aiDisabled();
	if (!globals.stats.enabled) return GEN_FAILURE.statsDisabled();

	const overview = await opts.fetchOverview(opts.days, opts.tz);
	if (!overview) return GEN_FAILURE.overviewFailed();

	// 行与订阅都以订阅 id 为键(ADR-0020 决策 1 的 🔗):按它对,外部 id 恰好等于某个 uid 也不串。
	const subById = new Map(deps.store.getSubscriptions().map((s) => [s.id, s]));
	const ups = overview.rows.map((r) => toRoastInput(deps, r, subById.get(r.subscriptionId)));
	if (ups.length < 2) return GEN_FAILURE.tooFewUps();

	const generator = makeRoastGenerator(deps, aiSettings);
	let reply: string;
	try {
		// `comment()` 而不是 `chat()` —— 工具默认不挂,只有 engines.roast 开着时才
		// 带上 web_search(见 roastSearchOverride)。chat() 会挂上整套 B 站工具与工具
		// 铁律,模型可能中途发起 tool call 而不是回 JSON(详见 stats-roast-call.test.ts)。
		reply = await generator.comment(
			buildRoastPrompt(ups, opts.days),
			undefined,
			undefined,
			roastSearchOverride(aiSettings),
		);
	} catch (err) {
		return GEN_FAILURE.aiError(err);
	}

	const result = parseRoastReply(reply, ups);
	// 解析不出来就直说,不把半截结构渲染成一张看着像模像样的卡。
	if (!result) return GEN_FAILURE.parseFailed();
	return ok({ result });
}

/**
 * 单人锐评:只就这一位说话,没有「至少 2 位」那道闸门,但带上他自己的人格。两支订阅都行,按订阅 id 认
 * (ADR-0020 决策 18)。
 */
export async function generateSoloRoast(
	deps: RoastGenDeps,
	opts: { subscriptionId: string; days: number; tz: number; fetchOverview: OverviewFetcher },
): Promise<RoastGenResult<StatsSoloRoastResult>> {
	const engines = deps.runtime.engines;
	if (!engines) return GEN_FAILURE.notReady();

	// 先确认这条订阅真的在。不校验的话,任何人构造一个 id 就能让我们拿着
	// 一份空数据去请求模型 —— 白烧 token,还会渲染出一张查无此人的卡。
	const sub = deps.store.getSubscriptions().find((s) => s.id === opts.subscriptionId);
	if (!sub) return GEN_FAILURE.notSubscribed();

	const globals = deps.store.getGlobals();
	const aiSettings = globals.ai;
	if (!aiSettings.enabled) return GEN_FAILURE.aiDisabled();
	if (!globals.stats.enabled) return GEN_FAILURE.statsDisabled();

	const overview = await opts.fetchOverview(opts.days, opts.tz);
	if (!overview) return GEN_FAILURE.overviewFailed();
	const row = overview.rows.find((r) => r.subscriptionId === sub.id);
	if (!row) return GEN_FAILURE.noData();

	const up = toRoastInput(deps, row, sub);

	const generator = makeRoastGenerator(deps, aiSettings);
	// per-UP 人格:与动态点评 / 下播总结同源。评的就是这一位 UP,主人给他单配的
	// 人格没有理由不算数。
	const aiOverride = resolveAiOverride(sub, aiSettings);
	let reply: string;
	try {
		// scene / imageUrls 留空:锐评既不属于 dynamic 也不属于 liveSummary,更没有图。
		reply = await generator.comment(
			buildSoloRoastPrompt(up, opts.days),
			undefined,
			undefined,
			roastSearchOverride(aiSettings, aiOverride),
		);
	} catch (err) {
		return GEN_FAILURE.aiError(err);
	}

	const result = parseSoloRoastReply(reply, up);
	if (!result) return GEN_FAILURE.parseFailed();
	return ok({ result });
}
