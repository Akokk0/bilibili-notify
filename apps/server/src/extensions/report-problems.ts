import type { SubscriptionReportProblem } from "./context.js";

/**
 * 拓展详情页那个「上报问题」框背后的记录(ADR-0019 决策 60):丢格、整条拒、报了没声明的种类……
 * 一条上报记一条。
 *
 * - **每个拓展一段、最近 {@link REPORT_PROBLEMS_KEPT} 条**,满了挤掉最老的:一个系统性的 bug 每条作品
 *   都记一条,留全了就是一个无底洞;按拓展分开,甲拓展刷屏挤不掉乙拓展那几条。
 * - **只在内存**,重启清空;拓展被卸载时那一段整个清掉(装回来的是一个新的它)。停用不清 —— 停了之后
 *   回头查「它刚才报了什么坏东西」正是用得上的时候。
 * - 不私聊主人:一个系统性的 bug 就是每条作品一条私聊(决策 60)。
 *
 * 写的一头是 ctx 里唯一那个「上报问题」出口(`onSubscriptionReportProblem`),读的一头是拓展列表那一口
 * (`ExtensionDTO.reportProblems`)。记了新的就叫面板重取(`onChanged` → bus 的
 * `extension-report-problems-changed`),**按拓展、在尾沿合并** —— 自己一个窗口,不借 `ctx.statusChanged()`
 * 那一声:那一声说的是「拓展的视图变了」,借了的话桥每喊一次都要多拉一遍拓展表,上报问题每记一条又要多
 * 重读一次视图。
 */

/** 每个拓展留最近多少条(决策 60)。 */
export const REPORT_PROBLEMS_KEPT = 20;

/**
 * 「上报问题变了」按拓展合并的窗口:第一条起算,窗口里再记的只在尾沿一起发**一次**,不因为又记了一条而
 * 往后推(一直在报坏东西的拓展,框照样按窗口刷新)。与 `STATUS_CHANGED_COALESCE_MS` 同一个数、同一个
 * 道理,但各算各的。
 */
export const REPORT_PROBLEMS_CHANGED_COALESCE_MS = 250;

export interface ReportProblemLog {
	record(problem: SubscriptionReportProblem): void;
	/** 这个拓展最近的几条,**新的在前**。没有就是空表。交出去的是拷贝。 */
	list(extensionId: string): readonly SubscriptionReportProblem[];
	/** 这个拓展被卸载了:它那一段整个清掉,挂着的那一发「变了」也不发了。 */
	clear(extensionId: string): void;
	/** 宿主关机:挂着的那几发都不发了。 */
	dispose(): void;
}

export interface CreateReportProblemLogOptions {
	/** 这个拓展的上报问题变了(按拓展合并过,见 {@link REPORT_PROBLEMS_CHANGED_COALESCE_MS})。 */
	onChanged?: (extensionId: string) => void;
}

export function createReportProblemLog(opts: CreateReportProblemLogOptions = {}): ReportProblemLog {
	/** 拓展 id → 它那一段,**老的在前**(挤最老的那条就是 `shift`)。 */
	const byExtension = new Map<string, SubscriptionReportProblem[]>();
	/** 拓展 id → 挂着的那一发「变了」。 */
	const pending = new Map<string, ReturnType<typeof setTimeout>>();

	function announce(extensionId: string): void {
		if (!opts.onChanged || pending.has(extensionId)) return;
		pending.set(
			extensionId,
			setTimeout(() => {
				pending.delete(extensionId);
				opts.onChanged?.(extensionId);
			}, REPORT_PROBLEMS_CHANGED_COALESCE_MS),
		);
	}

	function cancel(extensionId: string): void {
		clearTimeout(pending.get(extensionId));
		pending.delete(extensionId);
	}

	return {
		record(problem) {
			const kept = byExtension.get(problem.extensionId) ?? [];
			kept.push(problem);
			if (kept.length > REPORT_PROBLEMS_KEPT) kept.splice(0, kept.length - REPORT_PROBLEMS_KEPT);
			byExtension.set(problem.extensionId, kept);
			announce(problem.extensionId);
		},
		list(extensionId) {
			return [...(byExtension.get(extensionId) ?? [])].reverse();
		},
		clear(extensionId) {
			byExtension.delete(extensionId);
			cancel(extensionId);
		},
		dispose() {
			for (const extensionId of [...pending.keys()]) cancel(extensionId);
		},
	};
}
