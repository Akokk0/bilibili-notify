import type { Disposable, Logger, SourceAuth } from "@bilibili-notify/internal";
import { logText, t } from "../i18n/index.js";
import type { ProblemTable } from "../problems/problem-table.js";

/** 登录问题的 code:记在来源键名下,面板按它认。 */
const LOGIN_CODE = "auth_lost";

export interface WatchLoginProblemsOptions {
	/** 来源的登录口。 */
	auth: Pick<SourceAuth, "state" | "onChange">;
	/** 来源键:问题记在它名下,指路的话里也用它(登录指令按键挑来源)。 */
	sourceKey: string;
	/** 给人看的当前来源名；取字时读描述符，不冻结登记时的语言。 */
	label: () => string;
	problems: Pick<ProblemTable, "report" | "resolve">;
	logger: Logger;
}

/**
 * 宿主看一个来源的登录状态,报与清「登录有问题」这一条问题(集成不用自己报登录):
 *
 * - `expired`:进表并私聊(运行中掉了,或开机发现存着的登录已失效);
 * - `logged-out`(从没登录过、主动退出):只进表,不私聊;`expired` 与 `logged-out` 互换时再报一次,换文案与私聊;
 * - `logged-in`:清(当初真私聊过的,通知器补「已恢复」);
 * - `awaiting-scan` / `confirming` / `error`:不动,保持上一次的结论(已登录时重扫不许误开,未登录时扫码途中不许误清)。
 *
 * 这是宿主自己写的整句(带指路),所以不盖「谁写的」,私聊时不加引子。造出来先读一次现状、再订后续变化;
 * 交回的把手摘订阅,已报的问题不在这里清(来源停下时由宿主整批清掉)。读状态或写表抛了只记 warn,不往外抛。
 */
export function watchLoginProblems(options: WatchLoginProblemsOptions): Disposable {
	const { auth, sourceKey, label, problems, logger } = options;
	/** 此刻表里这一条是哪一种;没开是 `null`。 */
	let current: "expired" | "logged-out" | null = null;
	let disposed = false;

	function apply(status: ReturnType<SourceAuth["state"]>["status"]): void {
		switch (status) {
			case "expired":
			case "logged-out": {
				if (current === status) return;
				current = status;
				problems.report(
					status === "expired"
						? {
								reporter: sourceKey,
								code: LOGIN_CODE,
								message: () => t("problem.login.expired", { name: label(), sourceKey }),
								notify: true,
								recoveryMessage: () => t("problem.login.recovered", { name: label() }),
							}
						: {
								reporter: sourceKey,
								code: LOGIN_CODE,
								message: () => t("problem.login.missing", { name: label(), sourceKey }),
								notify: false,
							},
				);
				return;
			}
			case "logged-in":
				if (current === null) return;
				current = null;
				problems.resolve({ reporter: sourceKey, code: LOGIN_CODE });
				return;
			default:
				// awaiting-scan / confirming / error:保持上一次的结论
				return;
		}
	}

	function read(): void {
		if (disposed) return;
		try {
			apply(auth.state().status);
		} catch (err) {
			logger.warn(
				logText("log.source.loginStateFailed"),
				{ event: "source.login_state_failed", sourceKey },
				err,
			);
		}
	}

	read();
	const subscription = auth.onChange(read);
	return {
		dispose() {
			disposed = true;
			subscription.dispose();
		},
	};
}
