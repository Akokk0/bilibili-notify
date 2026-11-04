import type { HealthDetailsResponse } from "@bilibili-notify/contract";
import { Btn, ErrorNote, HintNote, Icon, LoadingBlock } from "@bilibili-notify/ui";
import type { ReactNode } from "react";
import { useT } from "../i18n";

/** Startup is a page boundary, not a cover over mounted business controls. */
export function StartupScreen({
	details,
	failed,
	onRetry,
	restarting = false,
	children,
}: {
	details?: HealthDetailsResponse;
	failed: boolean;
	onRetry: () => void;
	restarting?: boolean;
	children?: ReactNode;
}) {
	const tx = useT();
	const progress = details?.phase === "migrating" ? details.progress : null;
	return (
		<main className="flex min-h-screen items-center justify-center px-6 py-9">
			<section className="w-full max-w-[480px]" aria-label={tx("startup.title")}>
				<div className="mb-6 flex items-center gap-2 text-bn-sm font-bold text-bn-text-secondary">
					<Icon.refresh size={18} /> Bilibili Notify
				</div>
				<h1 className="mb-2 text-bn-md font-bold">
					{restarting
						? tx("startup.restarting")
						: failed
							? details
								? tx("startup.disconnected")
								: tx("startup.unavailable")
							: details?.phase === "migrating"
								? tx("startup.migrating")
								: details?.phase === "starting"
									? tx("startup.starting")
									: tx("startup.checking")}
				</h1>
				<p className="mb-6 text-bn-sm leading-relaxed text-bn-text-secondary">
					{restarting
						? tx("startup.restartingHint")
						: failed
							? details
								? tx("startup.connectionHint")
								: tx("startup.firstFailureHint")
							: details?.phase === "migrating"
								? tx("startup.migrationHint")
								: details?.phase === "starting"
									? tx("startup.startingHint")
									: tx("startup.checkingHint")}
				</p>
				{progress ? (
					<div>
						<div className="mb-2 flex justify-between gap-3 text-bn-sm">
							<span className="min-w-0 break-all">
								{failed ? tx("startup.lastProgress", { label: progress.label }) : progress.label}
							</span>
							<span className="shrink-0 text-bn-text-secondary">
								{tx("startup.steps", { step: progress.step, total: progress.total })}
							</span>
						</div>
						<progress
							className="bn-startup-progress"
							value={progress.step}
							max={progress.total}
							aria-label={tx("startup.title")}
							aria-valuetext={tx("startup.steps", { step: progress.step, total: progress.total })}
						/>
						<p className="mt-2 text-bn-xs leading-relaxed text-bn-text-tertiary">
							{tx("startup.stepsHint")}
						</p>
					</div>
				) : failed ? (
					<ErrorNote size="sm">{tx("startup.unknown")}</ErrorNote>
				) : (
					<LoadingBlock
						variant="inset"
						label={details?.phase === "migrating" ? tx("startup.waiting") : tx("startup.loading")}
					/>
				)}
				<HintNote className="mt-6">{tx("startup.operationsPaused")}</HintNote>
				{failed ? (
					<div className="mt-4">
						<Btn size="sm" variant="outline" onClick={onRetry}>
							{tx("startup.retry")}
						</Btn>
					</div>
				) : null}
				{children}
			</section>
		</main>
	);
}
