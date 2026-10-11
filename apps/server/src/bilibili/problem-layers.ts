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
 * 高层一开,低层在自己手里清空、并在表里静默抹掉(`notify: false`,不补「已恢复」);高层开着时低层的上报只记日志、
 * 不存;高层清掉后低层不会自己冒回来,要等调用方下一次失败再报。
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
		to.reportProblem({
			code: LOGIN_CODE,
			message: state.notify ? PROBLEM_TEXTS.loginExpired : PROBLEM_TEXTS.loginMissing,
			notify: state.notify,
		});
	}

	function reportRiskEntry(to: Sink): void {
		to.reportProblem({ code: RISK_CODE, message: PROBLEM_TEXTS.riskControlled, notify: true });
	}

	function reportFailureEntry(to: Sink, failure: Failure): void {
		to.reportProblem({
			...(failure.externalId === undefined ? {} : { externalId: failure.externalId }),
			code: failure.code,
			message: failure.message,
			notify: failure.notify,
		});
	}

	/** 第三层整个静默抹掉(高层开了)。 */
	function eraseFailures(): void {
		for (const failure of failures.values()) {
			toSink("抹掉请求失败", (to) =>
				to.resolveProblem({
					...(failure.externalId === undefined ? {} : { externalId: failure.externalId }),
					code: failure.code,
					notify: false,
				}),
			);
		}
		failures.clear();
	}

	/** 风控层与第三层都静默抹掉(未登录开了)。 */
	function eraseBelowLogin(): void {
		if (risk.size > 0) {
			risk.clear();
			toSink("抹掉风控", (to) => to.resolveProblem({ code: RISK_CODE, notify: false }));
		}
		eraseFailures();
	}

	function applyAuth(status: ReturnType<SourceAuth["state"]>["status"]): void {
		switch (status) {
			case "expired":
			case "logged-out": {
				const next = { notify: status === "expired" };
				const prev = login;
				login = next;
				if (prev === null) eraseBelowLogin();
				if (prev === null || prev.notify !== next.notify) {
					toSink("报未登录", (to) => reportLogin(to, next));
				}
				return;
			}
			case "logged-in":
				if (login === null) return;
				login = null;
				toSink("清未登录", (to) => to.resolveProblem({ code: LOGIN_CODE }));
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
			eraseFailures();
			toSink("报风控", reportRiskEntry);
		},
		resolveRisk(path) {
			if (!risk.delete(path)) return;
			if (risk.size === 0) toSink("清风控", (to) => to.resolveProblem({ code: RISK_CODE }));
		},
		reportFailure(failure) {
			if (login !== null || risk.size > 0) {
				logger.debug(`[problem-layers] 更上一层的问题开着,${failure.code} 不另记`);
				return;
			}
			const entry: Failure = {
				...(failure.externalId === undefined ? {} : { externalId: failure.externalId }),
				code: failure.code,
				message: failure.message,
				notify: failure.notify,
			};
			failures.set(failureKey(entry), entry);
			toSink("报请求失败", (to) => reportFailureEntry(to, entry));
		},
		resolveFailure(failure, resolveOptions) {
			if (!failures.delete(failureKey(failure))) return;
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
			// 整份现状。高层开着时低层在自己手里是空的(开的时候清空、开着时不存),所以这里报出去的
			// 恰好就是最上面那一层。
			toSink("补报", (to) => {
				if (login !== null) reportLogin(to, login);
				if (risk.size > 0) reportRiskEntry(to);
				for (const failure of failures.values()) reportFailureEntry(to, failure);
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
