/**
 * 守卫 21b(进程内对拍)的假来源与测试用组装。
 *
 * 假来源只实现中立的 `Source`(键 `acme.inprocess`,**不是** `bilibili`):核心里每一处按 B 站键分岔的地方因此都走
 * 另一支,对拍才测得出「核心是不是真的把内置来源当成一等公民」。它照内置那条路登记 —— `compose.ts` 调的是
 * `engines.registerSource`,这里的包装层调同一个(见 {@link wrapCompose}),所以入口到登记表整条接线都是真的。
 *
 * 🔴 **这个文件与它的使用者不许碰 `bilibili/`**:import 只有中立的 `@bilibili-notify/internal`、`zod`、
 * `integrations/open`,外加两个只取类型的 `compose` / `config/store`。源码里没有 B 站的键常量与那个字面量。
 * 对拍文件里有一条用例读本文件的 import 钉着这一点。
 */

import {
	type AuthState,
	type CreatorCandidate,
	fail,
	type Json,
	type LiveInteractionReport,
	type LiveSignalReport,
	type LiveStatusResult,
	ok,
	type PostEvent,
	type Result,
	type SettingsReader,
	type Source,
	type SourceAuth,
	type SourceContext,
	type SourceDescriptor,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import { z } from "zod";
import type * as Compose from "../../compose.js";
import type { IntegrationSettingsSegment } from "../../config/store.js";
import { type OpenedIntegration, openIntegration } from "../../integrations/open.js";
import { createIntegrationSettings } from "../../integrations/settings-reader.js";

/** 假来源的键:带命名空间的第三方写法,过得了拓展 id 的形状(集成存储只认保留键或合法拓展 id)。 */
export const IN_PROCESS_KEY = "acme.inprocess";
/** 描述符的 `label`(`status` 指令的那一行冒号前、锐评的平台列都该取它)。 */
export const IN_PROCESS_LABEL = "对拍源";
/** 描述符声明的会员体系里的档(key 不与 B 站撞)。 */
export const IN_PROCESS_TIER_KEY = "acme-gold";

/** 假解析器认的链接:`acme.invalid/link/<id>`(id 取字母数字,到查询串或斜杠为止)。 */
const LINK_PATH = /acme\.invalid\/link\/([A-Za-z0-9]+)/;
/** 假解析器交的作品正文 / 原生分享标题的前缀,后面接 id。 */
export const LINK_TITLE_PREFIX = "LINK-TITLE-";
export const LINK_NATIVE_PREFIX = "LINK-NATIVE-";

/** 假来源的设置:两格,`threshold` 有范围,好摆「一格坏」。 */
export const InProcessSettingsSchema = z.object({
	mode: z.string().default("normal"),
	threshold: z.number().int().min(1).max(100).default(10),
});
export type InProcessSettings = z.infer<typeof InProcessSettingsSchema>;

/** 登记进配置仓的设置段(`BUILTIN_INTEGRATION_SETTINGS` 后面追加这一段)。 */
export const inProcessSettingsSegment: IntegrationSettingsSegment<InProcessSettings> = {
	key: IN_PROCESS_KEY,
	schema: InProcessSettingsSchema,
};

/** 设置坏了时假来源自己报的问题 code。 */
export const SETTINGS_PROBLEM_CODE = "settings_invalid";
/** 这一轮没取到直播状态时假来源自己报的问题 code。 */
export const LIVE_STATUS_PROBLEM_CODE = "live_status_unavailable";

export interface InProcessOptions {
	/** 描述符上的 `postNoun`;不给 = 不声明(对拍里有一行专看缺省叫什么)。 */
	postNoun?: string;
}

/** 假来源登录口的内存状态机。 */
export interface InProcessAuth extends SourceAuth {
	/** 测试直接把状态摆成某个值并通知订阅者。 */
	set(state: AuthState, account?: { name: string; avatar?: string }): void;
}

/** 测试从这里看假来源眼下的样子、驱动它。 */
export interface InProcessProbe {
	ctx: SourceContext | undefined;
	/** 登记进去的那个描述符本身(来源上下文每次交作品都现读它的 `postNoun`,所以测试能就地改)。 */
	descriptor: SourceDescriptor;
	starts: number;
	stops: number;
	/** `stop()` 被叫的那一刻 `ctx.signal` 中止了没有。 */
	stopSawAborted: boolean | undefined;
	rosterAtStart: readonly SourceSubscriptionView[] | undefined;
	/** 每次「名单可能变了」的回调里现读的名单。 */
	rosterChanges: Array<readonly SourceSubscriptionView[]>;
	settings: SettingsReader<InProcessSettings> | undefined;
	settingsAtStart: Result<{ settings: InProcessSettings }> | undefined;
	/** 设置的 `onChange` 每次被叫时现读的结果。 */
	settingsChanges: Array<Result<{ settings: InProcessSettings }>>;
	/** `start` 里读到的上一趟写下的 state / secrets(第一趟是 undefined)。 */
	stateAtStart: Json | undefined;
	secretAtStart: Json | undefined;
	/** `health()` 回的那句;`health()` 要抛就置 `healthThrows`。 */
	healthSummary: string;
	healthThrows: boolean;
	/** 假解析器被问过的链接(`resolve` 的入参),按先后。 */
	linkResolves: string[];
	/**
	 * 假来源的直播驱动口:替它在来源上下文上报一条直播信号(开播、状态、下播)。真来源是自己的循环或推送
	 * 触发上报,这里由测试按需摆;还没 `start` 就抛。
	 */
	reportLive(externalId: string, report: LiveSignalReport): void;
	/** 同上,替它在来源上下文上报一条观众互动(特别弹幕、特别进场……)。 */
	reportLiveInteraction(externalId: string, report: LiveInteractionReport): void;
	/** 下一次 `fetchLiveStatus` 回什么;缺省回「没在播」。回完不清,测试自己摆回去。失败时假来源自己报问题。 */
	liveStatusOutcome: LiveStatusResult;
	/** `fetchLiveStatus` 被问过的外部 id,按先后。 */
	liveStatusAsked: string[];
	/** `searchCreators` 收到的 query,按先后。 */
	searches: string[];
	/** 下一次 `searchCreators` 回什么;不摆 = 回两个固定候选。回完不清,测试自己摆回去。 */
	searchOutcome: Result<{ candidates: CreatorCandidate[] }> | undefined;
	readonly auth: InProcessAuth;
}

function createAuth(): InProcessAuth {
	let state: AuthState = { status: "logged-out" };
	let account: { name: string; avatar?: string; extra?: string } | null = null;
	const listeners = new Set<() => void>();
	const emit = (): void => {
		for (const fn of [...listeners]) fn();
	};
	return {
		set(next, nextAccount) {
			state = next;
			account = nextAccount ? { ...nextAccount, extra: "不该外泄的多带的格" } : null;
			emit();
		},
		async beginLogin() {
			state = {
				status: "awaiting-scan",
				qr: { dataUrl: "data:image/png;base64,AAAA", expiresAt: "2099-01-01T00:00:00.000Z" },
			};
			emit();
			return ok();
		},
		async logout() {
			state = { status: "logged-out" };
			account = null;
			emit();
			return ok();
		},
		state: () => state,
		// 多带一格(`extra`),路由该逐格挑、不外泄。
		account: () => account as { name: string } | null,
		onChange(fn) {
			listeners.add(fn);
			return {
				dispose() {
					listeners.delete(fn);
				},
			};
		},
	};
}

/** 造一个假来源和它的探针。来源只做 `Source` 接口上有的事,别的什么都不碰。 */
export function createInProcessSource(options: InProcessOptions = {}): {
	source: Source;
	probe: InProcessProbe;
} {
	const descriptor: SourceDescriptor = {
		label: IN_PROCESS_LABEL,
		...(options.postNoun === undefined ? {} : { postNoun: options.postNoun }),
		membershipPrograms: [
			{
				id: "acme-club",
				name: "俱乐部",
				tiers: [{ key: IN_PROCESS_TIER_KEY, name: "金牌", rank: 1 }],
			},
		],
	};
	const probe: InProcessProbe = {
		ctx: undefined,
		descriptor,
		starts: 0,
		stops: 0,
		stopSawAborted: undefined,
		rosterAtStart: undefined,
		rosterChanges: [],
		settings: undefined,
		settingsAtStart: undefined,
		settingsChanges: [],
		stateAtStart: undefined,
		secretAtStart: undefined,
		healthSummary: "一切正常",
		healthThrows: false,
		linkResolves: [],
		liveStatusOutcome: { ok: true, kind: "offline" },
		liveStatusAsked: [],
		reportLive(externalId, report) {
			if (!probe.ctx) throw new Error("假来源还没 start");
			probe.ctx.reportLive(externalId, report);
		},
		reportLiveInteraction(externalId, report) {
			if (!probe.ctx) throw new Error("假来源还没 start");
			probe.ctx.reportLiveInteraction(externalId, report);
		},
		searches: [],
		searchOutcome: undefined,
		auth: createAuth(),
	};
	const source: Source = {
		descriptor,
		health() {
			if (probe.healthThrows) throw new Error("健康检查炸了");
			return { summary: probe.healthSummary };
		},
		auth: probe.auth,
		async searchCreators(query) {
			probe.searches.push(query);
			return (
				probe.searchOutcome ??
				ok({
					candidates: [
						{ externalId: "cand-1", name: "候选甲", followers: 11, bio: "候选甲的简介" },
						{ externalId: "cand-2", name: "候选乙" },
					],
				})
			);
		},
		async fetchLiveStatus(identity) {
			probe.liveStatusAsked.push(identity.externalId);
			const outcome = probe.liveStatusOutcome;
			// 取不到:来源自己报问题(核心不替它报),取到了清掉。
			if (outcome.ok) {
				probe.ctx?.resolveProblem({
					externalId: identity.externalId,
					code: LIVE_STATUS_PROBLEM_CODE,
				});
			} else {
				probe.ctx?.reportProblem({
					externalId: identity.externalId,
					code: LIVE_STATUS_PROBLEM_CODE,
					message: "对拍源这一轮没取到直播状态",
				});
			}
			return outcome;
		},
		async start(ctx) {
			probe.starts += 1;
			probe.ctx = ctx;
			probe.rosterAtStart = ctx.subscriptions();
			ctx.onSubscriptionsChanged(() => {
				probe.rosterChanges.push(ctx.subscriptions());
			});

			// 设置:哪格坏就报一条问题,存对之后清掉("哪格坏停哪样"的最小版)。
			const reader = ctx.settings(InProcessSettingsSchema);
			probe.settings = reader;
			const judge = (): Result<{ settings: InProcessSettings }> => {
				const read = reader.get();
				if (read.ok) {
					ctx.resolveProblem({ code: SETTINGS_PROBLEM_CODE, notify: false });
				} else {
					ctx.reportProblem({ code: SETTINGS_PROBLEM_CODE, message: "对拍源的设置读不懂" });
				}
				return read;
			};
			probe.settingsAtStart = judge();
			reader.onChange(() => {
				probe.settingsChanges.push(judge());
			});

			// 链接解析器:只认 `acme.invalid/link/<id>`,交一份带标题的作品和原生分享描述(标题里带 id,
			// 好从出图的 HTML 与截流记录里认出是哪一条)。查得到的 id 记进探针,好看「有没有人来问」。
			ctx.registerLinkResolver({
				label: IN_PROCESS_LABEL,
				matches: (url) => LINK_PATH.test(url),
				async resolve(url) {
					const id = LINK_PATH.exec(url)?.[1];
					if (id === undefined) return fail("not_found", "不是对拍源的链接");
					probe.linkResolves.push(url);
					return ok({
						post: {
							creator: { name: "链接作者" },
							publishedAt: "2026-10-01T08:00:00.000Z",
							text: `${LINK_TITLE_PREFIX}${id}`,
						},
						canonicalId: id,
						nativeShare: {
							appId: IN_PROCESS_KEY,
							title: `${LINK_NATIVE_PREFIX}${id}`,
							description: "对拍源的原生分享",
							imageUrl: "https://acme.invalid/cover.png",
							pagePath: `pages/link?id=${id}`,
							webUrl: `https://acme.invalid/link/${id}`,
						},
					});
				},
			});

			// state / secrets:第二趟开机能读到第一趟写下的。
			probe.stateAtStart = ctx.state.get("boots");
			probe.secretAtStart = ctx.secrets.get("token");
			const bootNo = typeof probe.stateAtStart === "number" ? probe.stateAtStart + 1 : 1;
			const wroteState = await ctx.state.set("boots", bootNo);
			const wroteSecret = await ctx.secrets.set("token", `token-${bootNo}`);
			if (!wroteState.ok || !wroteSecret.ok) {
				throw new Error("对拍源写不进自己的存储");
			}
		},
		async stop() {
			probe.stops += 1;
			probe.stopSawAborted = probe.ctx?.signal.aborted;
		},
	};
	return { source, probe };
}

/** 对拍的「世界」:测试在开机前摆好选项,开机后从这里取各趟的探针与宿主那一面。 */
export const inProcessWorld: {
	options: InProcessOptions;
	/** 每趟开机造出来的探针,按开机先后。 */
	probes: InProcessProbe[];
	/** 宿主的服务上下文(从 `compose` 的入参上取的),测试用它挂日志钩子。 */
	serviceCtx: Compose.BuiltinIntegrationsDeps["serviceCtx"] | undefined;
	/**
	 * 群消息的入站出口(同样从 `compose` 的入参上取):适配器停了、HTTP 开发场景用不了的关停途中,
	 * 测试仍能直接往门里喂一条群消息。
	 */
	inboundGroup: Compose.BuiltinIntegrationsDeps["inbound"]["group"] | undefined;
	/** 总线上看到的 `subscription-auth-changed`。 */
	authChanges: Array<{ sourceKey: string; state: AuthState }>;
	/** 总线上看到的 `post-detected`(核心作品入口对每条订阅发的那一份)。 */
	postDetected: PostEvent[];
	/** 总线上看到的 `problems-changed`(报的人)。 */
	problemsChanged: string[];
	/**
	 * 来源已被引擎停下、来源上下文已收掉,而进程还活着(集成存储与总线都还在)的那一刻要做的事:
	 * 关停钩子里排在引擎之后、集成上下文收尾之前。测试在这里让已停的来源再上报。
	 */
	afterSourceStopped: (() => void | Promise<void>) | undefined;
} = {
	options: {},
	probes: [],
	serviceCtx: undefined,
	inboundGroup: undefined,
	authChanges: [],
	postDetected: [],
	problemsChanged: [],
	afterSourceStopped: undefined,
};

/** 每个用例组开头清一次。 */
export function resetInProcessWorld(options: InProcessOptions = {}): void {
	inProcessWorld.options = options;
	inProcessWorld.probes = [];
	inProcessWorld.serviceCtx = undefined;
	inProcessWorld.inboundGroup = undefined;
	inProcessWorld.authChanges = [];
	inProcessWorld.postDetected = [];
	inProcessWorld.problemsChanged = [];
	inProcessWorld.afterSourceStopped = undefined;
}

/** 当前(最近一趟开机)的探针;还没开机就抛。 */
export function currentProbe(): InProcessProbe {
	const probe = inProcessWorld.probes.at(-1);
	if (!probe) throw new Error("假来源还没登记(服务端没开机?)");
	return probe;
}

/**
 * 包 `compose.ts`(`vi.mock("../compose.js", …)` 的实现体):真模块照常跑(真 B 站来源并排登记),
 * 之外加两样 —— 设置段后面追加假来源的一段;`registerSources` 里真的登记完之后,对假来源调**同一个**
 * `engines.registerSource`。
 *
 * 测试用组装要自己做三件事(内置来源的那几件在 `compose.ts` / 登录装配里,这里照做):
 * 1. 设置段(上面);
 * 2. 集成上下文:`integrationStore.open(键)` + `openIntegration`(请求客户端、上下文与收尾挂在一起;存储是异步开的,
 *    所以在 `registerSources` 里);
 * 3. 关停次序:上下文的收尾钩子在**这里**(早于 `createEngines`)登记 —— 关停钩子后登记的先跑,所以引擎先停来源,
 *    钩子后收上下文;钩子登记晚了,上下文会先于来源的 `stop()` 被中止。
 */
export function wrapCompose(real: typeof Compose): typeof Compose {
	return {
		...real,
		BUILTIN_INTEGRATION_SETTINGS: [...real.BUILTIN_INTEGRATION_SETTINGS, inProcessSettingsSegment],
		composeBuiltinIntegrations(deps) {
			const builtins = real.composeBuiltinIntegrations(deps);
			inProcessWorld.serviceCtx = deps.serviceCtx;
			inProcessWorld.inboundGroup = deps.inbound.group;
			deps.bus.on("subscription-auth-changed", (changed) => {
				inProcessWorld.authChanges.push(changed);
			});
			deps.bus.on("post-detected", (event) => {
				inProcessWorld.postDetected.push(event);
			});
			deps.bus.on("problems-changed", ({ reporter }) => {
				inProcessWorld.problemsChanged.push(reporter);
			});
			const logger = deps.serviceCtx.forSubsystem(IN_PROCESS_KEY, IN_PROCESS_KEY).logger;
			let opened: { integration: OpenedIntegration; store: { close(): void } } | undefined;
			deps.serviceCtx.onDispose(async () => {
				// 此刻引擎已停掉来源、收掉了来源上下文(钩子后登记的先跑),集成上下文还没收。
				await inProcessWorld.afterSourceStopped?.();
				if (!opened) return;
				const { integration, store } = opened;
				opened = undefined;
				try {
					await integration.handle.dispose();
				} finally {
					store.close();
					await integration.http.client.dispose();
				}
			}, "stop");
			return {
				...builtins,
				async registerSources(engines) {
					await builtins.registerSources(engines);
					const store = await deps.integrationStore.open(IN_PROCESS_KEY);
					const integration = await openIntegration({
						stores: store,
						logger,
						stopReason: "BN 关停",
						problems: deps.problems,
						reporter: IN_PROCESS_KEY,
						label: () => IN_PROCESS_KEY,
						rejectedProblemLevel: "error",
						transitImages: deps.transitImages,
						// 读法取自入口递进来的那一份(`deps.settingsOf`):假来源读自己的键,不在测试里另接配置仓。
						settings: createIntegrationSettings({ ...deps.settingsOf(IN_PROCESS_KEY), logger }),
						httpOptions: { setTimeout: deps.setTimeout },
					});
					opened = { integration, store };
					const made = createInProcessSource(inProcessWorld.options);
					inProcessWorld.probes.push(made.probe);
					await engines.registerSource({
						sourceKey: IN_PROCESS_KEY,
						source: made.source,
						integration: integration.handle.ctx,
						logger,
					});
				},
			};
		},
	};
}
