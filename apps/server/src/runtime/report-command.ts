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

import { type Logger, ROAST_MAX_DAYS, ROAST_MIN_DAYS } from "@bilibili-notify/internal";
import { type CommandSpec, command } from "./command-dispatcher.js";

/** 与 `RoastRunOutcome` 同形。这里重述一遍是为了不把指令层绑死在调度器的类型上。 */
export type ReportOutcome =
	| { kind: "no-targets" }
	| { kind: "gen-failed"; why: string }
	| { kind: "pending-approval"; draftId: string }
	| {
			kind: "sent";
			mode: "text" | "image";
			sent: number;
			failed: Array<{ targetId: string; err: string }>;
	  };

export interface ReportCommandOptions {
	/** 跑一轮榜单周报。`days` 不传 = 用配置里的天数。 */
	run: (days?: number) => Promise<ReportOutcome>;
	reply: (text: string) => Promise<void>;
	logger: Logger;
}

/**
 * 把结果说成人话。`null` = 什么都别说。
 *
 * `pending-approval` 返回 null 是刻意的:调度器已经把草稿连同「回复 y <id>」私聊过去
 * 了,这里再补一句就是同一件事说两遍,而两份措辞迟早跑偏。
 */
function describeOutcome(outcome: ReportOutcome): string | null {
	switch (outcome.kind) {
		case "no-targets":
			return "还没配推送目标呢，周报没地方发～";
		case "gen-failed":
			return `周报没生成出来：${outcome.why}`;
		case "pending-approval":
			return null;
		case "sent":
			return outcome.failed.length === 0
				? `周报发出去了，${outcome.sent} 个目标都成了～`
				: `周报发出去了：${outcome.sent} 个成功，${outcome.failed.length} 个失败。`;
	}
}

export function createReportCommand(opts: ReportCommandOptions): CommandSpec {
	// 这道闸就是「别再跑一次」本身。指令是串行喂进来的(dispatcher 一条条处理),
	// 所以一个布尔量够用,不需要锁。
	let running = false;

	return command({
		name: "report",
		aliases: ["周报"],
		signature: "[days:number|天数]",
		description: "现在就要一份周报",
		example: "7",
		details: "要跑几十秒。生成期间再敲不会重复生成，也不会重复花钱。",
		run: async (values) => {
			// 范围是这条指令自己的业务规则,parser 只管格式 —— 它要是替各指令管范围,
			// 就得为每条指令在那儿开一个口子。挡在调 AI 之前,越界不该花钱。
			const days = values.days;
			if (days !== undefined && (days < ROAST_MIN_DAYS || days > ROAST_MAX_DAYS)) {
				// 光说「不行」等于让主人自己去猜,把区间说出来。
				await opts.reply(`天数要在 ${ROAST_MIN_DAYS} 到 ${ROAST_MAX_DAYS} 之间哦～`);
				return;
			}
			if (running) {
				await opts.reply("还在跑呢，稍等一下下～");
				return;
			}
			running = true;
			try {
				// ack 在跑生成之前发出去:主人先看到「收到了」,再等结果。它必须在
				// try **里面** —— reply 本身也可能 reject(适配器瞬断),写在外面的话
				// finally 不执行,running 卡死 true,此后每次 /report 都被挡到重启为止。
				await opts.reply("好的，在生成了，稍等～");
				const outcome = await opts.run(days);
				const text = describeOutcome(outcome);
				if (text) await opts.reply(text);
			} catch (err) {
				const why = err instanceof Error ? err.message : String(err);
				opts.logger.warn(`[command] 周报跑失败: ${why}`);
				await opts.reply(`周报没成：${why}`);
			} finally {
				// finally 不能省 —— 见文件头那条「异常锁死」。
				running = false;
			}
		},
	});
}
