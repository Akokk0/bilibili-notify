/**
 * 测试用的「真问题通路」:真问题表 + 真问题通知器 + 真分层上报器,核心那头的上下文直接落到表上
 * (来源上下文的订阅展开不在这里:只报来源级问题时用它;订阅级的用 `source` 那条装配)。
 * 假件只有 `notifyMaster`(记下每次调用)与计时器(只记、不自己走)。
 */

import {
	type DeliveryResult,
	type Logger,
	ok,
	type SourceAuth,
	type SourceContext,
} from "@bilibili-notify/internal";
import { vi } from "vite-plus/test";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { createProblemNotifier } from "../../problems/problem-notifier.js";
import { createProblemTable } from "../../problems/problem-table.js";
import { watchLoginProblems } from "../../subscriptions/login-problems.js";
import { createProblemLayers } from "../problem-layers.js";

const HARNESS_REPORTER = "bilibili";
const HARNESS_LABEL = "B 站";

/** 宿主看登录状态报的三句(宿主写的整句,私聊时不加引子);来源键 `bilibili`、来源名「B 站」。 */
export const LOGIN_EXPIRED_TEXT =
	"主人，B 站的登录失效了，那边订阅的内容先收不到了。到面板的账号页重新扫码登录就好，私聊发「login bilibili」也行。";
export const LOGIN_MISSING_TEXT =
	"主人还没有登录B 站的账号，那边订阅的内容暂时收不到。到面板的账号页扫码登录就好，私聊发「login bilibili」也行。";
export const LOGIN_RECOVERED_TEXT = "主人，好消息：B 站的登录已经恢复啦。";

function makeQuietLogger(): Logger {
	return { debug() {}, info() {}, warn() {}, error() {} };
}

export function makeProblemHarness(
	auth: Pick<SourceAuth, "state" | "onChange">,
	notifyImpl?: (text: string) => Promise<DeliveryResult>,
) {
	const logger = makeQuietLogger();
	const table = createProblemTable({ logger });
	const notifyMaster = vi.fn<(text: string) => Promise<DeliveryResult>>(
		notifyImpl ?? (async () => ok({ latencyMs: 1 })),
	);
	createProblemNotifier({
		table,
		notify: notifyMaster,
		serviceCtx: {
			track: () => {},
			setTimeout: (fn, ms) => {
				const timer = setTimeout(fn, ms);
				return { dispose: () => clearTimeout(timer) };
			},
		},
		logger,
	});
	// 登录问题归宿主:造法同真接线(`registerBuiltinSource`)—— 读现状 + 订 `onChange`,宿主写的整句,不盖写者
	watchLoginProblems({
		auth,
		sourceKey: HARNESS_REPORTER,
		label: HARNESS_LABEL,
		problems: table,
		logger,
	});
	const layers = createProblemLayers({ locale: fixedLocale(), auth, logger });
	const ctx: Pick<SourceContext, "reportProblem" | "resolveProblem"> = {
		reportProblem: (problem) =>
			table.report({
				reporter: HARNESS_REPORTER,
				code: problem.code,
				message: problem.message,
				...(problem.notify === undefined ? {} : { notify: problem.notify }),
				...(problem.recoveryMessage === undefined
					? {}
					: { recoveryMessage: problem.recoveryMessage }),
			}),
		resolveProblem: (problem) =>
			table.resolve(
				{ reporter: HARNESS_REPORTER, code: problem.code },
				problem.notify === undefined ? undefined : { notify: problem.notify },
			),
	};
	layers.attach(ctx);
	return { table, notifyMaster, layers, logger };
}
