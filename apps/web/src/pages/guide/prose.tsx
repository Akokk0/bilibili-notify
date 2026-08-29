import type { ReactNode } from "react";

/**
 * /guide 章节的排版小件 —— 只在 guide 目录内用,零业务依赖但也不进 ui 库:
 * 它们是这一页的方言(教程语境的标题/步骤/代码块),不是站级组件。
 * 警示框不在这里:黄用 WarnNote、红用 ErrorNote(ui 库,自带 note 挂点)。
 */

export function GdH2({ children }: { children: ReactNode }) {
	return <h2 className="mt-5 mb-2 text-bn-md font-semibold text-bn-text-primary">{children}</h2>;
}

export function GdH3({ children }: { children: ReactNode }) {
	return (
		<h3 className="mt-4 mb-1.5 text-bn-base font-semibold text-bn-text-primary">{children}</h3>
	);
}

export function GdP({ children }: { children: ReactNode }) {
	return <p className="mb-2 text-bn-sm leading-relaxed text-bn-text-secondary">{children}</p>;
}

/** 有序步骤列表:教程的主骨架。 */
export function GdSteps({ children }: { children: ReactNode }) {
	return (
		<ol className="mb-2 flex list-decimal flex-col gap-1.5 pl-5 text-bn-sm leading-relaxed text-bn-text-secondary marker:text-bn-pink">
			{children}
		</ol>
	);
}

/** 代码/配置块。暗面走 console token(值恒定但集中一处,同日志控制台)。 */
export function GdCode({ children }: { children: ReactNode }) {
	return (
		<pre className="mb-2 overflow-x-auto rounded-bn-card bg-bn-console-bg px-3.5 py-2.5 text-bn-xs leading-relaxed text-bn-console-text">
			<code>{children}</code>
		</pre>
	);
}

/** 行内代码/参数名。 */
export function GdK({ children }: { children: ReactNode }) {
	return (
		<code className="rounded-md bg-bn-code-bg px-1 py-0.5 text-[0.92em] text-bn-text-primary">
			{children}
		</code>
	);
}

/** 选型/对照表。表格必须能横滚,别让页面横向溢出。 */
export function GdTable({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
	return (
		<div className="mb-2 overflow-x-auto">
			<table className="w-full min-w-[480px] border-collapse text-bn-sm">
				<thead>
					<tr>
						{head.map((h, i) => (
							<th
								// biome-ignore lint/suspicious/noArrayIndexKey: 静态表头,不重排
								key={i}
								className="border-b border-bn-border px-2.5 py-1.5 text-left font-medium text-bn-text-primary"
							>
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((cells, r) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 静态内容表,不重排
						<tr key={r}>
							{cells.map((cell, c) => (
								<td
									// biome-ignore lint/suspicious/noArrayIndexKey: 同上
									key={c}
									className="border-b border-bn-border-subtle px-2.5 py-1.5 align-top text-bn-text-secondary"
								>
									{cell}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
