import {
	BILIBILI_GUARD_PROGRAM,
	type Disposable,
	type Failure,
	formatAgo,
	type MessageBus,
	type ServiceContext,
	type Source,
	type SourceAuth,
	type SourceContext,
	type SourceDescriptor,
	type SourceHealth,
} from "@bilibili-notify/internal";
import { errorMessageOf } from "../util/error-message.js";
import type { Api } from "./api/index.js";
import { DynamicPoller } from "./dynamic/index.js";
import { HEALTH_TEXTS } from "./health-texts.js";
import type { ImagesDeps } from "./images.js";
import { createBiliLinkResolver } from "./link-resolver.js";
import type { ProblemLayers } from "./problem-layers.js";
import { PROBLEM_TEXTS } from "./problem-texts.js";
import {
	BiliDynamicSettingsSchema,
	BiliLoginCheckSettingsSchema,
	BiliSettingsSchema,
} from "./settings.js";

export interface BiliSourceDeps {
	api: Api;
	/** 引擎自己还在听 auth-restored / auth-lost(登录生命周期的事件,随 3b 直播并进来源时再收)。 */
	bus: MessageBus;
	imageFetcher: ImagesDeps["images"];
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
	/** 可注入的时钟(`health()` 的相对时间用)。测试用,生产不传。 */
	now?: () => number;
}

export interface BiliSource extends Source {
	/** 动态引擎;没 start、已 stop、或动态那一格设置读不懂时是 undefined。开发场景的「现在就跑」读它。 */
	dynamic(): DynamicPoller | undefined;
}

/** 从 B 站设置算动态引擎的配置(启动与热更共用)。 */
const dynamicConfigOf = (settings: { dynamicCron: string }) => ({
	dynamicCron: settings.dynamicCron,
	dynamicVideoUrlToBV: false,
});

/** 面板上的叫法与键名:问题文案里带着,主人要照着去系统页找那一格。 */
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
 * B 站来源的自我介绍。`externalIdRegex`:订阅的外部 id 就是 UID,只能是数字 —— 这条规矩住在这里,
 * 核心(新建订阅处)只照描述符核,不再自己写「B 站 uid 是数字」。
 */
export const BILI_SOURCE_DESCRIPTOR: SourceDescriptor = {
	label: "B 站",
	postNoun: "动态",
	externalIdRegex: "^\\d+$",
	membershipPrograms: [BILIBILI_GUARD_PROGRAM],
};

export function createBiliSource(deps: BiliSourceDeps): BiliSource {
	let engine: DynamicPoller | undefined;
	let handles: Disposable[] = [];
	let started = false;
	// 动态那一格设置读不懂、动态停着(`applyDynamic` 记;`health()` 读)。
	let dynamicStopped = false;
	const now = deps.now ?? Date.now;

	const descriptor = BILI_SOURCE_DESCRIPTOR;

	return {
		descriptor,
		auth: deps.auth,
		dynamic: () => engine,
		health(): SourceHealth {
			// 「动态停着」优先:最需要主人动手的一条,而且这时引擎不在、「上次抓取」没有意义。不提登录(登录有自己的一行)。
			if (dynamicStopped) return { summary: HEALTH_TEXTS.dynamicStopped };
			const at = engine?.lastFetchAt();
			const ago = at === undefined ? undefined : formatAgo(at, now());
			return { summary: ago === undefined ? HEALTH_TEXTS.neverFetched : HEALTH_TEXTS.fetched(ago) };
		},
		async start(ctx: SourceContext) {
			if (started) throw new Error("bilibili source is already started");
			const mine: Disposable[] = [];
			const stopEngine = (): void => {
				engine?.stop();
				engine = undefined;
			};

			// 动态那一样,一个函数管起、热更、停三件事。读得懂:引擎不在就造并起,在就热更;读不懂:引擎在就停掉,
			// 报一条问题。「先起成功、后清问题」:起来的途中抛了别的错,那一条问题还在表里,下次设置变了再试。
			const dynamicSettings = ctx.settings(BiliDynamicSettingsSchema);
			// 只为分辨面板此刻显示什么:动态读者比读盘 schema 多一道「能解析」,一条字符串但解析不了的 cron 读盘时算好的,
			// 面板显示的是盘上原文;这一份没有那一道,它读得懂而动态那份读不懂就是这一种。
			const dynamicCell = ctx.settings(BiliSettingsSchema.pick({ dynamicCron: true }));
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
						imageFetcher: deps.imageFetcher,
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
					ctx.resolveProblem({ code: DYNAMIC_PROBLEM, notify: false });
					return;
				}
				stopEngine();
				dynamicStopped = true;
				const panelShowsDefault = read.issues?.[0]?.path === undefined || !dynamicCell.get().ok;
				const message = PROBLEM_TEXTS.dynamicSettingsInvalid.text(
					causeOf(read, DYNAMIC_CELL),
					panelShowsDefault,
				);
				ctx.logger.warn(
					`[settings] 动态(${DYNAMIC_CELL.key})读不懂,动态先停着: ${read.issues?.[0]?.message ?? read.message}`,
				);
				ctx.reportProblem({
					code: DYNAMIC_PROBLEM,
					message,
					notify: PROBLEM_TEXTS.dynamicSettingsInvalid.notify,
				});
			};

			// 登录检查那一样:读得懂按分钟数挂 / 换,读不懂停掉。登录本身照常,失效仍由请求撞 -101 报上来。
			const loginCheckSettings = ctx.settings(BiliLoginCheckSettingsSchema);
			const applyLoginCheck = (): void => {
				const read = loginCheckSettings.get();
				if (read.ok) {
					deps.loginCheck.setHealthCheckMs(read.settings.healthCheckMinutes * 60_000);
					ctx.resolveProblem({ code: LOGIN_CHECK_PROBLEM, notify: false });
					return;
				}
				deps.loginCheck.setHealthCheckMs(0);
				ctx.logger.warn(
					`[settings] 登录检查(${LOGIN_CHECK_CELL.key})读不懂,定时的登录检查先停着: ${read.issues?.[0]?.message ?? read.message}`,
				);
				ctx.reportProblem({
					code: LOGIN_CHECK_PROBLEM,
					message: PROBLEM_TEXTS.loginCheckSettingsInvalid.text(
						causeOf(read, LOGIN_CHECK_CELL),
						true,
					),
					notify: PROBLEM_TEXTS.loginCheckSettingsInvalid.notify,
				});
			};

			// 取设置的把手都在上面,抛了(组装处漏登记)时还没占「已起」;从这里起任何一步抛了都由下面的 catch 复位。
			started = true;
			try {
				// 始终挂一次,转给当下的引擎(动态停着时没有引擎,什么都不做)。
				mine.push(ctx.onSubscriptionsChanged(() => engine?.syncSubscriptions()));
				// 群里贴的 B 站视频链接归这个来源认;宿主在来源停下时也会撤,这里记着是为了启动失败时自己收拾。
				mine.push(
					ctx.registerLinkResolver(
						createBiliLinkResolver({
							label: descriptor.label,
							api: deps.api,
							imageFetcher: deps.imageFetcher,
							logger: ctx.logger,
						}),
					),
				);
				applyDynamic();
				mine.push(dynamicSettings.onChange(guarded(ctx, "动态", applyDynamic)));
				applyLoginCheck();
				mine.push(loginCheckSettings.onChange(guarded(ctx, "登录检查", applyLoginCheck)));
			} catch (err) {
				// 登记表那头只会放键、收上下文,不会替来源停 cron、停心跳:自己收拾干净再抛。
				for (const handle of mine) handle.dispose();
				stopEngine();
				dynamicStopped = false;
				deps.loginCheck.setHealthCheckMs(0);
				started = false;
				throw err;
			}
			handles = mine;
			// 最后一步:核心那头此刻才有,不管动态起没起都接上(登录失效、风控、直播间停监照常进问题表)。
			// 接上之前记着的问题(登录失效、风控、请求失败)在这一刻整份补报。
			deps.problems.attach(ctx);
		},
		// 🔴 没有 await:登记表撤登记时调 stop 是不等它的,而引擎的 dispose 是同步函数、紧接着就关作品入口,
		// 「来源先停、入口后关」只在 stop 的同步段里已经停干净时成立。
		stop() {
			// 第一步先摘:引擎收尾时的「不再适用」清除不许变成对主人说的一句「已恢复」。
			deps.problems.detach();
			for (const handle of handles) handle.dispose();
			handles = [];
			engine?.stop();
			engine = undefined;
			dynamicStopped = false;
			deps.loginCheck.setHealthCheckMs(0);
			started = false;
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
