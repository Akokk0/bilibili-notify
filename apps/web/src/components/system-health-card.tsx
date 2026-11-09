import type {
	AccountView,
	CoreHealthView,
	HealthLightStatus,
	HealthResponse,
	IntegrationHealthView,
	SourceEntry,
	UpdateStatusView,
} from "@bilibili-notify/contract";
import { subscriptionIdentityLabel } from "@bilibili-notify/contract";
import { formatDuration } from "@bilibili-notify/internal/format";
import {
	Btn,
	DisclosurePill,
	EmptyNote,
	ErrorNote,
	GlassBox,
	Icon,
	LoadingBlock,
	ModalShell,
	Pill,
	StatusDot,
} from "@bilibili-notify/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AUTH_STATUS_LABELS, authMessageOf } from "../config/auth-status";
import { LOG_LEVEL_TONE } from "../config/log-levels";
import { integrationSettingsPath } from "../config/system-paths";
import { useAccounts } from "../hooks/useAccounts";
import { HEALTH_QUERY_KEY } from "../hooks/useBackendReachable";
import { useCardContentHeight } from "../hooks/useCardContentHeight";
import { HEALTH_DETAILS_QUERY_OPTIONS } from "../hooks/useHealthDetails";
import { useProblems } from "../hooks/useProblems";
import { useCoreSettings } from "../hooks/useSettings";
import { useSources } from "../hooks/useSources";
import { useT, useTextOptions } from "../i18n";
import { EXTENSION_STATE_META } from "../pages/extensions/state-meta";
import { AccountFace, accountPath } from "./accounts/account-face";
import { DescriptorIcon } from "./platform-meta";
import { ProblemRows } from "./problem-box";
import { newerVersionOf, phaseLabel, UPDATE_SECTION_PATH } from "./update/status";

const LIGHT_KIND = {
	green: "ok",
	orange: "warn",
	red: "err",
	gray: "off",
} as const satisfies Record<HealthLightStatus, string>;
const INTEGRATION_GRID =
	"grid grid-cols-1 gap-x-3 @min-[421px]/health:grid-cols-2 @min-[600px]/health:grid-cols-3 @min-[800px]/health:grid-cols-4 @min-[1000px]/health:grid-cols-5";
const CORE_META = {
	storage: { path: "/system#storage", logKey: "core" },
	subscription: { path: "/subs", logKey: "core" },
	push: { path: "/targets", logKey: "core" },
	image: { path: "/cards", logKey: "image" },
	ai: { path: "/ai", logKey: "ai" },
} as const;

export function SystemHealthCard({
	health,
	reachable,
	update,
	onDefaultHeightChange,
}: {
	health: HealthResponse | undefined;
	reachable: boolean;
	update?: UpdateStatusView;
	onDefaultHeightChange?: (height: number) => void;
}) {
	const t = useT();
	const { locale } = useTextOptions();
	const content = useCardContentHeight(onDefaultHeightChange, "[data-health-expansion]");
	const qc = useQueryClient();
	const countId = useId();
	const [selection, setSelection] = useState<
		| { type: "core"; key: CoreHealthView["key"] }
		| { type: "integration"; key: string }
		| { type: "problems"; reporter?: string }
		| null
	>(null);
	const selectedCore = selection?.type === "core" ? selection.key : null;
	const accounts = useAccounts({ enabled: reachable });
	const sources = useSources({ enabled: reachable });
	function accountOf(item: IntegrationHealthView): HealthAccountView | undefined {
		if (item.sourceKey === undefined) return;
		const source = sources.isError
			? undefined
			: sources.data?.sources?.find((one) => one.key === item.sourceKey);
		const cached = accounts.data?.accounts?.find((one) => one.sourceKey === item.sourceKey);
		if (source?.has?.auth === false || (source?.has?.auth !== true && !cached)) return;
		const account = accounts.isSuccess && !accounts.isError ? cached : undefined;
		return {
			sourceKey: item.sourceKey,
			source,
			account,
			label: accounts.isError
				? t("accounts.readFailedTitle")
				: accounts.isPending
					? t("accounts.loading")
					: account
						? AUTH_STATUS_LABELS[account.state.status]
						: t("healthCard.accountUnknown"),
		};
	}

	const [facts, setFacts] = useState(false);
	const [more, setMore] = useState(false);
	const [duplicatesOpen, setDuplicatesOpen] = useState(false);
	const problems = useProblems();
	function openProblems(reporter?: string) {
		void problems.refetch();
		setSelection({ type: "problems", reporter });
	}
	const shownProblems = problems.data?.problems?.filter(
		(one) =>
			selection?.type !== "problems" ||
			selection.reporter === undefined ||
			one.reporter === selection.reporter,
	);
	const settings = useCoreSettings();
	const logging = settings.isSuccess && !settings.isError ? settings.data?.logging : undefined;
	const query = useQuery(HEALTH_DETAILS_QUERY_OPTIONS);
	const details =
		reachable && !query.isError && query.data?.phase === "running" ? query.data : undefined;
	const coreItems: CoreHealthView[] = details
		? (Object.keys(CORE_META) as CoreHealthView["key"][]).map(
				(key) =>
					details.core.items.find((item) => item.key === key) ?? {
						key,
						status: "unknown",
						light: "gray",
						version: details.moduleVersions[key],
					},
			)
		: [];

	const coreLabels = {
		storage: t("healthCard.storage"),
		subscription: t("healthCard.subscription"),
		push: t("healthCard.push"),
		image: t("healthCard.image"),
		ai: t("healthCard.ai"),
	};
	const label = (item: CoreHealthView) => coreLabels[item.key];
	const state = (item: CoreHealthView) =>
		item.status === "running"
			? t("healthCard.running")
			: item.status === "not-ready"
				? t("healthCard.notReady")
				: t("healthCard.unknown");
	const integrationStatus = (item: IntegrationHealthView) =>
		item.status === "running"
			? t("healthCard.running")
			: item.status === "unknown"
				? t("healthCard.unknown")
				: EXTENSION_STATE_META[item.status].label;
	const integrationKind = (kind: IntegrationHealthView["kind"]) =>
		kind === "extension"
			? t("healthCard.extension")
			: kind === "builtin-source"
				? t("healthCard.builtinSource")
				: t("healthCard.builtinAdapter");
	const unavailableLabel = !reachable
		? t("healthCard.offline")
		: query.isError
			? t("healthCard.readFailed")
			: query.data && query.data.phase !== "running"
				? t("healthCard.starting")
				: t("healthCard.loading");

	const selectedIntegration =
		selection?.type === "integration"
			? details?.integrations.find((item) => item.key === selection.key)
			: undefined;
	const selected = coreItems.find((item) => item.key === selectedCore);
	const updateLabel = reachable && update && newerVersionOf(update) ? phaseLabel(update) : null;
	const integrationTiles = (items: IntegrationHealthView[]) => (
		<div className={INTEGRATION_GRID}>
			{items.map((item) => (
				<button
					type="button"
					key={item.key}
					onClick={() => setSelection({ type: "integration", key: item.key })}
					data-bn="option"
					aria-haspopup="dialog"
					className="flex min-w-0 flex-col gap-1.5 rounded-lg p-2 text-left active:opacity-70 hover:bg-bn-surface-muted focus-visible:outline-2 focus-visible:outline-bn-pink"
					aria-label={t("healthCard.openItem", {
						name: item.descriptor.label,
						status: integrationStatus(item),
					})}
				>
					<span className="flex min-w-0 items-center gap-2">
						<DescriptorIcon
							descriptor={{
								...item.descriptor,
								shortLabel: item.descriptor.shortLabel ?? item.descriptor.label,
								color: item.descriptor.color ?? "var(--color-bn-blue)",
							}}
							size={19}
						/>
						<span className="min-w-0 flex-1 truncate text-bn-xs font-semibold">
							{item.descriptor.label}
						</span>
						<Icon.chevronRight size={11} />
					</span>
					<span className="flex flex-wrap items-center gap-1.5 text-bn-2xs text-bn-text-secondary">
						<StatusDot kind={LIGHT_KIND[item.light]} size="sm" />
						{integrationStatus(item)}
						{item.problemCount > 0 ? (
							<span className="ml-auto text-bn-text-primary">
								{t("healthCard.problemsCount", { count: item.problemCount })}
							</span>
						) : null}
					</span>
					<span className="line-clamp-2 break-words text-bn-2xs leading-relaxed text-bn-text-secondary">
						{item.failure?.message ??
							(item.health && !item.health.ok
								? t("healthCard.summaryFailed")
								: item.connectionCount > 0
									? t("healthCard.connectionCount", { count: item.connectionCount })
									: item.health?.ok
										? item.health.summary
										: null)}
					</span>
					{accountOf(item) ? <AccountSummary info={accountOf(item)} /> : null}
				</button>
			))}
		</div>
	);
	return (
		<>
			<section
				aria-label={t("healthCard.title")}
				className="@container/health flex min-w-0 flex-col"
			>
				<GlassBox
					className="@min-[1104px]/system-row:min-h-[var(--system-default-height,0px)]"
					title={t("healthCard.title")}
					subtitle={t("healthCard.subtitle")}
					accent="var(--color-bn-success)"
					icon={<Icon.pulse size={16} />}
					right={
						details ? (
							details.problemCount > 0 ? (
								<Btn size="sm" variant="outline" onClick={() => openProblems()}>
									{t("healthCard.openProblems", { count: details.problemCount })}
								</Btn>
							) : (
								<span className="inline-flex items-center gap-1.5 whitespace-nowrap text-bn-2xs text-bn-text-secondary">
									<StatusDot kind="ok" size="sm" />
									{t("healthCard.noProblems")}
								</span>
							)
						) : undefined
					}
				>
					<div ref={content} className="flow-root">
						{details ? (
							<>
								<div className="mb-2 flex items-center justify-between">
									<h2 className="text-bn-xs font-semibold">{t("healthCard.core")}</h2>
									{details.core.problemCount > 0 ? (
										<Btn size="sm" variant="ghost" onClick={() => openProblems("core")}>
											{t("healthCard.coreProblemsCount", { count: details.core.problemCount })}
										</Btn>
									) : (
										<span className="text-bn-2xs text-bn-text-tertiary">
											{t("healthCard.fixed")}
										</span>
									)}
								</div>
								<div className="grid grid-cols-5 gap-1 border-b border-bn-border-subtle pb-3.5">
									{coreItems.map((item) => (
										<button
											key={item.key}
											onClick={() => setSelection({ type: "core", key: item.key })}
											data-bn="option"
											aria-haspopup="dialog"
											aria-describedby={
												item.count === undefined ? undefined : `${countId}-${item.key}`
											}
											type="button"
											className="flex min-h-[54px] min-w-0 flex-col items-center gap-1.5 rounded-lg py-2 text-bn-xs active:opacity-70 hover:bg-bn-surface-muted focus-visible:outline-2 focus-visible:outline-bn-pink"
											aria-label={t("healthCard.openItem", {
												name: label(item),
												status: state(item),
											})}
										>
											<span className="inline-flex items-center gap-1 font-semibold">
												<StatusDot kind={LIGHT_KIND[item.light]} size="sm" />
												{label(item)}
											</span>
											<span
												id={`${countId}-${item.key}`}
												title={item.count?.toLocaleString(locale)}
												className="max-w-full truncate text-bn-2xs text-bn-text-secondary"
											>
												{item.count === undefined
													? state(item)
													: item.key === "subscription"
														? t("healthCard.subscriptionCount", { count: item.count })
														: t("healthCard.targetCount", { count: item.count })}
											</span>
										</button>
									))}
								</div>
								<div className="mb-2 mt-3.5 flex items-center justify-between gap-2">
									<h2 className="text-bn-xs font-semibold">
										{t("healthCard.integrations")}{" "}
										<span className="ml-1 font-normal text-bn-text-tertiary">
											{details.integrations.length}
										</span>
									</h2>
									<span className="text-bn-2xs text-bn-text-tertiary">
										{t("healthCard.actualIntegrations")}
									</span>
								</div>
								{details.integrations.length === 0 ? (
									<EmptyNote>
										<div className="flex flex-col items-center gap-2 py-2">
											<Icon.extension size={22} />
											<strong>{t("healthCard.emptyIntegrations")}</strong>
											<p className="text-bn-2xs">{t("healthCard.emptyHint")}</p>
											<Link to="/extensions">
												<Btn size="sm" variant="outline">
													{t("healthCard.viewExtensions")}
												</Btn>
											</Link>
										</div>
									</EmptyNote>
								) : (
									<>
										{integrationTiles(details.integrations.slice(0, 5))}
										<div data-health-expansion className="flow-root">
											{more && details.integrations.length > 5 ? (
												<div className="pt-2">
													{integrationTiles(details.integrations.slice(5))}
												</div>
											) : null}
										</div>
									</>
								)}
								{details.integrations.length > 5 ? (
									<div className="mt-2 text-center">
										<DisclosurePill open={more} onToggle={() => setMore(!more)}>
											{more
												? t("healthCard.collapseIntegrations")
												: t("healthCard.moreIntegrations", {
														count: details.integrations.length - 5,
													})}
										</DisclosurePill>
									</div>
								) : null}
							</>
						) : (
							<div className="flex min-h-56 flex-col items-center justify-center gap-3 py-6 text-center text-bn-sm text-bn-text-secondary">
								{!reachable || query.isError ? (
									<ErrorNote className="w-full">
										<p>{unavailableLabel}</p>
										<div className="mt-3">
											<Btn
												variant="outline"
												size="sm"
												onClick={() => void qc.invalidateQueries({ queryKey: HEALTH_QUERY_KEY })}
											>
												{t("healthCard.retry")}
											</Btn>
										</div>
									</ErrorNote>
								) : (
									<>
										<Icon.pulse size={24} />
										<p>{unavailableLabel}</p>
										<Btn
											variant="outline"
											size="sm"
											onClick={() => void qc.invalidateQueries({ queryKey: HEALTH_QUERY_KEY })}
										>
											{t("healthCard.retry")}
										</Btn>
									</>
								)}
							</div>
						)}
						{details && details.identityDuplicates.length > 0 ? (
							<div className="mt-3 border-t border-bn-border-subtle pt-3 text-bn-xs">
								<div className="flex items-center gap-2">
									<Icon.info size={14} />
									<span className="min-w-0 flex-1">
										{t("healthCard.duplicateSummary", { count: details.identityDuplicates.length })}
									</span>
									<DisclosurePill
										open={duplicatesOpen}
										onToggle={() => setDuplicatesOpen(!duplicatesOpen)}
									>
										{duplicatesOpen ? t("healthCard.collapse") : t("healthCard.view")}
									</DisclosurePill>
								</div>
								<div data-health-expansion className="flow-root">
									{duplicatesOpen ? (
										<div className="mt-3 space-y-3">
											{details.identityDuplicates.map((group) => {
												const descriptor = sources.isError
													? undefined
													: sources.data?.sources?.find(
															(source) => source.key === group.identity.sourceKey,
														)?.descriptor;
												const identity = subscriptionIdentityLabel(
													group.identity,
													descriptor ?? { label: group.identity.sourceKey },
												);
												return (
													<div
														key={JSON.stringify([
															group.identity.sourceKey,
															group.identity.externalId,
														])}
														className="min-w-0 pl-5 text-bn-text-secondary"
													>
														<strong className="break-words text-bn-text-primary">
															{group.name || identity}
														</strong>
														{group.name ? <p className="mt-1 break-all">{identity}</p> : null}
														<p className="my-2 leading-relaxed">{t("healthCard.duplicateHint")}</p>
														<div className="flex flex-wrap gap-x-4 gap-y-2">
															{group.subscriptionIds.map((id) => (
																<Link
																	key={id}
																	to={`/subs?open=${encodeURIComponent(id)}`}
																	className="inline-flex min-w-0 items-center gap-1 break-all text-bn-pink focus-visible:outline-2 focus-visible:outline-bn-pink"
																>
																	{id}
																	<Icon.chevronRight size={10} />
																</Link>
															))}
														</div>
													</div>
												);
											})}
										</div>
									) : null}
								</div>
							</div>
						) : null}

						<div className="mt-4 flex items-center justify-between gap-2 border-t border-bn-border-subtle pt-3 text-bn-2xs text-bn-text-tertiary">
							<span>
								{reachable && health
									? t("healthCard.uptime", { value: formatDuration(0, health.uptime * 1000) })
									: t("healthCard.statePending")}
							</span>
							<DisclosurePill open={facts} onToggle={() => setFacts(!facts)}>
								{t("healthCard.facts")} {facts ? "−" : "＋"}
							</DisclosurePill>
						</div>
						<div data-health-expansion className="flow-root">
							{facts ? (
								<dl className="mt-2 space-y-2 text-bn-xs">
									<Fact label={t("healthCard.serverVersion")}>{health?.version ?? "—"}</Fact>
									<Fact label={t("healthCard.webVersion")}>{__WEB_VERSION__}</Fact>
									<Fact label={t("healthCard.defaultLog")}>
										<LogValue level={logging?.level} />
									</Fact>
								</dl>
							) : null}
						</div>
						{updateLabel ? (
							<div className="mt-3 flex items-center justify-between gap-2 border-t border-bn-border-subtle pt-3">
								<span className="text-bn-xs text-bn-text-secondary">{updateLabel}</span>
								<Link to={UPDATE_SECTION_PATH}>
									<Btn size="sm" variant="outline">
										{t("healthCard.update")}
									</Btn>
								</Link>
							</div>
						) : null}
					</div>
				</GlassBox>
			</section>
			{selectedCore !== null ? (
				<HealthDialog
					key={`core:${selectedCore}`}
					title={coreLabels[selectedCore]}
					onClose={() => setSelection(null)}
				>
					{selected ? (
						<>
							<div className="flex items-center gap-2 text-bn-sm">
								<StatusDot kind={LIGHT_KIND[selected.light]} />
								<strong>{state(selected)}</strong>
							</div>
							{selected.status === "not-ready" ? (
								<p className="mt-3 text-bn-sm leading-relaxed text-bn-text-secondary">
									{t("healthCard.notReadyHint")}
								</p>
							) : null}
							<dl className="mt-3 space-y-3 text-bn-xs">
								<Fact label={t("healthCard.moduleVersion")}>{selected.version}</Fact>
								<Fact label={t("healthCard.effectiveLog")}>
									<LogValue
										level={logging?.levels?.[CORE_META[selectedCore].logKey] ?? logging?.level}
									/>
								</Fact>
								<Fact label={t("healthCard.logSource")}>
									{logging
										? logging.levels?.[
												selectedCore === "storage" ||
												selectedCore === "subscription" ||
												selectedCore === "push"
													? "core"
													: selectedCore
											]
											? t("healthCard.overridden")
											: t("healthCard.inherited")
										: "—"}
								</Fact>
							</dl>
							<div className="mt-5 flex flex-wrap gap-2">
								{details && details.core.problemCount > 0 ? (
									<Btn size="sm" variant="outline" onClick={() => openProblems("core")}>
										{t("healthCard.coreProblemsCount", { count: details.core.problemCount })}
									</Btn>
								) : null}
								<Link to={CORE_META[selectedCore].path}>
									<Btn size="sm" variant="outline">
										{t("healthCard.manage")}
									</Btn>
								</Link>
								<Link to="/logs">
									<Btn size="sm" variant="ghost">
										{t("healthCard.viewLogs")}
									</Btn>
								</Link>
							</div>
						</>
					) : (
						<p className="text-bn-sm text-bn-text-secondary">{t("healthCard.statePending")}</p>
					)}
				</HealthDialog>
			) : null}
			{selection?.type === "integration" ? (
				<HealthDialog
					key={`integration:${selection.key}`}
					title={selectedIntegration?.descriptor.label ?? selection.key}
					onClose={() => setSelection(null)}
				>
					{selectedIntegration ? (
						<>
							<div className="flex flex-wrap items-center gap-2 text-bn-sm">
								<StatusDot kind={LIGHT_KIND[selectedIntegration.light]} />
								<strong>{integrationStatus(selectedIntegration)}</strong>
								<span className="ml-auto text-bn-xs text-bn-text-secondary">
									{integrationKind(selectedIntegration.kind)}
								</span>
							</div>
							{selectedIntegration.failure ? (
								<p className="mt-3 break-words text-bn-sm leading-relaxed text-bn-danger">
									{selectedIntegration.failure.message}
								</p>
							) : null}
							{selectedIntegration.health ? (
								<p className="mt-3 break-words text-bn-sm leading-relaxed text-bn-text-secondary">
									{selectedIntegration.health.ok
										? selectedIntegration.health.summary
										: selectedIntegration.health.message}
								</p>
							) : null}
							{selectedIntegration.health && !selectedIntegration.health.ok ? (
								<p className="mt-3 border-l-2 border-bn-warning pl-2.5 text-bn-xs leading-relaxed text-bn-text-secondary">
									{t("healthCard.summaryFailureHint")}
								</p>
							) : null}
							<dl className="mt-3 space-y-3 text-bn-xs">
								<Fact label={t("healthCard.provides")}>
									{selectedIntegration.provides === undefined
										? t("healthCard.unknown")
										: selectedIntegration.provides
												.map((one) =>
													one === "subscription"
														? t("extensions.provides.subscription")
														: t("extensions.provides.push"),
												)
												.join(" · ")}
								</Fact>
								<Fact label={t("healthCard.integrationKey")}>{selectedIntegration.key}</Fact>
								<Fact label={t("healthCard.connections")}>
									{selectedIntegration.connectionCount}
								</Fact>
								<Fact label={t("healthCard.effectiveLog")}>
									<LogValue level={logging?.levels?.[selectedIntegration.key] ?? logging?.level} />
								</Fact>
								<Fact label={t("healthCard.logSource")}>
									{logging
										? logging.levels?.[selectedIntegration.key]
											? t("healthCard.overridden")
											: t("healthCard.inherited")
										: "—"}
								</Fact>
							</dl>
							{accountOf(selectedIntegration) ? (
								<AccountSummary info={accountOf(selectedIntegration)} detail />
							) : null}
							<div className="mt-5 flex flex-wrap gap-2">
								{selectedIntegration.problemCount > 0 ? (
									<Btn
										size="sm"
										variant="outline"
										onClick={() => openProblems(selectedIntegration.key)}
									>
										{t("healthCard.openProblems", { count: selectedIntegration.problemCount })}
									</Btn>
								) : null}
								<Link
									to={
										selectedIntegration.kind === "extension"
											? `/extensions/${encodeURIComponent(selectedIntegration.key)}`
											: selectedIntegration.kind === "builtin-source"
												? integrationSettingsPath(selectedIntegration.key)
												: "/targets"
									}
								>
									<Btn size="sm" variant="outline">
										{t("healthCard.integrationSettings")}
									</Btn>
								</Link>
								<Link to="/logs">
									<Btn size="sm" variant="ghost">
										{t("healthCard.viewLogs")}
									</Btn>
								</Link>
							</div>
						</>
					) : (
						<p className="text-bn-sm text-bn-text-secondary">{t("healthCard.statePending")}</p>
					)}
				</HealthDialog>
			) : null}
			{selection?.type === "problems" ? (
				<HealthDialog
					key={`problems:${selection.reporter ?? "all"}`}
					title={selection.reporter === "core" ? t("healthCard.coreProblems") : t("problems.title")}
					onClose={() => setSelection(null)}
				>
					{!reachable ||
					problems.isError ||
					(!problems.isPending && shownProblems === undefined) ? (
						<ErrorNote>
							{t("problems.failed")}
							<Btn
								size="sm"
								variant="ghost"
								onClick={() => {
									void problems.refetch();
									if (!reachable) void qc.invalidateQueries({ queryKey: HEALTH_QUERY_KEY });
								}}
							>
								{t("problems.retry")}
							</Btn>
						</ErrorNote>
					) : problems.isPending ? (
						<LoadingBlock variant="inset" label={t("problems.loading")} />
					) : shownProblems?.length ? (
						<ProblemRows problems={shownProblems} onClose={() => setSelection(null)} />
					) : (
						<p className="text-bn-sm text-bn-text-secondary">{t("problems.empty")}</p>
					)}
				</HealthDialog>
			) : null}
		</>
	);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-4">
			<dt className="shrink-0 text-bn-text-secondary">{label}</dt>
			<dd className="min-w-0 break-words text-right text-bn-text-primary">{children}</dd>
		</div>
	);
}
function LogValue({ level }: { level: import("@bilibili-notify/contract").LogLevel | undefined }) {
	return level ? (
		<Pill color={LOG_LEVEL_TONE[level]} size="sm" subtle>
			{level.toUpperCase()}
		</Pill>
	) : (
		<>—</>
	);
}
function HealthDialog({
	title,
	children,
	onClose,
}: {
	title: string;
	children: ReactNode;
	onClose: () => void;
}) {
	const t = useT();
	const body = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		body.current?.focus();
		const onTab = (event: KeyboardEvent) => {
			if (event.key !== "Tab") return;
			const items = Array.from(
				body.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], summary") ??
					[],
			);
			const first = items[0],
				last = items.at(-1);
			const current = document.activeElement;
			if (!first) {
				event.preventDefault();
				body.current?.focus();
			} else if (!items.includes(current as HTMLElement)) {
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
	return (
		<ModalShell title={title} width={480} onCancel={onClose}>
			<div ref={body} tabIndex={-1} role="document" aria-label={title} className="outline-none">
				{children}
				<div className="mt-6 flex justify-end border-t border-bn-border-subtle pt-3.5">
					<Btn size="sm" variant="outline" onClick={onClose}>
						{t("healthCard.close")}
					</Btn>
				</div>
			</div>
		</ModalShell>
	);
}

type HealthAccountView = {
	sourceKey: string;
	source?: SourceEntry;
	account?: AccountView;
	label: string;
};
function AccountSummary({
	info,
	detail = false,
}: {
	info: HealthAccountView | undefined;
	detail?: boolean;
}) {
	const t = useT();
	if (!info) return null;
	const name = info.account?.state.status === "logged-in" ? info.account.account?.name : undefined;
	return detail ? (
		<div className="mt-4 flex items-center gap-2.5 border-y border-bn-border-subtle py-3 text-bn-xs">
			<AccountFace account={info.account} source={info.source} size={24} />
			<div className="min-w-0 flex-1">
				<strong>{name ?? info.label}</strong>
				{name ? <p className="mt-1 text-bn-text-secondary">{info.label}</p> : null}
				{info.account && authMessageOf(info.account.state) ? (
					<p className="mt-1 break-words text-bn-text-secondary">
						{authMessageOf(info.account.state)}
					</p>
				) : null}
			</div>
			<Link to={accountPath(info.sourceKey)}>
				<Btn variant="ghost" size="sm">
					{t("healthCard.account")}
				</Btn>
			</Link>
		</div>
	) : (
		<span className="flex min-w-0 items-center gap-1.5 text-bn-2xs text-bn-text-secondary">
			<Icon.user size={11} />
			<span className="truncate">{name ? `${name} · ${info.label}` : info.label}</span>
		</span>
	);
}
