import { t as serverText } from "../i18n/index.js";
import {
	builtinCommandAliases,
	displayedBuiltinCommandAliases,
} from "./builtin-command-aliases.js";
/**
 * `/report` —— 手动催一份周报。
 *
 * 五条指令里**唯一会花钱**的一条:每跑一次都是一次真实的 AI 调用,几十秒起。于是
 * 两件事必须做对,而且它们是同一件事的两面:
 *
 * - **立刻 ack**(Slack 的 3 秒规则)。不吭声主人会以为没收到,再敲一次。
 * - **跑着时不跑第二次**。ack 只是止住手,真正挡住重复调用的是这道闸。
 *
 * 闸在**失败路径上也必须松开**:一次异常锁死它的话,主人得重启服务才能再要一份周报,
 * 而他绝不会想到是这个原因。
 *
 * 面板上的「试一次」是另一条路,不共用这道闸 —— 那边点下去有自己的按钮态反馈。
 */

import {
	type FailureCode,
	fail,
	type Logger,
	ok,
	ROAST_MAX_DAYS,
	ROAST_MIN_DAYS,
} from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";
import { errorMessageOf } from "../util/error-message.js";
import { type CommandDef, command } from "./command-dispatcher.js";

/** 与 `RoastRunResult` 同形。这里重述一遍是为了不把指令层绑死在调度器的类型上。 */
export type ReportResult =
	| { kind: "no-targets" }
	| { kind: "gen-failed"; code: FailureCode; message: string }
	| { kind: "pending-approval"; draftId: string }
	| {
			kind: "sent";
			mode: "text" | "image";
			sent: number;
			failed: Array<{ targetId: string; message: string }>;
	  };

export interface ReportCommandOptions {
	/** 跑一轮榜单周报。`days` 不传 = 用配置里的天数。 */
	run: (days?: number) => Promise<ReportResult>;
	logger: Logger;
}

/**
 * 把结果说成人话。`null` = 什么都别说。只管办成了的两种:办不成(没目标、生成失败)
 * 在 `run` 里直接转成 `fail()`,由分发器统一说。
 *
 * `pending-approval` 返回 null 是刻意的:调度器已经把草稿连同「回复 y <id>」私聊过去
 * 了,这里再补一句就是同一件事说两遍,而两份措辞迟早跑偏。
 */
function describeSent(outcome: Extract<ReportResult, { kind: "pending-approval" | "sent" }>) {
	switch (outcome.kind) {
		case "pending-approval":
			return null;
		case "sent":
			return outcome.failed.length === 0
				? serverText("service.runtime.report-command.text.1", { value0: outcome.sent })
				: serverText("service.runtime.report-command.text.2", {
						value0: outcome.sent,
						count: outcome.failed.length,
					});
	}
}

export function createReportCommand(opts: ReportCommandOptions): CommandDef {
	// 这道闸就是「别再跑一次」本身。指令是串行喂进来的(dispatcher 一条条处理),
	// 所以一个布尔量够用,不需要锁。
	let running = false;

	return command({
		name: "report",
		get parameterLabels() {
			return { days: serverText("service.runtime.report-command.text.3") };
		},
		aliases: builtinCommandAliases("report"),
		get displayAliases() {
			return displayedBuiltinCommandAliases("report");
		},
		signature: "[days:number]",
		get description() {
			return serverText("service.runtime.report-command.text.4");
		},
		example: "7",
		get details() {
			return serverText("service.runtime.report-command.text.5");
		},
		run: async (values, { reply }) => {
			// 范围是这条指令自己的业务规则,parser 只管格式 —— 它要是替各指令管范围,
			// 就得为每条指令在那儿开一个口子。挡在调 AI 之前,越界不该花钱。
			const days = values.days;
			if (days !== undefined && (days < ROAST_MIN_DAYS || days > ROAST_MAX_DAYS)) {
				// 光说「不行」等于让主人自己去猜,把区间说出来。
				return fail(
					"invalid",
					t("command.report.daysOutOfRange", { min: ROAST_MIN_DAYS, max: ROAST_MAX_DAYS }),
				);
			}
			if (running) return fail("conflict", t("command.report.busy"));
			running = true;
			try {
				// ack 在跑生成之前发出去:主人先看到「收到了」,再等结果。它必须在
				// try **里面** —— reply 本身也可能 reject(适配器瞬断),写在外面的话
				// finally 不执行,running 卡死 true,此后每次 /report 都被挡到重启为止。
				await reply(serverText("service.runtime.report-command.text.6"));
				const outcome = await opts.run(days);
				if (outcome.kind === "no-targets") {
					return fail("not_configured", t("command.report.noTargets"));
				}
				if (outcome.kind === "gen-failed") return fail(outcome.code, outcome.message);
				const text = describeSent(outcome);
				if (text) await reply(text);
				return ok();
			} catch (err) {
				// 这里接住而不是往外抛:要把原因交给主人(抛出去只剩「出错了,详情在日志里」),
				// 闸也靠下面的 finally 松开。
				const why = errorMessageOf(err);
				opts.logger.warn(`[command] 周报跑失败: ${why}`);
				return fail("unavailable", why);
			} finally {
				// finally 不能省 —— 见文件头那条「异常锁死」。
				running = false;
			}
		},
	});
}
