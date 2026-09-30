/**
 * 「装不了」那几句 —— 传包装与从市场装**共用**这一块。
 *
 * 两条路装的是同一件事(把一个包放进数据目录),服务端拒绝时回的也是同一个形状:`message`
 * 一句话;包里不止一处不对时 `message` 是概括、`issues` 逐条。抄两份的下场是有一天只有一条路把清单
 * 摆出来,另一条只剩一句干巴巴的「失败」—— 而那几句正是主人手里那个包哪里不对的唯一线索。
 */

import { ErrorNote } from "@bilibili-notify/ui";
import { issueTextsOf } from "../../services/error-text";

/**
 * 服务端那几句拒绝:有逐条原因(`issues`)就逐条,没有就是 `message` 那一句。连不上、断线这类没有
 * 服务端话的失败,退回一句 `message` —— 但**别把它伪装成服务端说的**。
 */
export function errorsOf(err: unknown): string[] {
	const lines = issueTextsOf(err);
	if (lines.length > 0) return lines;
	return [err instanceof Error ? err.message : String(err)];
}

/** 那几句逐条摆出来。`lead` 是各处自己那一句开场白(说的是哪一条路装不了)。 */
export function InstallErrors({ lead, errors }: { lead: string; errors: readonly string[] }) {
	if (errors.length === 0) return null;
	return (
		<ErrorNote size="sm">
			<span className="font-semibold">{lead}</span>
			<ul className="mt-1 ml-4 list-disc">
				{errors.map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
		</ErrorNote>
	);
}
