/**
 * 定时锐评调度器 —— 两条线:全局一条榜单周报,每位 UP 各一条单人锐评。
 *
 * 与手动推送最大的差别是**没人在场**。手动推送失败了主人当场就看见了;定时这条路
 * 上,生成不出来、群把机器人踢了、审批没人理,全都发生在没人看着的时候。所以每条
 * 不顺的路都得有个交代 —— 要么私聊说清原因,要么至少落一条日志,绝不能只是安静地
 * 什么都没发生(主人只会以为这周的周报又没来)。
 *
 * 周期与数据范围是解耦的两个配置:`cron` 定何时发,`days` 定统计多少天。不预设
 * 周报 / 月报 / 季报这类组合。
 */

import {
	isTargetPaused,
	type Logger,
	type NotificationPayload,
	type RoastSchedule,
} from "@bilibili-notify/internal";
import { CronJob } from "cron";
import {
	type BoardLike,
	buildRoastPayload,
	deliverRoast,
	type RoastDeliverDeps,
	type SoloLike,
} from "../stats/roast-deliver.js";
import {
	generateBoardRoast,
	generateSoloRoast,
	type OverviewFetcher,
	type RoastGenDeps,
	roastGenErrorText,
} from "../stats/roast-generate.js";
import type { RoastDraftStore } from "./roast-draft-store.js";

export interface CreateRoastSchedulerOptions {
	deps: RoastGenDeps & RoastDeliverDeps;
	drafts: RoastDraftStore;
	logger: Logger;
	fetchOverview: OverviewFetcher;
	/**
	 * 私聊主人。**失败只该被吞掉** —— 通知是锦上添花,发不出去不能把这一轮的
	 * 生成结果或后续步骤一起带走(动态引擎那边刚为同一个道理修过一处)。
	 */
	tellMaster: (text: string) => Promise<void>;
	/**
	 * 私聊主人一条**完整消息**(可能带图)。审批预览走它 —— 要主人过目的东西必须
	 * 是将来真发出去的那一份,只私聊一段文字、群里却收到一张信息更多的卡片,那个
	 * 「过目」就是假的。同样,发不出去只该被吞掉。
	 */
	tellMasterPayload: (payload: NotificationPayload) => Promise<void>;
}

/**
 * 一轮跑完的结论。
 *
 * cron 那条路**不看**它(到点自动跑,结论落日志与私聊就够了),它是给面板上的
 * 「试一次」按钮用的 —— 点了之后总得回答「成了没、发给了谁、还是在等我批」,
 * 而落进日志的结论对着浏览器的人是看不见的。
 */
export type RoastRunOutcome =
	/** 一个推送目标都没配,连模型都没调。 */
	| { kind: "no-targets" }
	/** 生成这一步就没过去(AI 没开、数据不够、模型报错…)。 */
	| { kind: "gen-failed"; why: string }
	/** 审批开着:已经生成并私聊给主人了,群里还没发。 */
	| { kind: "pending-approval"; draftId: string }
	/** 发了。`failed` 非空表示部分目标没成 —— 那也算发过了,不是整轮失败。 */
	| {
			kind: "sent";
			mode: "text" | "image";
			sent: number;
			/** 因停用而跳过的目标 —— 不算失败,面板上单独说一句。 */
			skipped: string[];
			failed: Array<{ targetId: string; err: string }>;
	  };

export interface RoastScheduler {
	start(): void;
	stop(): void;
	/** 重读配置,增删改各条 job。config-changed / subscription-changed 后调。 */
	reconcile(): void;
	/**
	 * 立刻跑一次榜单周报。cron 到点调它,面板的「试一次」和测试也直接调它。
	 *
	 * `days` 只覆盖统计天数(私聊里 `/report 14` 用),其余照配置走;不传 = 全按配置。
	 */
	runBoardOnce(days?: number): Promise<RoastRunOutcome>;
	/** 立刻跑一次某位 UP 的单人锐评。 */
	runSoloOnce(uid: string): Promise<RoastRunOutcome>;
	/**
	 * 把一份**已经获批**的草稿发出去。审批指令链路调它。
	 *
	 * 目标取草稿里那份快照而不是重读配置 —— 主人点头的是「这份内容发给这些人」。
	 */
	deliverApproved(draft: {
		kind: "board" | "solo";
		uid?: string;
		days: number;
		targets: string[];
		result: unknown;
	}): Promise<void>;
}

/** 调度器自己的时区 = 服务器本地。它没有浏览器可问,统计窗口按本地日边界对齐。 */
function localTz(): number {
	return new Date().getTimezoneOffset();
}

export function createRoastScheduler(opts: CreateRoastSchedulerOptions): RoastScheduler {
	const { deps, drafts, logger, fetchOverview } = opts;
	/** 榜单那条。key 恒为 BOARD_KEY,与 per-UP 的 subId 同居一张表便于统一 reconcile。 */
	const BOARD_KEY = "@board";
	const jobs = new Map<string, { cron: string; job: CronJob }>();
	let stopped = false;

	/** 通知主人,发不出去只记一句 —— 见 tellMaster 的说明。 */
	async function tell(text: string): Promise<void> {
		try {
			await opts.tellMaster(text);
		} catch (err) {
			logger.warn(
				`[roast-sched] 通知主人失败: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/** 同上,但发的是完整消息(审批预览)。 */
	async function tellPayload(payload: NotificationPayload): Promise<void> {
		try {
			await opts.tellMasterPayload(payload);
		} catch (err) {
			logger.warn(
				`[roast-sched] 私聊审批预览失败: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * 一条流水线跑一趟。
	 *
	 * `label` 只进日志与私聊,用来区分是榜单还是哪位 UP —— 主人收到「这周没发」时
	 * 得知道说的是哪一条。
	 */
	async function runOnce(
		kind: "board" | "solo",
		cfg: RoastSchedule,
		label: string,
		uid?: string,
	): Promise<RoastRunOutcome> {
		if (stopped) return { kind: "gen-failed", why: "调度器已停止" };

		// 一个目标都没配、或配的全都停用了 —— 先拦住,别白调一次模型再把结果扔掉。
		// 两句话分开说:「没配」和「都停用了」对主人是两件事,后者他明明配过。
		if (cfg.targets.length === 0) {
			logger.warn(`[roast-sched] ${label}:没有配置推送目标,跳过`);
			if (cfg.notifyOnError) await tell(`${label}没有发出去：还没有配置推送目标。`);
			return { kind: "no-targets" };
		}
		if (allTargetsPaused(cfg.targets)) {
			logger.warn(`[roast-sched] ${label}:配置的推送目标都已停用,跳过`);
			if (cfg.notifyOnError) await tell(`${label}没有发出去：配置的推送目标都已停用。`);
			return { kind: "no-targets" };
		}

		const gen =
			kind === "board"
				? await generateBoardRoast(deps, { days: cfg.days, tz: localTz(), fetchOverview })
				: await generateSoloRoast(deps, {
						uid: uid ?? "",
						days: cfg.days,
						tz: localTz(),
						fetchOverview,
					});

		if (!gen.ok) {
			const why = roastGenErrorText(gen);
			logger.warn(`[roast-sched] ${label} 生成失败:${why}`);
			// 「这周没发」后面必须跟得上原因,否则主人对着沉默猜。
			if (cfg.notifyOnError) await tell(`${label}没有发出去：${why}`);
			return { kind: "gen-failed", why };
		}

		// 审批开着:先落草稿,等主人点头。**目标是此刻的快照** —— 他点头的是
		// 「这份内容发给这些人」,审批期间改了配置也该按当初那几个群发。
		if (cfg.approval) {
			const draft = await drafts.add({
				kind,
				uid,
				days: cfg.days,
				targets: cfg.targets,
				result: gen.result,
			});
			logger.info(`[roast-sched] ${label} 已生成,等待审批(id=${draft.id})`);

			// 私聊里**必须带上正文** —— 曾经这条消息只有「已经生成好了」加一个编号,
			// 主人对着它只能盲批,审批这功能整个是假的。而且发的是渲染好的那一份
			// (出图就发图),不是文字复述:批的和发的得是同一个东西。
			const preview = await buildRoastPayload(deps, {
				kind,
				result: gen.result as BoardLike | SoloLike,
				days: cfg.days,
			});
			const guide = `☝️ ${label}已经生成好了，等主人过目～\n回复「y ${draft.id}」发送，「n ${draft.id}」丢弃。\n48 小时没有回复就自动作废。`;
			await tellPayload(
				preview.payload.kind === "image"
					? { ...preview.payload, caption: `${preview.text}\n\n${guide}` }
					: { kind: "text", text: `${preview.text}\n\n${guide}` },
			);
			return { kind: "pending-approval", draftId: draft.id };
		}

		return await deliverAndReport(kind, gen.result as BoardLike | SoloLike, cfg, label);
	}

	/** 发送 + 善后(部分失败汇总、抄送)。审批通过后也走这里,所以单独成函数。 */
	async function deliverAndReport(
		kind: "board" | "solo",
		result: BoardLike | SoloLike,
		cfg: Pick<RoastSchedule, "days" | "targets" | "notifyOnError">,
		label: string,
	): Promise<RoastRunOutcome> {
		const out = await deliverRoast(deps, {
			kind,
			result,
			days: cfg.days,
			targetIds: cfg.targets,
		});

		// 跳过的(停用)只进日志,不进通知:停用是主人自己按的,不是「没发出去」。
		const skippedNote = out.skipped.length > 0 ? `,跳过 ${out.skipped.length} 个已停用` : "";
		if (out.failed.length > 0) {
			const detail = out.failed.map((f) => `${f.targetId}：${f.err}`).join("\n");
			logger.warn(`[roast-sched] ${label} 部分目标推送失败${skippedNote}:\n${detail}`);
			// 管线自己已经退避重试过了,到这儿就是终局 —— 说清哪些没成即可。
			if (cfg.notifyOnError) {
				await tell(
					`${label}发送完毕：${out.sent.length} 个目标成功，${out.failed.length} 个失败。\n${detail}`,
				);
			}
		} else {
			logger.info(
				`[roast-sched] ${label} 已发送到 ${out.sent.length} 个目标(${out.mode})${skippedNote}`,
			);
		}

		return {
			kind: "sent",
			mode: out.mode,
			sent: out.sent.length,
			skipped: out.skipped,
			failed: out.failed,
		};
	}

	/**
	 * 配置的目标是不是**全都**停用了。悬空的 id(目标已删)不算停用 —— 它会走到投递层按
	 * 老样子报失败,这里只管「主人把勾着的群都关了」这一种情况。
	 */
	function allTargetsPaused(ids: readonly string[]): boolean {
		const byId = new Map(deps.store.getTargets().map((t) => [t.id, t]));
		const adapters = deps.store.getAdapters();
		return ids.every((id) => {
			const target = byId.get(id);
			return target !== undefined && isTargetPaused(target, adapters);
		});
	}

	/** 审批通过后把这份草稿发出去。指令链路调它。 */
	async function deliverApproved(draft: {
		kind: "board" | "solo";
		uid?: string;
		days: number;
		targets: string[];
		result: unknown;
	}): Promise<void> {
		const cfg = draft.kind === "board" ? boardConfig() : soloConfig(draft.uid ?? "");
		await deliverAndReport(
			draft.kind,
			draft.result as BoardLike | SoloLike,
			{
				days: draft.days,
				// 草稿里记的是生成那一刻的目标,不重读配置。
				targets: draft.targets,
				notifyOnError: cfg?.notifyOnError ?? true,
			},
			draft.kind === "board" ? "UP 主周报" : `${draft.uid} 的锐评`,
		);
	}

	function boardConfig(): RoastSchedule {
		return deps.store.getGlobals().roastSchedule;
	}

	function soloConfig(uid: string): RoastSchedule | undefined {
		return deps.store.getSubscriptions().find((s) => s.uid === uid)?.roastSchedule;
	}

	/**
	 * 建一条 cron。
	 *
	 * `new CronJob` 对无法解析的表达式**同步抛错**,而 cron 是配置页上的自由文本框
	 * —— 不 catch 的话一个手滑的表达式能让整个独立端在启动 / reconcile 期崩掉
	 * (fans-poller 与 dynamic-engine 都为同一件事留过注释)。
	 */
	function arm(key: string, cron: string, onTick: () => void, label: string): void {
		try {
			const job = new CronJob(cron, onTick);
			job.start();
			jobs.set(key, { cron, job });
			logger.info(`[roast-sched] ${label} 已排程:cron='${cron}'`);
		} catch (err) {
			logger.error(
				`[roast-sched] ${label} 的 cron='${cron}' 无法解析,未排程：${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * 期望的排程表:key → { cron, 触发时干什么, 日志用的名字 }。
	 *
	 * `run` 的返回值这里**故意丢掉**(`Promise<unknown>`)—— 结论是给「试一次」按钮
	 * 看的,cron 到点自动跑时没人在场,该说的话已经落进日志与私聊了。
	 */
	function desired(): Map<string, { cron: string; run: () => Promise<unknown>; label: string }> {
		const out = new Map<string, { cron: string; run: () => Promise<unknown>; label: string }>();
		const board = deps.store.getGlobals().roastSchedule;
		if (board?.enabled) {
			out.set(BOARD_KEY, { cron: board.cron, run: runBoardOnce, label: "UP 主周报" });
		}
		for (const sub of deps.store.getSubscriptions()) {
			const s = sub.roastSchedule;
			if (!s?.enabled) continue;
			const name = sub.name?.trim() || `UID ${sub.uid}`;
			out.set(sub.id, {
				cron: s.cron,
				run: () => runSoloOnce(sub.uid),
				label: `${name} 的锐评`,
			});
		}
		return out;
	}

	async function runBoardOnce(days?: number): Promise<RoastRunOutcome> {
		const cfg = boardConfig();
		// 只覆盖 days,目标与出错通知照旧走配置 —— 主人在私聊里说的是「统计多少天」,
		// 不是「这次发给谁」。cron 那条调用不传,行为逐字不变。
		return await runOnce("board", days === undefined ? cfg : { ...cfg, days }, "UP 主周报");
	}

	async function runSoloOnce(uid: string): Promise<RoastRunOutcome> {
		const cfg = soloConfig(uid);
		if (!cfg) {
			// 订阅在这一轮之间被删掉了。reconcile 会撤掉这条 job,这里只是兜底。
			logger.debug(`[roast-sched] uid=${uid} 已不在订阅列表,跳过`);
			return { kind: "gen-failed", why: "这位 UP 已经不在订阅列表里了" };
		}
		const sub = deps.store.getSubscriptions().find((s) => s.uid === uid);
		return await runOnce("solo", cfg, `${sub?.name?.trim() || `UID ${uid}`} 的锐评`, uid);
	}

	function reconcile(): void {
		if (stopped) return;
		const want = desired();
		// 撤掉已经不该存在的,以及 cron 变了的(变了的下面会重建)。
		for (const [key, cur] of jobs) {
			const next = want.get(key);
			if (!next || next.cron !== cur.cron) {
				cur.job.stop();
				jobs.delete(key);
				if (!next) logger.info(`[roast-sched] 撤销排程 ${key}`);
			}
		}
		for (const [key, w] of want) {
			if (jobs.has(key)) continue;
			// **catch 不能省**。cron 的回调是同步签名,裸 `void w.run()` 把一个
			// rejected promise 扔进了空气里 —— 而独立端装了 unhandledRejection
			// 处理器,它会**直接关掉整个进程**。也就是说草稿落盘失败、私聊通道抛错
			// 这类小事,会让整个服务停摆。
			arm(
				key,
				w.cron,
				() => {
					w.run().catch((err) => {
						logger.error(
							`[roast-sched] ${w.label} 本轮异常终止：${err instanceof Error ? err.message : String(err)}`,
						);
					});
				},
				w.label,
			);
		}
	}

	return {
		start() {
			stopped = false;
			reconcile();
		},
		stop() {
			stopped = true;
			for (const { job } of jobs.values()) job.stop();
			jobs.clear();
		},
		reconcile,
		runBoardOnce,
		runSoloOnce,
		deliverApproved,
	};
}
