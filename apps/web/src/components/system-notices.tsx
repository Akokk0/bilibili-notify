import type {
	HealthResponse,
	RestartResponse,
	SystemNotice,
	SystemNoticesResponse,
} from "@bilibili-notify/contract";
import { Btn, ErrorNote, HintNote, ModalShell } from "@bilibili-notify/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { HEALTH_QUERY_OPTIONS } from "../hooks/useBackendReachable";
import { useExtensions } from "../hooks/useExtensions";
import { useT } from "../i18n";
import { InstallErrors } from "../pages/extensions/install-errors";
import { ExtensionInstallOutcome } from "../pages/extensions/install-outcome";
import { useMarketplaceInstall } from "../pages/extensions/marketplace-section";
import { ApiError, api } from "../services/api";
import { errorTextOf } from "../services/error-text";
import { FreshStartContent, SystemNoticeContent } from "./system-notice-content";
import { DEFAULT_RESTART_WAIT, useRestartStore } from "./update/restart";

const NOTICES_QUERY_KEY = ["system-notices"] as const;

/** Persistent unread state belongs to the server; closing only snoozes this host instance. */
export function SystemNoticesHost({
	processId,
	onBlockingChange,
}: {
	processId: string;
	onBlockingChange: (blocked: boolean) => void;
}) {
	const tx = useT();
	const qc = useQueryClient();
	const [open, setOpen] = useState(true);
	const entry = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) entry.current?.querySelector<HTMLButtonElement>("button")?.focus();
	}, [open]);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const query = useQuery({
		queryKey: NOTICES_QUERY_KEY,
		queryFn: () => api.get<SystemNoticesResponse>("/api/system/notices"),
		retry: false,
		staleTime: 0,
	});
	const notices = query.data?.notices ?? [];
	const current = notices[0];
	const blocking = query.isPending || (open && current !== undefined && !query.isError);
	useEffect(() => onBlockingChange(blocking), [blocking, onBlockingChange]);
	function isCurrent() {
		return mounted.current && qc.getQueryData<HealthResponse>(["health"])?.startedAt === processId;
	}
	async function acknowledge(id: string) {
		try {
			const next = await api.post<SystemNoticesResponse>(
				`/api/system/notices/${encodeURIComponent(id)}/acknowledge`,
			);
			if (isCurrent()) qc.setQueryData(NOTICES_QUERY_KEY, next);
		} catch (error) {
			if (error instanceof ApiError && error.status === 404 && isCurrent()) {
				const refreshed = await query.refetch();
				if (refreshed.isSuccess && !refreshed.data.notices.some((notice) => notice.id === id))
					return;
			}
			throw error;
		}
	}

	async function createEmpty() {
		const result = await api.post<RestartResponse>("/api/system/generations", { source: "empty" });
		if (isCurrent())
			useRestartStore.getState().begin(
				{
					before: result.startedAt,
					target: result.version,
					mode: "restart",
					purpose: "generation",
				},
				DEFAULT_RESTART_WAIT,
			);
	}

	return (
		<>
			{query.isError ? (
				<div className="mx-7 mt-4">
					<ErrorNote size="sm">
						{tx("lifecycle.readFailed")}
						<p className="my-2 break-all">{errorTextOf(query.error)}</p>
						<Btn size="sm" variant="outline" onClick={() => void query.refetch()}>
							{tx("lifecycle.retry")}
						</Btn>
					</ErrorNote>
				</div>
			) : !open && notices.length > 0 ? (
				<div className="mx-7 mt-4">
					<HintNote>
						<div className="flex flex-wrap items-center justify-between gap-3">
							<span>{tx("lifecycle.pending", { count: notices.length })}</span>
							<div ref={entry}>
								<Btn size="sm" variant="outline" onClick={() => setOpen(true)}>
									{tx("lifecycle.view")}
								</Btn>
							</div>
						</div>
					</HintNote>
				</div>
			) : null}
			{open && current && !query.isError ? (
				<SystemNoticeDialog
					key={current.id}
					notice={current}
					onSnooze={() => setOpen(false)}
					onAcknowledge={acknowledge}
					onCreateEmpty={createEmpty}
				/>
			) : null}
		</>
	);
}

function SystemNoticeDialog({
	notice,
	onSnooze,
	onAcknowledge,
	onCreateEmpty,
}: {
	notice: SystemNotice;
	onSnooze: () => void;
	onAcknowledge: (id: string) => Promise<void>;
	onCreateEmpty: () => Promise<void>;
}) {
	const tx = useT();
	const navigate = useNavigate();
	const health = useQuery(HEALTH_QUERY_OPTIONS);
	const [busy, setBusy] = useState(false);
	const saving = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [fresh, setFresh] = useState(false);
	const installer = useMarketplaceInstall({ motion: false });
	const [sourceName, setSourceName] = useState("");
	const locked = busy || installer.install.isPending;
	const confirming = installer.confirming;
	const ability = useExtensions({ enabled: fresh, retry: false });
	const canCreate = ability.data?.restart?.can === true && !ability.isPending && !ability.isError;
	const body = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const onTab = (event: KeyboardEvent) => {
			if (event.key !== "Tab") return;
			const items = [
				...(body.current?.querySelectorAll<HTMLElement>(
					"button:not([disabled]), a[href], summary",
				) ?? []),
			];
			const first = items[0],
				last = items.at(-1);
			if (!first) {
				event.preventDefault();
				body.current?.focus();
				return;
			}
			const current = document.activeElement as HTMLElement;
			if (!items.includes(current)) {
				event.preventDefault();
				(event.shiftKey ? last : first)?.focus();
			} else if (event.shiftKey && current === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && current === last) {
				event.preventDefault();
				first.focus();
			}
		};
		window.addEventListener("keydown", onTab);
		return () => {
			window.removeEventListener("keydown", onTab);
			if (previous?.isConnected) previous.focus();
		};
	}, []);
	const view = confirming ? `confirm:${confirming.id}` : fresh ? "fresh" : "notice";
	useEffect(() => {
		if (locked) {
			body.current?.focus();
			return;
		}
		if (view === "notice" && notice.kind === "migrated") {
			// Start with the information, not a preselected action. Tab still enters the controls.
			body.current?.focus();
		} else if (view === "fresh" || view.startsWith("confirm:") || view === "notice") {
			body.current?.querySelector<HTMLElement>("button:not([disabled]), a[href], summary")?.focus();
		}
	}, [view, locked, notice.kind]);
	const title = confirming
		? tx("panelUi.pages.extensions.marketplace-section.1", {
				value0: confirming.name,
				value1: confirming.version,
			})
		: fresh
			? tx("lifecycle.confirmFresh")
			: notice.kind === "migrated"
				? tx("lifecycle.migrated")
				: notice.kind === "updated"
					? tx("lifecycle.updated", { version: notice.version })
					: notice.kind === "generation-failed"
						? tx("lifecycle.failed")
						: tx("lifecycle.rolledBack");
	async function perform(action: () => Promise<void>) {
		if (saving.current) return;
		saving.current = true;
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (e) {
			setError(errorTextOf(e));
		} finally {
			saving.current = false;
			setBusy(false);
		}
	}
	return (
		<ModalShell
			title={title}
			width={620}
			bodyClassName="p-5"
			onCancel={() => {
				if (!saving.current && !installer.install.isPending) {
					if (confirming) installer.cancel();
					else if (fresh) setFresh(false);
					else onSnooze();
				}
			}}
		>
			<div
				ref={body}
				tabIndex={-1}
				aria-busy={locked}
				className="text-bn-sm leading-relaxed text-bn-text-secondary outline-none"
			>
				{confirming ? (
					<p>{tx("panelUi.pages.extensions.marketplace-section.3", { value0: sourceName })}</p>
				) : fresh ? (
					<FreshStartContent
						ability={ability.data?.restart}
						pending={ability.isPending}
						error={ability.error}
						onRetry={() => void ability.refetch()}
					/>
				) : (
					<SystemNoticeContent
						notice={notice}
						onUpdate={(entry, name) => {
							setSourceName(name);
							setError(null);
							installer.start(entry);
						}}
						onFresh={() => {
							setFresh(true);
							setError(null);
						}}
						runningVersion={health.data?.version ?? ""}
						disabled={locked}
						onNavigate={(to) => {
							if (saving.current || installer.install.isPending) return;
							onSnooze();
							navigate(to);
						}}
					/>
				)}
				<InstallErrors lead={tx("lifecycle.updateFailed")} errors={installer.errors} />
				<ExtensionInstallOutcome done={installer.done} />
				{error ? (
					<ErrorNote size="sm" className="mt-4">
						{error}
					</ErrorNote>
				) : null}
				<footer className="mt-5 flex flex-wrap justify-end gap-2 border-t border-bn-border-subtle pt-4 max-sm:[&_button]:min-h-9">
					{confirming ? (
						<>
							<Btn size="sm" variant="outline" disabled={locked} onClick={installer.cancel}>
								{tx("lifecycle.back")}
							</Btn>
							<Btn size="sm" variant="danger-solid" disabled={locked} onClick={installer.confirm}>
								{tx("panelUi.pages.extensions.marketplace-section.4")}
							</Btn>
						</>
					) : fresh ? (
						<>
							<Btn
								size="sm"
								variant="outline"
								disabled={locked}
								onClick={() => {
									setFresh(false);
									setError(null);
								}}
							>
								{tx("lifecycle.back")}
							</Btn>
							<Btn
								size="sm"
								variant="danger-solid"
								disabled={locked || !canCreate}
								onClick={() => void perform(onCreateEmpty)}
							>
								{tx("lifecycle.createEmpty")}
							</Btn>
						</>
					) : (
						<>
							<Btn size="sm" variant="outline" disabled={locked} onClick={onSnooze}>
								{tx("lifecycle.later")}
							</Btn>
							<Btn
								size="sm"
								variant="primary"
								disabled={locked}
								onClick={() => void perform(() => onAcknowledge(notice.id))}
							>
								{notice.kind === "migrated"
									? tx("lifecycle.keepMigrated")
									: tx("lifecycle.acknowledge")}
							</Btn>
						</>
					)}
				</footer>
			</div>
		</ModalShell>
	);
}
