/**
 * 「装不了」那几句 —— 传包装与从市场装**共用**这一块。
 *
 * 两条路装的是同一件事(把一个包放进数据目录),服务端拒绝时回的也是同一个形状:一个
 * `errors` 数组,每条是那个包哪里不对。抄两份的下场是有一天只有一条路把清单摆出来,
 * 另一条只剩一句干巴巴的「失败」—— 而那几句正是主人手里那个包哪里不对的唯一线索。
 */

import { ErrorNote } from "@bilibili-notify/ui";
import { ApiError } from "../../services/api";

/** 服务端那几句拒绝。拿不到就退回一句 message —— 但**别把它伪装成服务端说的**。 */
export function errorsOf(err: unknown): string[] {
	if (err instanceof ApiError) {
		const body = err.body as { errors?: unknown } | null;
		if (Array.isArray(body?.errors)) return body.errors.map((e) => String(e));
	}
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
