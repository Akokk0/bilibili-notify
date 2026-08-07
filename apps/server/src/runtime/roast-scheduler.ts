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

import type { Logger, RoastSchedule } from "@bilibili-notify/internal";
import { CronJob } from "cron";
import {
	type BoardLike,
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
}

export interface RoastScheduler {
	start(): void;
	stop(): void;
	/** 重读配置,增删改各条 job。config-changed / subscription-changed 后调。 */
	reconcile(): void;
	/** 立刻跑一次榜单周报。cron 到点调它,测试也直接调它。 */
	runBoardOnce(): Promise<void>;
	/** 立刻跑一次某位 UP 的单人锐评。 */
	runSoloOnce(uid: string): Promise<void>;
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
	): Promise<void> {
		if (stopped) return;

		// 一个目标都没配 —— 先拦住,别白调一次模型再把结果扔掉。
		if (cfg.targets.length === 0) {
			logger.warn(`[roast-sched] ${label}:没有配置推送目标,跳过`);
			if (cfg.notifyOnError) await tell(`${label}没有发出去：还没有配置推送目标。`);
			return;
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
			return;
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
			await tell(
				`${label}已经生成好了，等主人过目～\n回复「y ${draft.id}」发送，「n ${draft.id}」丢弃。\n48 小时没有回复就自动作废。`,
			);
			return;
		}

		await deliverAndReport(kind, gen.result as BoardLike | SoloLike, cfg, label);
	}

	/** 发送 + 善后(部分失败汇总、抄送)。审批通过后也走这里,所以单独成函数。 */
	async function deliverAndReport(
		kind: "board" | "solo",
		result: BoardLike | SoloLike,
		cfg: Pick<RoastSchedule, "days" | "targets" | "notifyOnError" | "ccMaster">,
		label: string,
	): Promise<void> {
		const out = await deliverRoast(deps, {
			kind,
			result,
			days: cfg.days,
			targetIds: cfg.targets,
		});

		if (out.failed.length > 0) {
			const detail = out.failed.map((f) => `${f.targetId}：${f.err}`).join("\n");
			logger.warn(`[roast-sched] ${label} 部分目标推送失败:\n${detail}`);
			// 管线自己已经退避重试过了,到这儿就是终局 —— 说清哪些没成即可。
			if (cfg.notifyOnError) {
				await tell(
					`${label}发送完毕：${out.sent.length} 个目标成功，${out.failed.length} 个失败。\n${detail}`,
				);
			}
		} else {
			logger.info(`[roast-sched] ${label} 已发送到 ${out.sent.length} 个目标(${out.mode})`);
		}

		// 抄送与异常通知是两件事:一个是故障告警,一个是内容留底。
		if (cfg.ccMaster && out.sent.length > 0) {
			await tell(`${label}已发送：\n${out.text}`);
		}
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
				ccMaster: cfg?.ccMaster ?? false,
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

	/** 期望的排程表:key → { cron, 触发时干什么, 日志用的名字 }。 */
	function desired(): Map<string, { cron: string; run: () => Promise<void>; label: string }> {
		const out = new Map<string, { cron: string; run: () => Promise<void>; label: string }>();
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

	async function runBoardOnce(): Promise<void> {
		await runOnce("board", boardConfig(), "UP 主周报");
	}

	async function runSoloOnce(uid: string): Promise<void> {
		const cfg = soloConfig(uid);
		if (!cfg) {
			// 订阅在这一轮之间被删掉了。reconcile 会撤掉这条 job,这里只是兜底。
			logger.debug(`[roast-sched] uid=${uid} 已不在订阅列表,跳过`);
			return;
		}
		const sub = deps.store.getSubscriptions().find((s) => s.uid === uid);
		await runOnce("solo", cfg, `${sub?.name?.trim() || `UID ${uid}`} 的锐评`, uid);
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
		// 指令链路要用它把审批通过的草稿发出去。
		deliverApproved,
	} as RoastScheduler & { deliverApproved: typeof deliverApproved };
}
