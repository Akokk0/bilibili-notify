import {
	BILIBILI_GUARD_PROGRAM,
	type Disposable,
	type Failure,
	fail,
	formatAgo,
	type Identity,
	type ImageRef,
	type LiveStatusResult,
	type MembershipTier,
	type MessageBus,
	ok,
	type Result,
	type ServiceContext,
	type Source,
	type SourceAuth,
	type SourceContext,
	type SourceDescriptor,
	type SourceHealth,
} from "@bilibili-notify/internal";
import type { LocaleReader } from "../i18n/locale-reader.js";
import { errorMessageOf } from "../util/error-message.js";
import { createBiliAiToolProvider } from "./ai-tools.js";
import type { Api } from "./api/index.js";
import { DynamicPoller } from "./dynamic/index.js";
import { BILI_EXTERNAL_ID_REGEX } from "./external-id.js";
import { watchFollows } from "./follow-sync.js";
import { HEALTH_TEXTS } from "./health-texts.js";
import { fetchAvatar, IMAGE_REQUEST_HEADERS } from "./images.js";
import { createBiliLinkResolver } from "./link-resolver.js";
import { createRoomIds, type RoomIds } from "./live/room-ids.js";
import { BiliLiveRooms } from "./live/session/bili-live-rooms.js";
import { createViewerAvatarFetcher, type ViewerAvatarFetcher } from "./live/viewer-avatar.js";
import type { ProblemLayers } from "./problem-layers.js";
import { PROBLEM_TEXTS } from "./problem-texts.js";
import { createProfileFetcher } from "./profile.js";
import { searchBiliCreators } from "./search-creators.js";
import { BiliDynamicSettingsSchema, BiliLoginCheckSettingsSchema } from "./settings.js";

export interface BiliSourceDeps {
	api: Api;
	/** 引擎自己还在听 auth-restored / auth-lost(登录生命周期的事件,随 3b 直播并进来源时再收)。 */
	bus: MessageBus;
	/** 可回收的定时器(退避重启用);公共上下文里没有定时器。 */
	setTimeout: ServiceContext["setTimeout"];
	/** 登录口(`AuthSystem.auth`):原样挂到 `Source.auth`,登记表的视图带着它。 */
	auth: SourceAuth;
	/**
	 * 分层上报器(`compose.ts` 造,与给入口的是同一个):`start` 最后一步接上这个来源的上下文,
	 * `stop` 第一步摘下;动态引擎拉失败时往里报、拉成功与停下时往里清。
	 */
	problems: Pick<
		ProblemLayers,
		"attach" | "detach" | "reportRisk" | "resolveRisk" | "reportFailure" | "resolveFailure"
	>;
	/**
	 * 定时的登录检查(心跳)的开关(`AuthSystem.setHealthCheckMs`):`start` 里按设置挂上 / 停下,`stop` 里停掉。
	 * 登录系统自己不认识设置;`ms <= 0` 等于不挂。
	 */
	loginCheck: { setHealthCheckMs(ms: number): void };
	/** 语言读口:`start` 里订,语言变了把读不懂的设置问题按新语言再报一遍。 */
	locale: Pick<LocaleReader, "onChange">;
	/** 直播那一路的宿主上下文(日志标签仍是 `live`)。 */
	liveContext: ServiceContext;
	/** 可注入的时钟(`health()` 的相对时间用)。测试用,生产不传。 */
	now?: () => number;
}

export interface BiliSource extends Source {
	/** 动态引擎;没 start、已 stop、或动态那一格设置读不懂时是 undefined。开发场景的「现在就跑」读它。 */
	dynamic(): DynamicPoller | undefined;
	/** 直播房号;没 start 或已 stop 时是 undefined。开发场景挑房间读它。 */
	liveRooms(): { roomIdOf(externalId: string): string | undefined } | undefined;
}

/** 从 B 站设置算动态引擎的配置(启动与热更共用)。 */
const dynamicConfigOf = (settings: { dynamicCron: string }) => ({
	dynamicCron: settings.dynamicCron,
	dynamicVideoUrlToBV: false,
});

/** 设置那一格的叫法与键名:问题文案里带着,让主人认出是哪一格。 */
const DYNAMIC_CELL = { label: "动态检查频率", key: "dynamicCron" } as const;
const LOGIN_CHECK_CELL = { label: "登录心跳间隔", key: "healthCheckMinutes" } as const;

const DYNAMIC_PROBLEM = "dynamic_settings_invalid";
const LOGIN_CHECK_PROBLEM = "login_check_settings_invalid";

/** 一份读不懂的原因 → 「原因半句」:带 `path` 是那一格坏了,不带是整个文件读不懂。 */
function causeOf(failure: Failure, cell: { label: string; key: string }): string {
	const reason = failure.issues?.[0]?.message ?? failure.message;
	return failure.issues?.[0]?.path === undefined
		? PROBLEM_TEXTS.settingsCause.file(reason)
		: PROBLEM_TEXTS.settingsCause.cell(cell.label, cell.key, reason);
}

/**
 * B 站来源的自我介绍。`externalIdRegex`:订阅的外部 id 就是 UID,只能是数字 —— 这条规矩
 * 由来源描述符与 AI 工具共用;核心(新建订阅处)只照描述符核,不再自己写「B 站 uid 是数字」。
 */
export const BILI_SOURCE_DESCRIPTOR: SourceDescriptor = {
	label: "B 站",
	creatorNoun: "UP主",
	externalIdNoun: "UID",
	postNoun: "动态",
	externalIdRegex: BILI_EXTERNAL_ID_REGEX,
	membershipPrograms: [BILIBILI_GUARD_PROGRAM],
};

/** 每两个缺图档抓取轮次之间至少隔这么久,免得每条上舰都敲一次静态站。 */
const GUARD_ICON_RETRY_INTERVAL_MS = 5 * 60 * 1000;

/** 每个来源实例一份:运行中补上的图库引用只属于这个实例,模块里的档位表保持不变。 */
function copyBiliDescriptor(): SourceDescriptor {
	return {
		...BILI_SOURCE_DESCRIPTOR,
		membershipPrograms: BILI_SOURCE_DESCRIPTOR.membershipPrograms?.map((program) => ({
			...program,
			tiers: Array.isArray(program.tiers)
				? program.tiers.map((tier) => ({
						...tier,
						...(tier.icon ? { icon: { ...tier.icon } } : {}),
					}))
				: program.tiers,
		})),
	};
}

export function createBiliSource(deps: BiliSourceDeps): BiliSource {
	let engine: DynamicPoller | undefined;
	let handles: Disposable[] = [];
	let started = false;
	// 动态那一格设置读不懂、动态停着(`applyDynamic` 记;`health()` 读)。
	let dynamicStopped = false;
	const now = deps.now ?? Date.now;

	const descriptor = copyBiliDescriptor();
	let sourceCtx: SourceContext | undefined;
	let viewerAvatars: ViewerAvatarFetcher | undefined;
	let lastGuardAttemptAt: number | undefined;
	let guardFetch: Promise<void> | undefined;
	let rooms: BiliLiveRooms | undefined;
	let roomIds: RoomIds | undefined;
	let profileFetcher: ReturnType<typeof createProfileFetcher> | undefined;
	const superchatAvatarUrls = new Map<string, string>();

	const guardTiers = (): MembershipTier[] => {
		const program = descriptor.membershipPrograms?.find(
			(candidate) => candidate.id === BILIBILI_GUARD_PROGRAM.id,
		);
		return program && Array.isArray(program.tiers) ? program.tiers : [];
	};

	/** 抓所有还缺引用的官方档位图;每档自己收错,所以这一轮不会留下未处理的拒绝。 */
	function ensureGuardIcons(signal?: AbortSignal): Promise<void> {
		const ctx = sourceCtx;
		if (!ctx || signal?.aborted) return Promise.resolve();
		const missing = guardTiers().filter(
			(tier) => tier.icon?.url !== undefined && tier.icon.ref === undefined,
		);
		if (missing.length === 0) return Promise.resolve();
		if (guardFetch) return guardFetch;
		if (
			lastGuardAttemptAt !== undefined &&
			now() - lastGuardAttemptAt < GUARD_ICON_RETRY_INTERVAL_MS
		) {
			return Promise.resolve();
		}
		lastGuardAttemptAt = now();
		const made = Promise.all(
			missing.map(async (tier) => {
				try {
					const result = await ctx.fetchImage(tier.icon?.url ?? "", {
						headers: IMAGE_REQUEST_HEADERS,
						...(signal ? { signal } : {}),
					});
					if (result.ok) {
						tier.icon = { ...tier.icon, ref: result.ref };
						return;
					}
					ctx.logger.warn(
						`[guard-icons] 抓「${tier.name}」徽章图失败: ${result.code}: ${result.message}`,
					);
				} catch (error) {
					ctx.logger.warn(`[guard-icons] 抓「${tier.name}」徽章图失败: ${errorMessageOf(error)}`);
				}
			}),
		).then(() => undefined);
		guardFetch = made;
		void made.finally(() => {
			if (guardFetch === made) guardFetch = undefined;
		});
		return made;
	}

	return {
		descriptor,
		auth: deps.auth,
		dynamic: () => engine,
		liveRooms: () =>
			roomIds === undefined
				? undefined
				: {
						roomIdOf: (externalId) => roomIds?.get(externalId),
					},
		fetchProfile(identity, signal) {
			return profileFetcher
				? profileFetcher.fetchProfile(identity, signal)
				: Promise.resolve(fail("unavailable", "bilibili source is not running"));
		},
		liveInteractions: {
			async fetchViewerAvatar(
				identity: Identity,
				viewerId: string,
				signal: AbortSignal,
			): Promise<Result<{ ref: ImageRef }>> {
				if (signal.aborted) return fail("indeterminate", "viewer avatar request was aborted");
				const direct = superchatAvatarUrls.get(viewerId);
				if (direct && sourceCtx) {
					const ref = await fetchAvatar(direct, {
						images: { fetchImage: sourceCtx.fetchImage },
						logger: sourceCtx.logger,
					});
					return ref ? ok({ ref }) : fail("unavailable", "superchat viewer avatar is unavailable");
				}
				if (!viewerAvatars) return fail("unavailable", "bilibili source is not running");
				const ref = await viewerAvatars.fetch(viewerId, identity.externalId);
				return ref ? ok({ ref }) : fail("unavailable", "viewer avatar is unavailable");
			},
			async fetchTierIcon(
				_identity: Identity,
				program: string,
				tierKey: string,
				signal: AbortSignal,
			): Promise<Result<{ ref: ImageRef }>> {
				const membership = descriptor.membershipPrograms?.find(
					(candidate) => candidate.id === program,
				);
				const tier =
					membership && Array.isArray(membership.tiers)
						? membership.tiers.find((candidate) => candidate.key === tierKey)
						: undefined;
				if (!tier) return fail("not_found", "membership tier not found");
				if (tier.icon?.ref === undefined) await ensureGuardIcons(signal);
				const ref = tier.icon?.ref;
				return ref ? ok({ ref }) : fail("unavailable", "guard icon is unavailable");
			},
		},
		fetchLiveStatus(identity: Identity, signal: AbortSignal): Promise<LiveStatusResult> {
			if (!rooms) {
				return Promise.resolve(fail("unavailable", "bilibili live rooms are not running"));
			}
			return rooms.fetchLiveStatus(identity, signal);
		},
		// B 站的 api 不收 signal,宿主不等了也只能让这一发自己跑完。
		searchCreators: (query) => searchBiliCreators(deps.api, query),
		health(): SourceHealth {
			// 「动态停着」优先:最需要主人动手的一条,而且这时引擎不在、「上次抓取」没有意义。不提登录(登录有自己的一行)。
			if (dynamicStopped) return { summary: HEALTH_TEXTS.dynamicStopped };
			const at = engine?.lastFetchAt();
			const ago = at === undefined ? undefined : formatAgo(at, now());
			return { summary: ago === undefined ? HEALTH_TEXTS.neverFetched : HEALTH_TEXTS.fetched(ago) };
		},
		async start(ctx: SourceContext) {
			if (started) throw new Error("bilibili source is already started");
			sourceCtx = ctx;
			roomIds = createRoomIds({
				api: deps.api,
				state: ctx.state,
				subscriptions: () => ctx.subscriptions(),
				setTimeout: deps.setTimeout,
				now,
				logger: ctx.logger,
			});
			rooms = new BiliLiveRooms({
				api: deps.api,
				bus: deps.bus,
				liveContext: deps.liveContext,
				roomIds,
				rememberFanClubName: (externalId, name) => {
					profileFetcher?.rememberFanClubName(externalId, name);
				},
				problems: deps.problems,
				rememberSuperchatAvatar: (viewerId, url) => {
					superchatAvatarUrls.set(viewerId, url);
				},
			});
			viewerAvatars = createViewerAvatarFetcher({
				api: deps.api,
				images: {
					fetchImage: (url, options) => ctx.fetchImage(url, options),
				},
				logger: ctx.logger,
				now,
			});
			const mine: Disposable[] = [];
			const stopEngine = (): void => {
				engine?.stop();
				engine = undefined;
			};

			// 动态那一样,一个函数管起、热更、停三件事。读得懂:引擎不在就造并起,在就热更;读不懂:引擎在就停掉,
			// 报一条问题。「先起成功、后清问题」:起来的途中抛了别的错,那一条问题还在表里,下次设置变了再试。
			const dynamicSettings = ctx.settings(BiliDynamicSettingsSchema);
			// 读不懂时那一句的取字函数(读得懂就清掉):换语言只把这两条再报一遍,不重跑 apply*
			// (重跑会热更引擎、重挂心跳计时)。
			let dynamicWording: (() => string) | undefined;
			let loginCheckWording: (() => string) | undefined;
			const reportInvalid = (code: string, wording: () => string, notify: boolean): void => {
				ctx.reportProblem({ code, message: wording(), notify });
			};
			const applyDynamic = (): void => {
				const read = dynamicSettings.get();
				if (read.ok) {
					if (engine) {
						engine.updateConfig(dynamicConfigOf(read.settings));
						return;
					}
					const made = new DynamicPoller({
						logger: ctx.logger,
						setTimeout: deps.setTimeout,
						bus: deps.bus,
						api: deps.api,
						problems: deps.problems,
						fetchImage: ctx.fetchImage,
						reportPost: (externalId, report) => ctx.reportPost(externalId, report),
						subscriptions: () => ctx.subscriptions(),
						config: dynamicConfigOf(read.settings),
					});
					try {
						made.start();
					} catch (err) {
						made.stop();
						throw err;
					}
					engine = made;
					dynamicStopped = false;
					dynamicWording = undefined;
					ctx.resolveProblem({ code: DYNAMIC_PROBLEM, notify: false });
					return;
				}
				stopEngine();
				dynamicStopped = true;
				ctx.logger.warn(
					`[settings] 动态(${DYNAMIC_CELL.key})读不懂,动态先停着: ${read.issues?.[0]?.message ?? read.message}`,
				);
				dynamicWording = () =>
					PROBLEM_TEXTS.dynamicSettingsInvalid.text(causeOf(read, DYNAMIC_CELL));
				reportInvalid(DYNAMIC_PROBLEM, dynamicWording, PROBLEM_TEXTS.dynamicSettingsInvalid.notify);
			};

			// 登录检查那一样:读得懂按分钟数挂 / 换,读不懂停掉。登录本身照常,失效仍由请求撞 -101 报上来。
			const loginCheckSettings = ctx.settings(BiliLoginCheckSettingsSchema);
			const applyLoginCheck = (): void => {
				const read = loginCheckSettings.get();
				if (read.ok) {
					deps.loginCheck.setHealthCheckMs(read.settings.healthCheckMinutes * 60_000);
					loginCheckWording = undefined;
					ctx.resolveProblem({ code: LOGIN_CHECK_PROBLEM, notify: false });
					return;
				}
				deps.loginCheck.setHealthCheckMs(0);
				ctx.logger.warn(
					`[settings] 登录检查(${LOGIN_CHECK_CELL.key})读不懂,定时的登录检查先停着: ${read.issues?.[0]?.message ?? read.message}`,
				);
				loginCheckWording = () =>
					PROBLEM_TEXTS.loginCheckSettingsInvalid.text(causeOf(read, LOGIN_CHECK_CELL));
				reportInvalid(
					LOGIN_CHECK_PROBLEM,
					loginCheckWording,
					PROBLEM_TEXTS.loginCheckSettingsInvalid.notify,
				);
			};

			// 换语言:读不懂的那一两句按新语言再报一遍(同 code,表里只换文案)。
			const reportInvalidAgain = (): void => {
				try {
					if (dynamicWording) {
						reportInvalid(
							DYNAMIC_PROBLEM,
							dynamicWording,
							PROBLEM_TEXTS.dynamicSettingsInvalid.notify,
						);
					}
					if (loginCheckWording) {
						reportInvalid(
							LOGIN_CHECK_PROBLEM,
							loginCheckWording,
							PROBLEM_TEXTS.loginCheckSettingsInvalid.notify,
						);
					}
				} catch (err) {
					ctx.logger.warn(`[settings] 换语言时重报设置问题失败(已忽略): ${errorMessageOf(err)}`);
				}
			};

			// 取设置的把手都在上面,抛了(组装处漏登记)时还没占「已起」;从这里起任何一步抛了都由下面的 catch 复位。
			started = true;
			try {
				profileFetcher = createProfileFetcher({
					api: deps.api,
					problems: deps.problems,
					state: ctx.state,
					subscriptions: () => ctx.subscriptions(),
					images: { fetchImage: ctx.fetchImage },
					logger: ctx.logger,
					now,
					setTimeout: deps.setTimeout,
				});
				profileFetcher.syncSubscriptions();
				// 始终挂一次,转给当下的引擎(动态停着时没有引擎,什么都不做)。
				mine.push(
					ctx.onSubscriptionsChanged(() => {
						profileFetcher?.syncSubscriptions();
						roomIds?.syncSubscriptions();
						engine?.syncSubscriptions();
					}),
				);
				mine.push(
					watchFollows({
						api: deps.api,
						auth: deps.auth,
						subscriptions: () => ctx.subscriptions(),
						onSubscriptionsChanged: (fn) => ctx.onSubscriptionsChanged(fn),
						problems: deps.problems,
						logger: ctx.logger,
						signal: ctx.signal,
					}),
				);
				// 群里贴的 B 站视频链接归这个来源认;宿主在来源停下时也会撤,这里记着是为了启动失败时自己收拾。
				mine.push(
					ctx.registerLinkResolver(
						createBiliLinkResolver({
							label: descriptor.label,
							api: deps.api,
							fetchImage: ctx.fetchImage,
							logger: ctx.logger,
						}),
					),
				);
				mine.push(ctx.registerAiToolProvider(createBiliAiToolProvider({ api: deps.api })));
				applyDynamic();
				rooms.start(ctx, ctx.subscriptions());
				mine.push(dynamicSettings.onChange(guarded(ctx, "动态", applyDynamic)));
				applyLoginCheck();
				mine.push(loginCheckSettings.onChange(guarded(ctx, "登录检查", applyLoginCheck)));
				mine.push(deps.locale.onChange(reportInvalidAgain));
			} catch (err) {
				// 登记表那头只会放键、收上下文,不会替来源停 cron、停心跳:自己收拾干净再抛。
				for (const handle of mine) handle.dispose();
				rooms.stop();
				rooms = undefined;
				stopEngine();
				dynamicStopped = false;
				deps.loginCheck.setHealthCheckMs(0);
				started = false;
				sourceCtx = undefined;
				roomIds = undefined;
				profileFetcher = undefined;
				viewerAvatars = undefined;
				throw err;
			}
			handles = mine;
			if (ctx.subscriptions().some((view) => view.monitorsLive)) {
				void ensureGuardIcons();
			}
			// 最后一步:核心那头此刻才有,不管动态起没起都接上(登录失效、风控、直播间停监照常进问题表)。
			// 接上之前记着的问题(登录失效、风控、请求失败)在这一刻整份补报。
			deps.problems.attach(ctx);
		},
		// 🔴 没有 await:登记表撤登记时调 stop 是不等它的,而引擎的 dispose 是同步函数、紧接着就关作品入口,
		// 「来源先停、入口后关」只在 stop 的同步段里已经停干净时成立。
		stop() {
			// 第一步先摘:引擎收尾时的「不再适用」清除不许变成对主人说的一句「已恢复」。
			deps.problems.detach();
			rooms?.stop();
			rooms = undefined;
			superchatAvatarUrls.clear();
			for (const handle of handles) handle.dispose();
			handles = [];
			engine?.stop();
			engine = undefined;
			dynamicStopped = false;
			deps.loginCheck.setHealthCheckMs(0);
			started = false;
			sourceCtx = undefined;
			roomIds = undefined;
			profileFetcher = undefined;
			viewerAvatars = undefined;
			guardFetch = undefined;
			return Promise.resolve();
		},
	};
}

/**
 * 设置变了才跑的那一半:运行中抛了(造引擎抛了别的错)不许冲回宿主的通知循环,记一行 error,下次设置变了再试。
 * 把手那一层本来就逐个回调接住,这里多记一行点名是哪一样。
 */
function guarded(ctx: SourceContext, what: string, run: () => void): () => void {
	return () => {
		try {
			run();
		} catch (err) {
			ctx.logger.error(
				`[settings] ${what}那一样按新设置重来时抛错(下次设置变了再试): ${errorMessageOf(err)}`,
			);
		}
	};
}
