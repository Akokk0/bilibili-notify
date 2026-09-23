import {
	type DeliveryResult,
	type FeatureKey,
	type HistoryEntry,
	type Logger,
	type NotificationPayload,
	pushKindToFeature,
} from "@bilibili-notify/internal";
import { originalCount, repushDenial, unsentIndices } from "./repush.js";
import type { RepushMessage, RepushStore } from "./repush-store.js";
import type { HistoryStore } from "./store.js";

/**
 * **人工重推的执行器**(ADR-0017)。
 *
 * 🔴 **立刻回,后台跑。** 发送层的 `sendToTarget` 光退避就最长约 190s(3→6→12→24→48→96),
 * 一行补 N 条就是 190s × N —— HTTP 请求绝不能同步等着。按下按钮立刻回一句「收到」,
 * 消息一条条补,每补一条就往历史行里追加、`history-updated` 推到面板,那条路早就通着。
 *
 * **发送口固定注入 `BilibiliPush.sendToTarget`**,因为它恰好就是定案里那三条闸的交汇点:
 *
 * - 自带退避重试 → 目标不可达不挡(决策 12),那正是重推要解决的东西;
 * - 每次重试前复检 routing → 用户已经取消了就停(决策 10),与入口那道闸同源;
 * - 静音 / 免扰 / 特性总开关三道都在它**上游**的 `broadcastToFeature` 里 → 走这条路
 *   它们天然不参与(决策 11:这是主人此刻按下的显式动作,不是引擎自动推送)。
 *
 * 进程在补到一半时退出,那几条就停在那儿 —— 行里如实记着补到哪,按钮照样能再按
 * (决策 18)。不做「失败 N 次后禁用」。
 */

/** 补哪些:`all` = 整行从头再发一遍(含已经送达的);`missing` = 只补没到的。 */
export type RepushMode = "all" | "missing";

/**
 * 判别联合而不是「几个可选字段的袋子」:放行必有条数、拒绝必有理由,写成可选的话端点那头
 * 收窄不到,只能在已经判过 `ok` 的分支里再判一次 `undefined`(而那个 `undefined` 是造不
 * 出来的)。契约上的 `HistoryRepushResponse` 是同一个形状。
 */
export type RepushStartResult =
	/** 收下了。`count` = 这一趟要补几条。 */
	| { ok: true; count: number }
	/** 拒了。`reason` 是**给人看的**那句;`notFound` = 这一行压根不存在,端点据此回 404。 */
	| { ok: false; reason: string; notFound?: boolean };

export interface RepushRunner {
	/**
	 * 开始补一行。**立刻返回** —— 真正的发送在后台跑,进度经 `history-updated` 回面板。
	 */
	start(rowId: string, ts: string, mode: RepushMode): Promise<RepushStartResult>;
	/**
	 * 这一行**现在**能不能补 —— 回一句拒绝理由,`null` = 能。面板拿它决定按钮灰不灰
	 * 并写上原因(决策 9:灰掉并说明,而不是藏起来 —— 藏掉的话主人要么以为这行没失败过,
	 * 要么以为功能坏了)。
	 *
	 * 与 `start` 同一道闸,只多问一句「原件还在吗」;查的是文件在不在,不读图。
	 */
	canRepush(entry: HistoryEntry): Promise<string | null>;
	/** 这一行正在补吗。闸与面板共用这一个答案。 */
	isRunning(rowId: string): boolean;
}

export interface CreateRepushRunnerOptions {
	history: Pick<HistoryStore, "findRow" | "appendToRow">;
	repush: RepushStore;
	/**
	 * 把一条消息发给一个目标。**约定注入 `BilibiliPush.sendToTarget`**(见文件头:
	 * 那三条闸就是靠选它而自动满足的)。
	 */
	send(
		targetId: string,
		payload: NotificationPayload,
		routing: { subscriptionId: string; feature: FeatureKey },
	): Promise<DeliveryResult>;
	/** 这条订阅(按订阅自己的 id)这把特性键**当前**路由到哪些目标。 */
	routedTargets(subscriptionId: string, feature: FeatureKey): readonly string[];
	/**
	 * 行上记的订阅**现在**是哪一条,回它的 id(ADR-0019 决策 50):先按 `subscriptionId` 找,
	 * 找不到再按身份(B 站 uid)找 —— 删了又重加的 UP,旧历史照样能重推。都找不到回 undefined。
	 */
	currentSubscriptionOf(row: { subscriptionId: string; uid: string }): string | undefined;
	/** 目标与它所属的连接都还启用着(`sink.isEnabled`)。 */
	targetEnabled(targetId: string): boolean;
	logger: Logger;
}

/** 原件不在了(保留期到了、或者当初就没写成)。两处都说这一句。 */
const DRAFT_GONE = "这一行的原料已经不在了，女仆补不出原来那条 —— 只有保留期内的推送补得回来";

export function createRepushRunner(opts: CreateRepushRunnerOptions): RepushRunner {
	/**
	 * 正在补的行。挡在**服务端**而不是只靠前端的禁用态(决策 13)—— 两个标签页前端
	 * 管不着彼此,而后果是真的往群里多发一条。
	 */
	const running = new Set<string>();

	/** 闸那一半 —— `start` 与 `canRepush` 共用,免得两处各判各的、慢慢漂开。 */
	function gate(entry: HistoryEntry): string | null {
		const subscriptionId = opts.currentSubscriptionOf(entry);
		return repushDenial({
			entry,
			// 解析不到当前订阅 = 订阅已经没了,按「路由是空」处理:拒绝理由还是「路由里把它去掉了」那句。
			routedTargets:
				subscriptionId === undefined
					? []
					: opts.routedTargets(subscriptionId, pushKindToFeature(entry.kind)),
			targetEnabled: entry.targetId !== null && opts.targetEnabled(entry.targetId),
			running: running.has(entry.id),
		});
	}

	async function canRepush(entry: HistoryEntry): Promise<string | null> {
		const denial = gate(entry);
		if (denial) return denial;
		return (await opts.repush.has(entry.id, entry.ts)) ? null : DRAFT_GONE;
	}

	async function start(rowId: string, ts: string, mode: RepushMode): Promise<RepushStartResult> {
		const entry = await opts.history.findRow(rowId, ts);
		if (!entry) return { ok: false, notFound: true, reason: "找不到这一行推送记录了" };

		const denial = gate(entry);
		if (denial) return { ok: false, reason: denial };

		// 原件与行**按身份号**对表,不是按 messages.length —— 行会随着每次重推变长。
		const draft = await opts.repush.load(rowId, ts, originalCount(entry.messages));
		if (!draft) return { ok: false, reason: DRAFT_GONE };

		const indices =
			mode === "all" ? draft.messages.map((_, i) => i) : unsentIndices(entry.messages);
		if (indices.length === 0) return { ok: false, reason: "这一行全都送到了，不用补啦" };

		running.add(rowId);
		void run(entry, ts, draft.messages, indices).finally(() => running.delete(rowId));
		return { ok: true, count: indices.length };
	}

	/**
	 * 一条条补。**一条失败即中止后续条** —— 照搬本来的推送语义:失败后大概率继续失败,
	 * 而且每条还要再等一轮最长 190s 的退避;剩下那几条本来就还在行里躺着,下次按按钮
	 * 照样补得到(决策 18)。
	 *
	 * 每补一条就立刻写回历史,不攒到最后:面板上看得见进度,而且进程半路退出时已经补上
	 * 的那几条不会丢。
	 */
	async function run(
		entry: HistoryEntry,
		ts: string,
		messages: readonly RepushMessage[],
		indices: readonly number[],
	): Promise<void> {
		const targetId = entry.targetId;
		if (targetId === null) return;
		const feature = pushKindToFeature(entry.kind);
		let latest: HistoryEntry | null = null;
		for (const i of indices) {
			const m = messages[i];
			if (!m) continue;
			// 每条都现解析一次「现在是哪条订阅」,闸是在按按钮那一刻判的,补的途中订阅可能又变了。
			// 解析不到就沿用行上记的那个 id —— 它已经不在任何订阅上了,发送层的 routing 复检当场
			// 放弃并说明原因,结果照样追进行里(与闸那边一样落到「路由是空」那一档)。
			const subscriptionId = opts.currentSubscriptionOf(entry) ?? entry.subscriptionId;
			let result: DeliveryResult;
			try {
				result = await opts.send(targetId, m.payload, { subscriptionId, feature });
			} catch (err) {
				// 发送层自己不抛,但注入进来的东西不是我们能打包票的。吞掉会让这一趟
				// 静默停住、行上什么都不留,主人只看得见「点了没反应」。
				result = { ok: false, latencyMs: 0, err: err instanceof Error ? err.message : String(err) };
			}
			latest = await opts.history.appendToRow(entry.id, ts, [
				{ payload: m.payload, role: m.role, result, retryOf: i },
			]);
			if (!result.ok) {
				opts.logger.info(`[history] 重推第 ${i} 条没成，这一趟到此为止：${result.err ?? ""}`);
				break;
			}
		}
		// 决策 5:补齐了才删原件。只补了一部分、或者又失败了的留着,按钮还得能再按。
		if (latest?.status === "delivered") await opts.repush.drop(entry.id, ts);
	}

	return { start, canRepush, isRunning: (rowId) => running.has(rowId) };
}
