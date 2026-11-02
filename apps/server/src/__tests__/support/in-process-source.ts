/**
 * 守卫 21b(进程内对拍)的假来源与测试用组装。
 *
 * 假来源只实现中立的 `Source`(键 `acme.inprocess`,**不是** `bilibili`):核心里每一处按 B 站键分岔的地方因此都走
 * 另一支,对拍才测得出「核心是不是真的把内置来源当成一等公民」。它照内置那条路登记 —— `compose.ts` 调的是
 * `pipeline.registerSource`,这里的包装层调同一个(见 {@link wrapCompose}),所以入口到登记表整条接线都是真的。
 *
 * 🔴 **这个文件与它的使用者不许碰 `bilibili/`**:import 只有中立的 `@bilibili-notify/internal`、`zod`、
 * `integrations/open`,外加两个只取类型的 `compose` / `config/store`。源码里没有 B 站的键常量与那个字面量。
 * 对拍文件里有一条用例读本文件的 import 钉着这一点。
 */

import {
	type AiToolProvider,
	type AuthState,
	type CreatorCandidate,
	type CreatorProfileReport,
	type Disposable,
	fail,
	type Identity,
	type ImageRef,
	type Json,
	type LiveInteractionReport,
	type LiveSignalReport,
	type LiveStatusResult,
	ok,
	type PostEvent,
	type PreviewOptions,
	type PreviewReport,
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
import type * as Bootstrap from "../../runtime/bootstrap.js";

/** 假来源的键:带命名空间的第三方写法,过得了拓展 id 的形状(集成存储只认保留键或合法拓展 id)。 */
export const IN_PROCESS_KEY = "acme.inprocess";
/** 描述符的 `label`(`status` 指令的那一行冒号前、锐评的平台列都该取它)。 */
export const IN_PROCESS_LABEL = "对拍源";
/** 描述符声明的会员体系里的档(key 不与 B 站撞)。 */
export const IN_PROCESS_TIER_KEY = "acme-gold";
/** 描述符声明的会员体系 id(档 key 只在这个体系里认)。 */
export const IN_PROCESS_PROGRAM_ID = "acme-club";
/** 档位由主播自定的会员体系(id 同样全局唯一)。 */
export const IN_PROCESS_CUSTOM_PROGRAM_ID = "acme-custom";
/** 另一套逐档声明的体系:用来钉「档 key 只在体系内唯一」。 */
export const IN_PROCESS_OTHER_PROGRAM_ID = "acme-guild";
export const IN_PROCESS_OTHER_TIER_KEY = "acme-silver";
/** `start` 里存进图库的那张小图(1×1 PNG),对拍从出的卡里认得出它。 */
export const IN_PROCESS_TIER_ICON_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

/** 假解析器认的链接:`acme.invalid/link/<id>`(id 取字母数字,到查询串或斜杠为止)。 */
const LINK_PATH = /acme\.invalid\/link\/([A-Za-z0-9]+)/;
/** 假解析器交的作品正文 / 原生分享标题的前缀,后面接 id。 */
export const LINK_TITLE_PREFIX = "LINK-TITLE-";
export const LINK_NATIVE_PREFIX = "LINK-NATIVE-";
/** 假来源经上下文登记的那把只读工具,宿主加完命名空间后的全名。 */
export const IN_PROCESS_ECHO_TOOL_NAME = "acme_inprocess__echo";
/** 那把工具在小条上给人看的名字。 */
export const IN_PROCESS_ECHO_TOOL_LABEL = "对拍回声";
/** 假提供方带来的技能:本名、宿主加命名空间后的全名与正文。 */
export const IN_PROCESS_SKILL_NAME = "echo-check";
export const IN_PROCESS_SKILL_FULL_NAME = "acme-inprocess-echo-check";
export const IN_PROCESS_SKILL_BODY = "P43: call acme_inprocess__echo before answering.";

/** 重建假提供方;P43 撤登记后还要把它交回 P42 继续验工具。 */
export function createInProcessAiToolProvider(): AiToolProvider {
	return {
		readOnly: [
			{
				definition: {
					type: "function",
					function: {
						name: "echo",
						description: "Return the creator argument.",
						parameters: {
							type: "object",
							properties: { creator: { type: "string" } },
							required: ["creator"],
						},
					},
				},
				label: IN_PROCESS_ECHO_TOOL_LABEL,
				execute: async (args) => ok({ text: `回声: ${args.creator ?? ""}` }),
			},
		],
		skills: [
			{
				name: IN_PROCESS_SKILL_NAME,
				description: "P43 provider skill",
				allowedTools: [IN_PROCESS_ECHO_TOOL_NAME],
				disableModelInvocation: false,
				body: IN_PROCESS_SKILL_BODY,
			},
		],
	};
}

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
	/** 描述符上的 `creatorNoun`;不给 = 不声明。 */
	creatorNoun?: string;
	/** 描述符上的 `postNoun`;不给 = 不声明(对拍里有一行专看缺省叫什么)。 */
	postNoun?: string;
	/**
	 * 来源「上报过资料」的人(按外部 id)。真来源上报的资料与被拉到的资料是同一份,所以 `fetchProfile`
	 * 对这些人回这一份;没列的人回固定默认值(`资料-<id>`)。
	 */
	knownProfiles?: Record<string, Omit<CreatorProfileReport, "avatar">>;
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
	/** `stop()` 里计数之后要做的事(异步的 stop:测试在这里让来源在停下的路上再上报);不设就是同步停完。 */
	duringStop: (() => void | Promise<void>) | undefined;
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
	/** `start` 里登记只读工具交回的把手;P42 用它验证撤销后工具立刻从请求里消失。 */
	aiToolProviderClaim: Disposable | undefined;
	/**
	 * 假来源的直播驱动口:替它在来源上下文上报一条直播信号(开播、状态、下播)。真来源是自己的循环或推送
	 * 触发上报,这里由测试按需摆;还没 `start` 就抛。
	 */
	reportLive(externalId: string, report: LiveSignalReport): void;
	/** 同上,替它在来源上下文上报一条观众互动(特别弹幕、特别进场……)。 */
	reportLiveInteraction(externalId: string, report: LiveInteractionReport): void;
	/** 同上,替它在来源上下文上报一份资料(名字、头像引用、简介、粉丝数、粉丝团名)。 */
	reportProfile(externalId: string, report: CreatorProfileReport): void;
	/**
	 * 懒取口 `fetchViewerAvatar` 被问过的人(`externalId:viewerId`),按先后。测试用它钉「确定要出卡才取、一次」。
	 */
	viewerAvatarAsked: string[];
	/** 懒取口下次交的头像引用;没摆就回失败(卡照出,只是没有观众头像)。 */
	viewerAvatarRef: ImageRef | undefined;
	/** 懒取口 `fetchTierIcon` 被问过的档(`externalId:program:tierKey`),按先后。 */
	tierIconAsked: string[];
	/** `start` 里给自己那档存进图库的徽章引用;存不进就是 undefined。 */
	tierIconRef: ImageRef | undefined;
	/** 下一次 `fetchLiveStatus` 回什么;缺省回「没在播」。回完不清,测试自己摆回去。失败时假来源自己报问题。 */
	liveStatusOutcome: LiveStatusResult;
	/** `fetchLiveStatus` 被问过的外部 id,按先后。 */
	liveStatusAsked: string[];
	/** `fetchPreview` 被问过的(外部 id 与要哪一张),按先后。 */
	previewAsked: Array<{ externalId: string; options: PreviewOptions }>;
	/** 下一次 `fetchPreview` 回什么;不摆 = 作品回一条固定作品、直播回一份固定详情。回完不清,测试自己摆回去。 */
	previewOutcome: Result<PreviewReport> | undefined;
	/** `searchCreators` 收到的 query,按先后。 */
	searches: string[];
	/** 下一次 `searchCreators` 回什么;不摆 = 回两个固定候选。回完不清,测试自己摆回去。 */
	searchOutcome: Result<{ candidates: CreatorCandidate[] }> | undefined;
	/** `fetchProfile` 被问到的身份,按先后。 */
	profileAsked: Identity[];
	/** 下一次 `fetchProfile` 回什么;不摆 = 回一份固定资料并把小头像存进图库。 */
	profileOutcome: Result<CreatorProfileReport> | undefined;
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
		shortLabel: "对",
		color: "#336699",
		icon: `data:image/png;base64,${IN_PROCESS_TIER_ICON_BASE64}`,
		searchAccepts: ["id", "name"],
		supportedFeatures: ["post", "liveStart", "liveEnd", "membership"],
		supportedExtras: ["atAllPost", "liveSummary"],
		featureHints: { post: "Probe post hint", liveEnd: "Probe end hint" },
		...(options.creatorNoun === undefined ? {} : { creatorNoun: options.creatorNoun }),
		...(options.postNoun === undefined ? {} : { postNoun: options.postNoun }),
		membershipPrograms: [
			{
				id: IN_PROCESS_PROGRAM_ID,
				name: "俱乐部",
				tiers: [
					{
						key: IN_PROCESS_TIER_KEY,
						name: "金牌",
						rank: 1,
						color: "#112233",
						colorEnd: "#445566",
						// 与 B 站大航海的档一样带宣告语:默认会员卡不画 `tierName`,档名经这一句里的 `{tier}` 上卡。
						announcement: "{viewer} 加入了{tier}",
					},
				],
			},
			{
				id: IN_PROCESS_OTHER_PROGRAM_ID,
				name: "公会",
				tiers: [{ key: IN_PROCESS_OTHER_TIER_KEY, name: "银牌", rank: 1 }],
			},
			{ id: IN_PROCESS_CUSTOM_PROGRAM_ID, name: "自定", tiers: "custom" },
		],
	};
	const probe: InProcessProbe = {
		ctx: undefined,
		descriptor,
		starts: 0,
		stops: 0,
		stopSawAborted: undefined,
		duringStop: undefined,
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
		aiToolProviderClaim: undefined,
		liveStatusOutcome: { ok: true, kind: "offline" },
		liveStatusAsked: [],
		previewAsked: [],
		previewOutcome: undefined,
		viewerAvatarAsked: [],
		viewerAvatarRef: undefined,
		tierIconAsked: [],
		tierIconRef: undefined,
		reportLive(externalId, report) {
			if (!probe.ctx) throw new Error("假来源还没 start");
			probe.ctx.reportLive(externalId, report);
		},
		reportLiveInteraction(externalId, report) {
			if (!probe.ctx) throw new Error("假来源还没 start");
			probe.ctx.reportLiveInteraction(externalId, report);
		},
		reportProfile(externalId, report) {
			if (!probe.ctx) throw new Error("假来源还没 start");
			probe.ctx.reportProfile(externalId, report);
		},
		searches: [],
		searchOutcome: undefined,
		profileAsked: [],
		profileOutcome: undefined,
		auth: createAuth(),
	};
	const source: Source = {
		descriptor,
		// 出卡时才取的懒取口;观众头像的引用由测试先经 `ctx.storeImage` 摆进探针,徽章在 `start` 里自己存。
		liveInteractions: {
			async fetchViewerAvatar(identity, viewerId) {
				probe.viewerAvatarAsked.push(`${identity.externalId}:${viewerId}`);
				const ref = probe.viewerAvatarRef;
				return ref === undefined ? fail("not_found", "没有可交的观众头像") : ok({ ref });
			},
			async fetchTierIcon(identity, program, tierKey) {
				probe.tierIconAsked.push(`${identity.externalId}:${program}:${tierKey}`);
				const ref = probe.tierIconRef;
				return ref === undefined ? fail("not_found", "没有可交的徽章") : ok({ ref });
			},
		},
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
		async fetchProfile(identity, signal) {
			probe.profileAsked.push(identity);
			if (signal.aborted) return fail("unavailable", "profile request was aborted");
			if (probe.profileOutcome) return probe.profileOutcome;
			const ctx = probe.ctx;
			if (!ctx) return fail("unavailable", "假来源还没 start");
			const stored = await ctx.storeImage(Buffer.from(IN_PROCESS_TIER_ICON_BASE64, "base64"));
			const known = options.knownProfiles?.[identity.externalId];
			if (known) return ok({ ...known, ...(stored.ok ? { avatar: stored.ref } : {}) });
			return ok({
				name: `资料-${identity.externalId}`,
				followers: 314,
				bio: "现查的来源资料",
				...(stored.ok ? { avatar: stored.ref } : {}),
			});
		},
		// 卡片页预览:不报问题、不上报,只记被问了什么(预览没有副作用)。
		async fetchPreview(identity, options) {
			probe.previewAsked.push({ externalId: identity.externalId, options });
			if (probe.previewOutcome) return probe.previewOutcome;
			return options.kind === "live"
				? ok({ kind: "live" as const, details: { title: "对拍预览直播P51" } })
				: ok({
						kind: "post" as const,
						report: {
							postId: `preview-${options.nth}`,
							url: "https://example.invalid/preview",
							post: {
								creator: { name: "对拍预览作者" },
								publishedAt: "2026-10-28T00:00:00.000Z",
								text: `对拍预览正文P51 第${options.nth}条`,
							},
						},
					});
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
			// 自己的档位徽章自己存进图库,把引用写进自己那份描述符(R2 甲):核心读到的就是这一格。
			const storedIcon = await ctx.storeImage(Buffer.from(IN_PROCESS_TIER_ICON_BASE64, "base64"));
			if (storedIcon.ok) {
				probe.tierIconRef = storedIcon.ref;
				const declared = descriptor.membershipPrograms?.find(
					(program) => program.id === IN_PROCESS_PROGRAM_ID,
				);
				if (declared && Array.isArray(declared.tiers)) {
					const own = declared.tiers.find((tier) => tier.key === IN_PROCESS_TIER_KEY);
					if (own) own.icon = { ref: storedIcon.ref };
				}
			}
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
			probe.aiToolProviderClaim = ctx.registerAiToolProvider(createInProcessAiToolProvider());

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
			await probe.duringStop?.();
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
	 * 来源已被推送链路停下、来源上下文已收掉,而进程还活着(集成存储与总线都还在)的那一刻要做的事:
	 * 关停钩子里排在推送链路之后、集成上下文收尾之前。测试在这里让已停的来源再上报。
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
 * 包 `runtime/bootstrap.ts`(`vi.mock("../runtime/bootstrap.js", …)` 的实现体):真运行时照建,在它的总线上挂几只耳朵,
 * 记下假来源世界要看的事件。总线是运行时的(组装根不拿它),所以在这里借。
 */
export function wrapBootstrap(real: typeof Bootstrap): typeof Bootstrap {
	return {
		...real,
		createAppRuntime(...args) {
			const runtime = real.createAppRuntime(...args);
			runtime.bus.on("subscription-auth-changed", (changed) => {
				inProcessWorld.authChanges.push(changed);
			});
			runtime.bus.on("post-detected", (event) => {
				inProcessWorld.postDetected.push(event);
			});
			runtime.bus.on("problems-changed", ({ reporter }) => {
				inProcessWorld.problemsChanged.push(reporter);
			});
			return runtime;
		},
	};
}

/**
 * 包 `compose.ts`(`vi.mock("../compose.js", …)` 的实现体):真模块照常跑(真 B 站来源并排登记),
 * 之外加两样 —— 设置段后面追加假来源的一段;`registerSources` 里真的登记完之后,对假来源调**同一个**
 * `pipeline.registerSource`。
 *
 * 测试用组装要自己做三件事(内置来源的那几件在 `compose.ts` / B 站来源里,这里照做):
 * 1. 设置段(上面);
 * 2. 集成上下文:`integrationStore.open(键)` + `openIntegration`(请求客户端、上下文与收尾挂在一起;存储是异步开的,
 *    所以在 `registerSources` 里);
 * 3. 关停次序:上下文的收尾钩子在**这里**(早于 `createPipelineRuntime`)登记 —— 关停钩子后登记的先跑,所以推送链路先停来源,
 *    钩子后收上下文;钩子登记晚了,上下文会先于来源的 `stop()` 被中止。
 */
export function wrapCompose(real: typeof Compose): typeof Compose {
	return {
		...real,
		BUILTIN_INTEGRATION_SETTINGS: [...real.BUILTIN_INTEGRATION_SETTINGS, inProcessSettingsSegment],
		BUILTIN_INTEGRATION_KEYS: [...real.BUILTIN_INTEGRATION_KEYS, IN_PROCESS_KEY],
		composeBuiltinIntegrations(deps) {
			const builtins = real.composeBuiltinIntegrations(deps);
			inProcessWorld.serviceCtx = deps.serviceCtx;
			inProcessWorld.inboundGroup = deps.inbound.group;
			const logger = deps.serviceCtx.forSubsystem(IN_PROCESS_KEY, IN_PROCESS_KEY).logger;
			let opened: { integration: OpenedIntegration; store: { close(): void } } | undefined;
			deps.serviceCtx.onDispose(async () => {
				// 此刻推送链路已停掉来源、收掉了来源上下文(钩子后登记的先跑),集成上下文还没收。
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
				async registerSources(pipeline) {
					await builtins.registerSources(pipeline);
					const store = await deps.integrationStore.open(IN_PROCESS_KEY);
					const integration = await openIntegration({
						timezoneReader: deps.timezoneReader,
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
					await pipeline.registerSource({
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
