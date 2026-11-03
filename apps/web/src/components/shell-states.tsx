import { useT } from "../i18n";
/**
 * Shell-level Empty / Loading / Error overlays — port of the variation-ac
 * stateMode branches. Shown by App.tsx when /api/health hasn't responded
 * yet or has fatal-erred, OR when the user has no subs and no targets
 * (empty bootstrap).
 */

import { Btn, LoadingBlock } from "@bilibili-notify/ui";
import { useNavigate } from "react-router-dom";

export function ShellLoading() {
	const tx = useT();

	return (
		// 整屏空白上的等待,不套玻璃卡 —— 底下什么都还没有,一张卡浮在空页上更怪。
		<div className="flex flex-1 items-center justify-center px-7 py-20">
			<LoadingBlock
				label={tx("panelUi.components.shell-states.1")}
				hint={tx("panelUi.components.shell-states.2")}
				variant="inset"
			/>
		</div>
	);
}

export function ShellError({ message, onRetry }: { message: string; onRetry: () => void }) {
	const tx = useT();

	const navigate = useNavigate();
	return (
		<div className="px-7 pt-5">
			<div
				className="rounded-lg border bg-bn-danger-soft p-4 backdrop-blur-sm"
				style={{
					borderColor: "var(--color-bn-danger-border)",
					borderLeft: "3px solid var(--color-bn-danger)",
				}}
			>
				<div className="mb-1 text-bn-base font-bold text-bn-danger-text">
					{tx("panelUi.components.shell-states.3")}
				</div>
				<div className="text-bn-sm leading-relaxed text-bn-danger-text">
					{tx("panelUi.components.shell-states.4")}
					<code className="rounded-sm bg-bn-code-bg px-1.5 py-0.5">{message}</code>
					<br />
					{tx("panelUi.components.shell-states.5")}
				</div>
				<div className="mt-3 flex gap-2">
					<Btn variant="primary" size="sm" onClick={onRetry}>
						{tx("panelUi.components.shell-states.6")}
					</Btn>
					<Btn variant="outline" size="sm" onClick={() => navigate("/system")}>
						{tx("panelUi.components.shell-states.7")}
					</Btn>
				</div>
			</div>
		</div>
	);
}
