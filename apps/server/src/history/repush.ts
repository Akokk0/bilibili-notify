import type { HistoryEntry, HistoryMessage } from "@bilibili-notify/internal";

/**
 * **人工重推的判断**(ADR-0017)—— 全是纯函数,不碰盘也不碰网。
 *
 * 一行历史里,每条消息的身份是 `retryOf ?? 它自己的下标`(决策 15),每一号只认它
 * **最后那次**尝试。重推追加进原行而不新开行,所以一行里会有同一条消息的好几次结果;
 * 「本来有几条」「还有哪几条没到」都得按身份号数,不能按 `messages.length` 数。
 */

/**
 * 每一号最后那次尝试。键 = 身份号(`retryOf ?? 下标`)。
 *
 * 🔴 **只此一份**:`computeStatus` 判四态、`unsentIndices` 数「还差哪几条」,靠的是同一条
 * 判定(决策 16 明写它不能退化成「按 role 取最后一次」)。分成两份的话,一处改了另一处
 * 不改,面板上的条数与行的颜色会对不上 —— 而两边都不会红(状态是写入时算好存盘的)。
 */
export function latestByIdentity(messages: readonly HistoryMessage[]): Map<number, HistoryMessage> {
	const latest = new Map<number, HistoryMessage>();
	for (const [i, m] of messages.entries()) latest.set(m.retryOf ?? i, m);
	return latest;
}

/**
 * 这一行**本来**有几条消息 —— 重投不算新的一条。
 *
 * 重推原件对表用的就是这个数(而不是 `messages.length`):行会随着每次重推变长,
 * 拿总长度去对,补过一次原件就对不上号、按钮当场灰掉。
 */
export function originalCount(messages: readonly HistoryMessage[]): number {
	return messages.reduce((n, m) => n + (m.retryOf === undefined ? 1 : 0), 0);
}

/**
 * 「只补没到的」要补哪几条 —— 每一号的最后一次尝试没成的那些身份号,升序。
 *
 * 「没到」有两种,一视同仁:发了但失败了,和**因为前面失败而从没发出去**(决策 17 之后
 * 它们也在行里,没有 `result`)。后者恰恰是最需要补的那种 —— 第一条就失败时,后面本该
 * 发的那几条今天一次都没出过网。
 */
export function unsentIndices(messages: readonly HistoryMessage[]): number[] {
	const out: number[] = [];
	for (const [id, m] of latestByIdentity(messages)) {
		if (m.result?.ok !== true) out.push(id);
	}
	return out.sort((a, b) => a - b);
}

/**
 * 闸的入参。**这里没有的东西就是这个闸不判的东西** —— 全局静音、免扰时段、特性总开关
 * 一把钥匙都没给它(决策 11:这是主人此刻按下的显式动作,不是引擎自动推送),目标
 * 当下可不可达也没给(决策 12:那正是重推要解决的,交给发送层的退避重试)。
 */
export interface RepushGateInput {
	/** 要补的那一行。 */
	entry: HistoryEntry;
	/** 这个 uid 这把特性键**当前**路由到哪些目标;订阅已经没了就是空。 */
	routedTargets: readonly string[];
	/** 目标与它所属的连接都还启用着(`sink.isEnabled`)。 */
	targetEnabled: boolean;
	/** 这一行正在补 —— 服务端自己记的,不靠前端的禁用态。 */
	running: boolean;
}

/**
 * 能不能补。回一句**给人看的**拒绝理由,`null` = 放行。
 *
 * 四档各有各的说法:一句含糊的「不能重推」会让主人对着黑盒猜,而这四件事的下一步
 * 完全不同(什么都不用做 / 去路由里加回来 / 去把目标启用 / 等一下)。
 */
export function repushDenial(input: RepushGateInput): string | null {
	const { entry, routedTargets, targetEnabled, running } = input;
	// 决策 6:按钮只长在 failed 与 partial 上。no-targets 连目标都没有,补不成。
	if (entry.status !== "failed" && entry.status !== "partial") {
		return entry.status === "no-targets"
			? "这条推送当时没有可用的目标，补不了 —— 先去给它配一个吧"
			: "这一行全都送到了，不用补啦";
	}
	if (entry.targetId === null) return "这条推送当时没有可用的目标，补不了 —— 先去给它配一个吧";
	// 决策 10:与发送层每次重试前复检 routing 同源 —— 用户已经取消了。
	if (!routedTargets.includes(entry.targetId)) {
		return "这条推送已经不发给这个目标了 —— 路由里把它去掉了";
	}
	if (!targetEnabled) return "这个目标（或者它所在的连接）停用了，先启用再补";
	// 决策 13:挡在服务端。两个标签页各点一下,前端的禁用态管不着彼此。
	if (running) return "这一行正在补，女仆还没回来呢";
	return null;
}
