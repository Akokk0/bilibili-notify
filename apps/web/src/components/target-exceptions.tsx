import { DisclosurePill, Pill } from "@bilibili-notify/ui";
import { type ReactNode, useState } from "react";
import { useT } from "../i18n";
import { type Connection, isTargetPaused, type PushTarget } from "../types/domain";
import { TargetLabel, targetDisplay } from "./target-display";

/** Shared presentation only: each reader owns candidate selection, values and capabilities. */
export function TargetExceptions({
	targets,
	connections,
	summary,
	expandLabel,
	collapseLabel,
	color,
	renderCells,
	renderAfter,
}: {
	targets: readonly PushTarget[];
	connections: readonly Connection[];
	summary: ReactNode;
	expandLabel: string;
	collapseLabel: string;
	color?: string;
	renderCells: (target: PushTarget) => ReactNode;
	renderAfter?: (target: PushTarget) => ReactNode;
}) {
	const tx = useT();
	const [open, setOpen] = useState(false);
	return (
		<div className="flex min-w-0 flex-col">
			<div className="flex flex-wrap items-center justify-between gap-3 text-bn-xs text-bn-text-secondary">
				<div>{summary}</div>
				<DisclosurePill open={open} onToggle={() => setOpen(!open)} color={color}>
					{open ? collapseLabel : expandLabel}
				</DisclosurePill>
			</div>
			{open
				? targets.map((target) => {
						const display = targetDisplay(target, connections);
						return (
							<fieldset
								key={target.id}
								aria-label={`${display.label} · ${display.description}`}
								className="m-0 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 border-0 border-b border-bn-border-subtle p-0 py-3.5 last:border-b-0"
							>
								<div className="flex min-w-0 max-w-full flex-[1_1_180px] items-center gap-1.5 text-bn-sm text-bn-text-primary">
									<TargetLabel target={target} connections={connections} />
									{isTargetPaused(target, connections) ? (
										<Pill size="sm" subtle color="var(--color-bn-inactive)">
											{tx("linkPreview.groupRow.text1")}
										</Pill>
									) : null}
								</div>
								<div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
									{renderCells(target)}
								</div>
								{renderAfter?.(target)}
							</fieldset>
						);
					})
				: null}
		</div>
	);
}
