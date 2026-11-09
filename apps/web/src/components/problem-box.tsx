import type { ConnectionView, ProblemsResponse } from "@bilibili-notify/contract";
import {
	Btn,
	ErrorNote,
	Icon,
	IconButton,
	LoadingBlock,
	PopoverShell,
	useDismiss,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { integrationSettingsPath } from "../config/system-paths";
import { useAdapters } from "../hooks/useAdapters";
import { useBackendReachable } from "../hooks/useBackendReachable";
import { useExtensions } from "../hooks/useExtensions";
import { useProblems } from "../hooks/useProblems";
import { useSources } from "../hooks/useSources";
import { useT, useTextOptions } from "../i18n";
import { api } from "../services/api";
import type { Subscription } from "../types/domain";

const PROBLEMS_HASH = "#problems";
export function ProblemBox() {
	const t = useT(),
		navigate = useNavigate(),
		location = useLocation();
	const query = useProblems(),
		reachable = useBackendReachable();
	const anchor = useRef<HTMLDivElement>(null),
		panel = useRef<HTMLDivElement>(null);
	const [anchored, setAnchored] = useState(false);
	useLayoutEffect(() => setAnchored(true), []);
	const open = location.hash === PROBLEMS_HASH;
	const close = () => navigate({ hash: "" }, { replace: true });
	useDismiss(panel, close, { enabled: open, insideRefs: [anchor] });
	const known = reachable && !query.isError && !!query.data && Array.isArray(query.data.problems);
	const label = !known
		? t("problems.unknown")
		: query.data.problems.length
			? t("problems.count", { count: query.data.problems.length })
			: t("problems.empty");
	return (
		<div ref={anchor} className="relative">
			<Btn
				size="sm"
				variant="ghost"
				icon={
					<span className="bn-header-compact-icon">
						{known && query.data.problems.length === 0 ? (
							<Icon.bell size={16} />
						) : (
							<Icon.warning size={16} />
						)}
					</span>
				}
				aria-label={label}
				title={label}
				aria-expanded={open}
				onClick={() => (open ? close() : navigate({ hash: PROBLEMS_HASH }))}
			>
				<span className="bn-header-action-label">{label}</span>
				{known && query.data.problems.length > 0 ? (
					<span className="bn-header-problem-count" aria-hidden="true">
						{query.data.problems.length > 99 ? "99+" : query.data.problems.length}
					</span>
				) : null}
			</Btn>
			{open && anchored ? (
				<PopoverShell
					ref={panel}
					anchorRef={anchor}
					preferredWidth={440}
					maxPanelHeight={560}
					align="left"
					variant="panel"
					surface="glass"
					layer="overlay"
					role="dialog"
					ariaLabel={t("problems.title")}
					className="w-96 max-h-[70vh] overflow-y-auto"
				>
					<div className="mb-3 flex items-center justify-between gap-3">
						<h2 className="text-bn-base font-bold">{t("problems.title")}</h2>
						<IconButton
							icon={<Icon.close size={14} />}
							label={t("problems.close")}
							onClick={close}
						/>
					</div>
					{!known ? (
						query.isPending ? (
							<LoadingBlock variant="inset" label={t("problems.loading")} />
						) : (
							<ErrorNote>
								{t("problems.failed")}
								<Btn variant="ghost" size="sm" onClick={() => void query.refetch()}>
									{t("problems.retry")}
								</Btn>
							</ErrorNote>
						)
					) : query.data.problems.length === 0 ? (
						<p className="text-bn-sm text-bn-text-secondary">{t("problems.empty")}</p>
					) : (
						<ProblemRows problems={query.data.problems} onClose={close} />
					)}
					<p className="mt-3 border-t border-bn-border-subtle pt-2 text-bn-xs text-bn-text-secondary">
						{t("problems.separate")}
					</p>
				</PopoverShell>
			) : null}
		</div>
	);
}
export function ProblemRows({
	problems,
	onClose,
}: {
	problems: ProblemsResponse["problems"];
	onClose: () => void;
}) {
	const t = useT();
	const { locale } = useTextOptions();
	const sources = useSources().data?.sources,
		adapters = useAdapters().data?.adapters,
		extensions = useExtensions().data?.extensions;
	const subs = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subscriptions"),
		retry: false,
	}).data;
	const connections = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<ConnectionView[]>("/api/connections"),
		retry: false,
	}).data;
	return (
		<ul className="space-y-3">
			{problems.map((problem) => {
				const subId =
					problem.about && "subscriptionId" in problem.about
						? problem.about.subscriptionId
						: undefined;
				const connectionId =
					problem.about && "connectionId" in problem.about ? problem.about.connectionId : undefined;
				const extension = extensions?.find((e) => e.id === problem.reporter);
				const source = sources?.find((s) => s.key === problem.reporter),
					adapter = adapters?.find((a) => a.key === problem.reporter);
				const owner =
					problem.reporter === "core"
						? t("healthCard.core")
						: (extension?.name ??
							source?.descriptor.label ??
							adapter?.descriptor.label ??
							problem.reporter);
				const sub = subs?.find((s) => s.id === subId),
					connection = connections?.find((c) => c.id === connectionId);
				const objectName = sub?.cachedProfile?.name ?? connection?.name ?? subId ?? connectionId;
				const path = sub
					? `/subs?open=${encodeURIComponent(sub.id)}`
					: connection
						? "/targets"
						: extension
							? `/extensions/${encodeURIComponent(extension.id)}`
							: source
								? integrationSettingsPath(source.key)
								: adapter
									? "/targets"
									: "/logs";
				return (
					<li
						key={JSON.stringify([problem.reporter, problem.about, problem.code])}
						className="rounded-bn-card bg-bn-surface/60 p-3 text-bn-xs"
					>
						<div className="font-semibold break-words">{owner}</div>
						{objectName ? (
							<p className="mt-1 break-all text-bn-text-secondary">{objectName}</p>
						) : null}
						<p className="mt-2 whitespace-pre-wrap break-words text-bn-sm">{problem.message}</p>
						<p className="mt-2 break-all text-bn-text-tertiary">
							{problem.code} ·{" "}
							<time dateTime={problem.since}>{new Date(problem.since).toLocaleString(locale)}</time>
						</p>
						<Link to={path} onClick={onClose} className="mt-2 inline-flex text-bn-pink underline">
							{path === "/logs" ? t("healthCard.viewLogs") : t("problems.manage")}
						</Link>
					</li>
				);
			})}
		</ul>
	);
}
