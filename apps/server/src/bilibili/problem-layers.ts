import type { Logger, SourceAuth, SourceContext } from "@bilibili-notify/internal";
import { errorMessageOf } from "../util/error-message.js";
import { PROBLEM_TEXTS } from "./problem-texts.js";

/**
 * B 站的报错按因果分三层,问题表里同时只留最上面一层(动态与直播共用一个上报器):
 *
 * 1. **未登录**(`auth_lost`,来源级):只看 `AuthState.status` ——
 *    `expired` 开并带私聊;`logged-out`(从没登录过、主动退出)开、不私聊;`logged-in` 清;
 *    `awaiting-scan` / `confirming` / `error` 三种不动,保持上一次的结论(已登录时重扫不许误开,
 *    未登录时扫码途中不许误清)。
 * 2. **风控**(`risk_controlled`,来源级、带私聊):任一路撞了就开,所有撞着的路都清了才清。
 *    一路的清由调用方按「这一路这一次的结果不是风控拦截」来叫。
 * 3. **某项请求失败**(code 与带不带私聊都由调用方给):每次失败都叫(幂等),调用方自己的成功或不再适用时清。
 *
 * 高层一开,表里已有的低层静默抹掉(`notify: false`,不补「已恢复」)。第三层按 `lasting` 分两种:
 * - `lasting: false`(会自己再报的,如拉动态失败):高层开起来时在自己手里清空,高层开着时的上报只记日志、
 *   不存;高层清掉后它不会自己冒回来,要等调用方下一次失败再报。
 * - `lasting: true`(报一次就不再报、直到有人去修的,如某个直播间停止监听):高层开着时**存下但不报**,
 *   高层开起来时也不清空;高层清掉的那一刻把存着的报上去(照各自的 `notify`)。它的主人调 `resolveFailure`
 *   时照常删 —— 压着的时候被删了,高层清掉也不再报。
 *
 * 手里存的是「此刻该在表里的东西」,不是事件流水。核心那头(`attach` 交进来的上下文)是后接上的:接上那一刻把
 * 这份现状整份报上去,所以接上之前记着的不会丢;`detach`(来源停下)之后再报继续记在自己手里,等下一次接上。
 * 这样 `since` 是接上那一刻,接上之前开了又清掉的不会出现。
 *
 * 每个方法都不许往外抛:调用点都在引擎的关键控制流上,核心那头抛了只记一行 warn。
 */
export interface ProblemLayers {
	/** 风控:这一路撞了(每次撞都叫,幂等)。路的键:`dynamic`、`live:<uid>`。 */
	reportRisk(path: string): void;
	/** 这一路好了,或这一路不再跑了。 */
	resolveRisk(path: string): void;
	/**
	 * 第三层:某项请求失败(每次失败都叫,幂等)。`notify`(必填，调用方必须表态)= 要不要私聊主人;
	 * 原样带给核心，补报时带的是存下的这一格。
	 */
	reportFailure(failure: {
		externalId?: string;
		code: string;
		message: string;
		notify: boolean;
		/**
		 * 必填:这件事是「报一次就不再报、直到有人去修」(`true`)还是「会自己再报」(`false`)。
		 * 决定高层开着时存不存、高层清掉后冒不冒回来,见上面的说明。
		 */
		lasting: boolean;
		/** 清掉时核心补的「恢复时怎么说」;不给用核心的通用说法。存下,补报时带上。 */
		recoveryMessage?: string;
	}): void;
	/** 第三层清掉;`notify: false` = 不是修好了,只是不再适用(停监听、停下),不补「已恢复」。 */
	resolveFailure(
		failure: { externalId?: string; code: string },
		options?: { notify?: boolean },
	): void;
	/** 接上核心:把此刻该在表里的那一份整份报上去。 */
	attach(sink: Pick<SourceContext, "reportProblem" | "resolveProblem">): void;
	/** 摘下(来源停下)。之后的上报继续记在自己手里,等下一次接上。 */
	detach(): void;
	dispose(): void;
}

export interface CreateProblemLayersOptions {
	auth: Pick<SourceAuth, "state" | "onChange">;
	logger: Logger;
}

type Sink = Pick<SourceContext, "reportProblem" | "resolveProblem">;

interface Failure {
	externalId?: string;
	code: string;
	message: string;
	notify: boolean;
	lasting: boolean;
	recoveryMessage?: string;
}

const LOGIN_CODE = "auth_lost";
const RISK_CODE = "risk_controlled";

function failureKey(failure: { externalId?: string; code: string }): string {
	return JSON.stringify([failure.externalId ?? null, failure.code]);
}

export function createProblemLayers(options: CreateProblemLayersOptions): ProblemLayers {
	const { logger } = options;
	/** 未登录层:开着时带不带私聊;没开是 `null`。 */
	let login: { notify: boolean } | null = null;
	/** 风控层:撞着的路。 */
	const risk = new Set<string>();
	/** 第三层:此刻的失败。 */
	const failures = new Map<string, Failure>();
	let sink: Sink | null = null;
	let disposed = false;

	/** 对核心那头做一件事;没接上就什么都不做,抛了只记 warn。 */
	function toSink(what: string, act: (to: Sink) => void): void {
		if (!sink) return;
		try {
			act(sink);
		} catch (err) {
			logger.warn(`[problem-layers] ${what}失败(已忽略): ${errorMessageOf(err)}`);
		}
	}

	function reportLogin(to: Sink, state: { notify: boolean }): void {
		const text = state.notify ? PROBLEM_TEXTS.loginExpired : PROBLEM_TEXTS.loginMissing;
		to.reportProblem({
			code: LOGIN_CODE,
			message: text.text,
			notify: text.notify,
			// 只进表的那一句没有「恢复时怎么说」(不会被用到)
			...("recovery" in text ? { recoveryMessage: text.recovery } : {}),
		});
	}

	function reportRiskEntry(to: Sink): void {
		const text = PROBLEM_TEXTS.riskControlled;
		to.reportProblem({
			code: RISK_CODE,
			message: text.text,
			notify: text.notify,
			recoveryMessage: text.recovery,
		});
	}

	function reportFailureEntry(to: Sink, failure: Failure): void {
		to.reportProblem({
			...(failure.externalId === undefined ? {} : { externalId: failure.externalId }),
			code: failure.code,
			message: failure.message,
			notify: failure.notify,
			...(failure.recoveryMessage === undefined
				? {}
				: { recoveryMessage: failure.recoveryMessage }),
		});
	}

	/** 第三层眼下在表里可见:没有更高层压着。 */
	const failuresVisible = (): boolean => login === null && risk.size === 0;

	/**
	 * 高层要开了(调用时高层还没开,`wasVisible` 是调用前第三层可见不可见):表里已有的第三层静默抹掉;
	 * 一次性的(`lasting: false`)在自己手里也丢掉,`lasting` 的留着,等高层清掉再报。
	 */
	function pressDownFailures(wasVisible: boolean): void {
		for (const [key, failure] of [...failures]) {
			if (wasVisible) {
				toSink("抹掉请求失败", (to) =>
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

	/** 高层清掉了、第三层重新可见:手里存着的(只可能是 `lasting` 的)报上去。 */
	function revealFailures(): void {
		if (failures.size === 0) return;
		toSink("补报压着的请求失败", (to) => {
			for (const failure of failures.values()) reportFailureEntry(to, failure);
		});
	}

	/** 风控层静默抹掉(未登录开了)。 */
	function eraseRisk(): void {
		if (risk.size === 0) return;
		risk.clear();
		toSink("抹掉风控", (to) => to.resolveProblem({ code: RISK_CODE, notify: false }));
	}

	function applyAuth(status: ReturnType<SourceAuth["state"]>["status"]): void {
		switch (status) {
			case "expired":
			case "logged-out": {
				const next = { notify: status === "expired" };
				const prev = login;
				if (prev === null) {
					const wasVisible = failuresVisible();
					eraseRisk();
					pressDownFailures(wasVisible);
				}
				login = next;
				if (prev === null || prev.notify !== next.notify) {
					toSink("报未登录", (to) => reportLogin(to, next));
				}
				return;
			}
			case "logged-in":
				if (login === null) return;
				login = null;
				toSink("清未登录", (to) => to.resolveProblem({ code: LOGIN_CODE }));
				// 风控在未登录开着时存不进来,所以这时第三层重新可见
				revealFailures();
				return;
			default:
				// awaiting-scan / confirming / error:保持上一次的结论
				return;
		}
	}

	function readAuth(): void {
		if (disposed) return;
		try {
			applyAuth(options.auth.state().status);
		} catch (err) {
			logger.warn(`[problem-layers] 读登录状态失败(已忽略): ${errorMessageOf(err)}`);
		}
	}

	// 先造、后接:造出来就读一次现状、听后续变化,核心那头晚点才接上。
	readAuth();
	const authWatch = options.auth.onChange(readAuth);

	return {
		reportRisk(path) {
			if (login !== null) {
				logger.debug(`[problem-layers] 登录没好,风控(${path})不另记`);
				return;
			}
			const wasEmpty = risk.size === 0;
			risk.add(path);
			if (!wasEmpty) return;
			pressDownFailures(true);
			toSink("报风控", reportRiskEntry);
		},
		resolveRisk(path) {
			if (!risk.delete(path)) return;
			if (risk.size > 0) return;
			toSink("清风控", (to) => to.resolveProblem({ code: RISK_CODE }));
			revealFailures();
		},
		reportFailure(failure) {
			const pressed = !failuresVisible();
			if (pressed && !failure.lasting) {
				logger.debug(`[problem-layers] 更上一层的问题开着,${failure.code} 不另记`);
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
			};
			failures.set(failureKey(entry), entry);
			// 压着的 lasting 只存不报,高层清掉那一刻再报
			if (pressed) {
				logger.debug(`[problem-layers] 更上一层的问题开着,${failure.code} 先记着,等它清掉再报`);
				return;
			}
			toSink("报请求失败", (to) => reportFailureEntry(to, entry));
		},
		resolveFailure(failure, resolveOptions) {
			if (!failures.delete(failureKey(failure))) return;
			// 压着的那条从没报上去过,删了就不用对核心说什么
			if (!failuresVisible()) return;
			toSink("清请求失败", (to) =>
				to.resolveProblem({
					...(failure.externalId === undefined ? {} : { externalId: failure.externalId }),
					code: failure.code,
					...(resolveOptions?.notify === false ? { notify: false } : {}),
				}),
			);
		},
		attach(next) {
			sink = next;
			// 整份现状,只报最上面一层:`lasting` 的第三层在高层压着时手里有、表里不该有。
			toSink("补报", (to) => {
				if (login !== null) reportLogin(to, login);
				else if (risk.size > 0) reportRiskEntry(to);
				else for (const failure of failures.values()) reportFailureEntry(to, failure);
			});
		},
		detach() {
			sink = null;
		},
		dispose() {
			disposed = true;
			sink = null;
			authWatch.dispose();
		},
	};
}
