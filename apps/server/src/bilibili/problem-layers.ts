import type { Logger, SourceAuth, SourceContext } from "@bilibili-notify/internal";
import type { LocaleReader } from "../i18n/locale-reader.js";
import { logText } from "./i18n.js";
import { isLoginLost } from "./login-edges.js";
import { PROBLEM_TEXTS } from "./problem-texts.js";

/**
 * B 站的报错按因果分三层,问题表里同时只留最上面一层(动态与直播共用一个上报器):
 *
 * 1. **未登录**(来源级):这里**不报**,登录问题(`auth_lost`)由宿主看登录状态报与清;这一层只用来压下面两层。
 *    只看 `AuthState.status` —— `expired` / `logged-out` 算掉了;`logged-in` 算好了;
 *    `awaiting-scan` / `confirming` / `error` 三种不动,保持上一次的结论(已登录时重扫不许误压,
 *    未登录时扫码途中不许误松)。
 * 2. **风控**(`risk_controlled`,来源级):任一路撞了就开,所有撞着的路都清了才清。带不带私聊由撞上的路说了算
 *    (`reportRisk` 的 `notify`,取值集中在 `problem-texts.ts`):只有不要私聊的路开着时条目不带私聊;
 *    之后有一路要私聊的进来,**再报一次、带私聊**。只升不降:要私聊的那一路先走了也不撤回,条目照旧开着,
 *    整层清掉之后才从头算。
 *    一路的清由调用方按两种说法叫:**真解除**(这一路这一次的结果不是风控拦截:拉成功了、预检通过了)
 *    与**不再适用**(`notify: false`:这一路不再跑了、换成了别的失败、会话结束了)。
 *    约定:最后清掉的那一下是「不再适用」,就不对主人说「风控已经解除」。
 * 3. **某项请求失败**(code 与带不带私聊都由调用方给):每次失败都叫(幂等),调用方自己的成功或不再适用时清。
 *
 * 高层一开,表里已有的低层静默抹掉(`notify: false`,不补「已恢复」)。第三层按 `lasting` 分两种:
 * - `lasting: false`(会自己再报的,如拉动态失败):高层开起来时在自己手里清空,高层开着时的上报只记日志、
 *   不存;高层清掉后它不会自己冒回来,要等调用方下一次失败再报。
 * - `lasting: true`(报一次就不再报、直到有人去修的,如某个直播间停止监听):高层开着时**存下但不报**,
 *   高层开起来时也不清空;高层清掉的那一刻把存着的报上去(照各自的 `notify`)。它的主人调 `resolveFailure`
 *   时照常删 —— 压着的时候被删了,高层清掉也不再报。**曾经报给过核心的**(主人当时已经听过一遍),被压下去
 *   再冒出来时报回表里但不带私聊(文案、恢复句照旧),**之后在它被清掉之前同一件事再报多少次也不带**;
 *   高层开着时才第一次报的(从没到过核心),冒出来时照它自己的 `notify`。
 *
 * 手里存的是「此刻该在表里的东西」,不是事件流水。核心那头(`attach` 交进来的上下文)是后接上的:接上那一刻把
 * 这份现状整份报上去,所以接上之前记着的不会丢;`detach`(来源停下)之后再报继续记在自己手里,等下一次接上。
 * 这样 `since` 是接上那一刻,接上之前开了又清掉的不会出现。
 *
 * **换语言**(ADR-0037 决策 8):第三层的句子与恢复句存的是**取字函数**,不是出好的字,出字那一刻才跑;语言真变了
 * (`locale.onChange`),把此刻该在表里的那一份(接上时报的那一份:只报最上面一层)再报一遍,句子就是新语言的。
 * 和接上时的补报不同,换语言**不复位** `muted`,`notify` 照各自记着的 —— 同一件事只是换了说法,不是新的一条;
 * 没接上、已 `dispose` 时什么都不报(之后接上时的补报本来就取新字)。口吻不管:这里的句子只有平实版。
 *
 * 每个方法都不许往外抛:调用点都在动态轮询与直播监听的关键控制流上,核心那头抛了只记一行 warn。
 */
export interface ProblemLayers {
	/**
	 * 风控:这一路撞了(每次撞都叫,幂等)。路的键:`dynamic`、`live:<uid>`、`profile`。
	 * `notify`(必填,调用方必须表态)= 这一路撞上要不要私聊主人。
	 */
	reportRisk(path: string, options: { notify: boolean }): void;
	/**
	 * 这一路好了,或这一路不再跑了。缺省 = 真解除(最后一路这样清掉会补「风控已解除」);
	 * `notify: false` = 不再适用,不是解除,最后一路这样清掉时不补。
	 */
	resolveRisk(path: string, options?: { notify?: boolean }): void;
	/**
	 * 第三层:某项请求失败(每次失败都叫,幂等)。`notify`(必填，调用方必须表态)= 要不要私聊主人;
	 * 原样带给核心，补报时带的是存下的这一格。`message` / `recoveryMessage` 只收取字函数(出字那一刻现取,
	 * 换语言重报时再跑一遍),不收出好的字。
	 */
	reportFailure(failure: {
		externalId?: string;
		code: string;
		message: () => string;
		notify: boolean;
		/**
		 * 必填:这件事是「报一次就不再报、直到有人去修」(`true`)还是「会自己再报」(`false`)。
		 * 决定高层开着时存不存、高层清掉后冒不冒回来,见上面的说明。
		 */
		lasting: boolean;
		/** 清掉时核心补的「恢复时怎么说」;不给用核心的通用说法。存下,补报时带上。 */
		recoveryMessage?: () => string;
	}): void;
	/** 第三层清掉;`notify: false` = 不是修好了,只是不再适用(停监听、停下),不补「已恢复」。 */
	resolveFailure(
		failure: { externalId?: string; code: string },
		options?: { notify?: boolean },
	): void;
	/** 接上核心:把此刻该在表里的那一份整份报上去。 */
	attach(core: CoreProblems): void;
	/** 摘下(来源停下)。之后的上报继续记在自己手里,等下一次接上。 */
	detach(): void;
	dispose(): void;
}

export interface CreateProblemLayersOptions {
	auth: Pick<SourceAuth, "state" | "onChange">;
	logger: Logger;
	/** 语言变了就把此刻该在表里的那一份再报一遍(只在语言真变时叫,口吻变了不叫)。 */
	locale: Pick<LocaleReader, "onChange">;
}

/** 核心那头收问题的两个口(来源上下文上的那两个成员)。 */
type CoreProblems = Pick<SourceContext, "reportProblem" | "resolveProblem">;

interface Failure {
	externalId?: string;
	code: string;
	message: () => string;
	notify: boolean;
	lasting: boolean;
	recoveryMessage?: () => string;
	/** 曾经报给过核心(主人当时已经听过一遍):被压下去再冒出来时不再带私聊。 */
	reported: boolean;
	/** 已经静默冒出来过:在被清掉之前,再报也不带私聊。 */
	muted: boolean;
}

const RISK_CODE = "risk_controlled";

function failureKey(failure: { externalId?: string; code: string }): string {
	return JSON.stringify([failure.externalId ?? null, failure.code]);
}

export function createProblemLayers(options: CreateProblemLayersOptions): ProblemLayers {
	const { logger } = options;
	/** 登录掉了(`expired` / `logged-out`):压着下面两层。登录问题本身不在这里报,归宿主。 */
	let loggedOut = false;
	/** 风控层:撞着的路。 */
	const risk = new Set<string>();
	/** 风控层开着时,报给核心的那一条带不带私聊。只升不降,整层清掉(`risk` 空了)时复位。 */
	let riskNotify = false;
	/** 第三层:此刻的失败。 */
	const failures = new Map<string, Failure>();
	let core: CoreProblems | null = null;
	let disposed = false;

	/** 对核心那头做一件事;没接上就什么都不做,抛了只记 warn。 */
	function toCore(what: string, act: (to: CoreProblems) => void): void {
		if (!core) return;
		try {
			act(core);
		} catch (err) {
			logger.warn(logText("log.bilibili.problems.operationFailed"), { action: what, error: err });
		}
	}

	function reportRiskEntry(to: CoreProblems): void {
		const text = PROBLEM_TEXTS.riskControlled;
		to.reportProblem({
			code: RISK_CODE,
			message: text.text(),
			notify: riskNotify,
			recoveryMessage: text.recovery(),
		});
	}

	/** 把一条第三层的失败报给核心:静默冒出来过的不带私聊。报出去就记成「报给过核心」。 */
	function reportFailureEntry(to: CoreProblems, failure: Failure): void {
		to.reportProblem({
			...(failure.externalId === undefined ? {} : { externalId: failure.externalId }),
			code: failure.code,
			message: failure.message(),
			notify: failure.muted ? false : failure.notify,
			...(failure.recoveryMessage === undefined
				? {}
				: { recoveryMessage: failure.recoveryMessage() }),
		});
		failure.reported = true;
	}

	/** 第三层眼下在表里可见:没有更高层压着。 */
	const failuresVisible = (): boolean => !loggedOut && risk.size === 0;

	/**
	 * 高层要开了(调用时高层还没开,`wasVisible` 是调用前第三层可见不可见):表里已有的第三层静默抹掉;
	 * 一次性的(`lasting: false`)在自己手里也丢掉,`lasting` 的留着,等高层清掉再报。
	 */
	function pressDownFailures(wasVisible: boolean): void {
		for (const [key, failure] of [...failures]) {
			if (wasVisible) {
				toCore("clear-failures", (to) =>
					to.resolveProblem({
						...(failure.externalId === undefined ? {} : { externalId: failure.externalId }),
						code: failure.code,
						notify: false,
					}),
				);
			}
			if (!failure.lasting) failures.delete(key);
		}
	}

	/**
	 * 高层清掉了、第三层重新可见:手里存着的(只可能是 `lasting` 的)报上去;报给过核心的那条从此静默
	 * (这一次与之后的再报都不带私聊,直到它被清掉)。
	 */
	function revealFailures(): void {
		if (failures.size === 0) return;
		for (const failure of failures.values()) {
			if (failure.reported) failure.muted = true;
		}
		toCore("reveal-failures", (to) => {
			for (const failure of failures.values()) reportFailureEntry(to, failure);
		});
	}

	/** 风控层静默抹掉(未登录开了)。 */
	function eraseRisk(): void {
		if (risk.size === 0) return;
		risk.clear();
		riskNotify = false;
		toCore("clear-risk-silent", (to) => to.resolveProblem({ code: RISK_CODE, notify: false }));
	}

	function applyAuth(status: ReturnType<SourceAuth["state"]>["status"]): void {
		if (isLoginLost(status)) {
			if (!loggedOut) {
				const wasVisible = failuresVisible();
				eraseRisk();
				pressDownFailures(wasVisible);
			}
			loggedOut = true;
			return;
		}
		if (status === "logged-in") {
			if (!loggedOut) return;
			loggedOut = false;
			// 风控在未登录开着时存不进来,所以这时第三层重新可见
			revealFailures();
			return;
		}
		// awaiting-scan / confirming / error:保持上一次的结论
	}

	function readAuth(): void {
		if (disposed) return;
		try {
			applyAuth(options.auth.state().status);
		} catch (err) {
			logger.warn(logText("log.bilibili.problems.authReadFailed"), { error: err });
		}
	}

	/**
	 * 整份现状,只报最上面一层:`lasting` 的第三层在高层压着时手里有、表里不该有。接上时与换语言时共用;
	 * 句子都是此刻现取的。
	 */
	function reportVisible(): void {
		toCore("report-visible", (to) => {
			// 登录没好:低层都压着,登录问题本身归宿主报,这里什么都不补
			if (loggedOut) return;
			if (risk.size > 0) reportRiskEntry(to);
			else for (const failure of failures.values()) reportFailureEntry(to, failure);
		});
	}

	// 先造、后接:造出来就读一次现状、听后续变化,核心那头晚点才接上。
	readAuth();
	const authWatch = options.auth.onChange(readAuth);
	// 换语言:同一件事换个说法再报;`muted` 不复位,`notify` 照各自记着的
	const localeWatch = options.locale.onChange(() => {
		if (disposed) return;
		reportVisible();
	});

	return {
		reportRisk(path, riskOptions) {
			if (loggedOut) {
				logger.debug(logText("log.bilibili.problems.riskSuppressed"), { path });
				return;
			}
			const wasEmpty = risk.size === 0;
			risk.add(path);
			// 要私聊的一路进来了而条目还不带私聊:再报一次(带私聊);反过来不撤回
			const raised = riskOptions.notify && !riskNotify;
			if (raised) riskNotify = true;
			if (wasEmpty) pressDownFailures(true);
			if (wasEmpty || raised) toCore("report-risk", reportRiskEntry);
		},
		resolveRisk(path, resolveOptions) {
			if (!risk.delete(path)) return;
			if (risk.size > 0) return;
			riskNotify = false;
			toCore("resolve-risk", (to) =>
				to.resolveProblem({
					code: RISK_CODE,
					...(resolveOptions?.notify === false ? { notify: false } : {}),
				}),
			);
			revealFailures();
		},
		reportFailure(failure) {
			const pressed = !failuresVisible();
			if (pressed && !failure.lasting) {
				logger.debug(logText("log.bilibili.problems.failureSuppressed"), { code: failure.code });
				return;
			}
			const entry: Failure = {
				...(failure.externalId === undefined ? {} : { externalId: failure.externalId }),
				code: failure.code,
				message: failure.message,
				notify: failure.notify,
				lasting: failure.lasting,
				...(failure.recoveryMessage === undefined
					? {}
					: { recoveryMessage: failure.recoveryMessage }),
				// 同一件事再报:「报给过核心」「静默冒出来过」两个记号跟着走(压着时反复报,冒出来也只算一次;
				// 静默冒出来之后再报,不说第二遍)
				reported: failures.get(failureKey(failure))?.reported ?? false,
				muted: failures.get(failureKey(failure))?.muted ?? false,
			};
			failures.set(failureKey(entry), entry);
			// 压着的 lasting 只存不报,高层清掉那一刻再报
			if (pressed) {
				logger.debug(logText("log.bilibili.problems.failureDeferred"), { code: failure.code });
				return;
			}
			toCore("report-failure", (to) => reportFailureEntry(to, entry));
		},
		resolveFailure(failure, resolveOptions) {
			if (!failures.delete(failureKey(failure))) return;
			// 压着的那条从没报上去过,删了就不用对核心说什么
			if (!failuresVisible()) return;
			toCore("resolve-failure", (to) =>
				to.resolveProblem({
					...(failure.externalId === undefined ? {} : { externalId: failure.externalId }),
					code: failure.code,
					...(resolveOptions?.notify === false ? { notify: false } : {}),
				}),
			);
		},
		attach(next) {
			core = next;
			// 接上的是一张清过的表(来源停下时核心把它名下的整份清了):手里的都是新的一条,照各自的 `notify`
			for (const failure of failures.values()) failure.muted = false;
			reportVisible();
		},
		detach() {
			core = null;
		},
		dispose() {
			disposed = true;
			core = null;
			authWatch.dispose();
			localeWatch.dispose();
		},
	};
}
