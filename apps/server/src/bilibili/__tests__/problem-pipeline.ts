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
import { createProblemNotifier } from "../../problems/problem-notifier.js";
import { createProblemTable } from "../../problems/problem-table.js";
import { createProblemLayers } from "../problem-layers.js";

export const PIPELINE_REPORTER = "bilibili";

export function makeQuietLogger(): Logger {
	return { debug() {}, info() {}, warn() {}, error() {} };
}

export function makeProblemPipeline(
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
	const layers = createProblemLayers({ auth, logger });
	const ctx: Pick<SourceContext, "reportProblem" | "resolveProblem"> = {
		reportProblem: (problem) =>
			table.report({
				reporter: PIPELINE_REPORTER,
				code: problem.code,
				message: problem.message,
				...(problem.notify === undefined ? {} : { notify: problem.notify }),
				...(problem.recoveryMessage === undefined
					? {}
					: { recoveryMessage: problem.recoveryMessage }),
			}),
		resolveProblem: (problem) =>
			table.resolve(
				{ reporter: PIPELINE_REPORTER, code: problem.code },
				problem.notify === undefined ? undefined : { notify: problem.notify },
			),
	};
	layers.attach(ctx);
	return { table, notifyMaster, layers, logger };
}
