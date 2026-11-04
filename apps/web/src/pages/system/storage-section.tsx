import type {
	ClearableStorageCategory,
	GenerationDeleteResponse,
	GenerationInfo,
	GenerationsResponse,
	ImageSweepResponse,
	SettingsResponse,
	StorageCategory,
	StorageClearResponse,
	StorageUsageResponse,
	StorageUsageRow,
} from "@bilibili-notify/contract";
import { HISTORY_RETENTION_DAY_OPTIONS } from "@bilibili-notify/internal/history";
import {
	BELOW_HEADER_TOP,
	Btn,
	ConfirmDialog,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	LoadingBlock,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Field, Picker } from "../../components/forms";
import { useT, useTextOptions } from "../../i18n";
import { api } from "../../services/api";
import type { SettingsPatch } from "../../types/globals";
import { generationLockText, storageCategoryText, storageClearScope } from "./storage-texts";

type ClearableRow = StorageUsageRow & { category: ClearableStorageCategory };
type StorageAction =
	| { kind: "clear"; row: ClearableRow }
	| { kind: "generation"; generation: GenerationInfo }
	| { kind: "sweep" };
type StorageActionResult =
	| (StorageClearResponse & { kind: "clear" | "generation" })
	| (ImageSweepResponse & { kind: "sweep" });

function canClear(row: StorageUsageRow): row is ClearableRow {
	return row.clearable && ["stats", "historyText", "historyImages", "ai"].includes(row.category);
}

const CATEGORY_ORDER: readonly StorageCategory[] = [
	"stats",
	"historyText",
	"historyImages",
	"ai",
	"logs",
	"otherImages",
	"generations",
];

function bytes(value: number, locale: string): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[index]}`;
}

/** Opened on demand: measuring storage traverses the data tree, so it must not poll in the background. */
export function StorageSection({
	draft,
	onPatch,
}: {
	draft: SettingsResponse | null;
	onPatch: (patch: SettingsPatch) => void;
}) {
	const t = useT();
	const { locale } = useTextOptions();
	const qc = useQueryClient();
	const [confirming, setConfirming] = useState<StorageAction | null>(null);
	const feedbackRef = useRef<HTMLDivElement>(null);
	const usage = useQuery({
		queryKey: ["system", "storage"],
		queryFn: () => api.get<StorageUsageResponse>("/api/system/storage"),
		staleTime: 0,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const generations = useQuery({
		queryKey: ["system", "generations"],
		queryFn: () => api.get<GenerationsResponse>("/api/system/generations"),
		staleTime: 0,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const refreshing = usage.isFetching || generations.isFetching;
	const action = useMutation({
		mutationFn: async (input: StorageAction): Promise<StorageActionResult> => {
			if (input.kind === "sweep")
				return {
					kind: "sweep",
					...(await api.post<ImageSweepResponse>("/api/system/storage/images/sweep")),
				};
			if (input.kind === "generation") {
				return {
					kind: "generation",
					...(await api.delete<GenerationDeleteResponse>(
						`/api/system/generations/${input.generation.seq}`,
					)),
				};
			}
			return {
				kind: "clear",
				...(await api.delete<StorageClearResponse>(`/api/system/storage/${input.row.category}`)),
			};
		},
		onSuccess: async (_result, input) => {
			await Promise.all([
				qc.invalidateQueries({ queryKey: ["system", "storage"] }),
				qc.invalidateQueries({ queryKey: ["system", "generations"] }),
				...(input.kind === "clear"
					? [
							qc.invalidateQueries({
								queryKey: [
									input.row.category === "stats"
										? "stats"
										: input.row.category === "ai"
											? "ai"
											: "history",
								],
							}),
						]
					: []),
			]);
		},
		onError: async (_error, input) => {
			// A protection check may have changed since the list was measured; the server remains authoritative.
			if (input.kind === "generation")
				await Promise.all([
					qc.invalidateQueries({ queryKey: ["system", "storage"] }),
					qc.invalidateQueries({ queryKey: ["system", "generations"] }),
				]);
		},
	});
	const busy = refreshing || action.isPending;
	const actionStatus = action.status;
	useEffect(() => {
		if (actionStatus !== "idle") feedbackRef.current?.scrollIntoView({ block: "nearest" });
	}, [actionStatus]);
	const feedback =
		actionStatus === "idle" ? null : (
			<div ref={feedbackRef} style={{ scrollMarginTop: BELOW_HEADER_TOP }} className="mb-3">
				{action.error ? (
					<ErrorNote>{t("storageUsage.actionFailed", { reason: action.error.message })}</ErrorNote>
				) : null}
				{action.isPending ? (
					<div role="status">
						<HintNote>{t("storageUsage.working")}</HintNote>
					</div>
				) : null}
				{action.data ? (
					<div role="status">
						<HintNote>
							{action.data.kind === "sweep"
								? t("storageUsage.sweepDone", {
										count: action.data.removedCount,
										bytes: bytes(action.data.removedBytes, locale),
										referenced: action.data.referenced,
										inGrace: action.data.inGrace,
									})
								: action.data.kind === "clear"
									? t("storageUsage.clearDone", { bytes: bytes(action.data.freedBytes, locale) })
									: t("storageUsage.generationDone", {
											bytes: bytes(action.data.freedBytes, locale),
										})}
						</HintNote>
					</div>
				) : null}
			</div>
		);
	return (
		<>
			{draft ? (
				<GlassBox
					title={t("storageUsage.retentionTitle")}
					subtitle={t("storageUsage.retentionHint")}
					icon={<Icon.history size={14} />}
				>
					{/* 只许七档:选项个数固定,用段选钮组,不用下拉。 */}
					<Field code="core.history.retentionDays" full>
						<Picker
							value={draft.core.history.retentionDays}
							onChange={(v) => onPatch({ core: { history: { retentionDays: v } } })}
							options={HISTORY_RETENTION_DAY_OPTIONS.map((days) => ({
								value: days,
								label: t("logging.retentionDays", { count: days }),
							}))}
						/>
					</Field>
				</GlassBox>
			) : null}
			<GlassBox
				title={t("storageUsage.title")}
				subtitle={t("storageUsage.subtitle")}
				icon={<Icon.list size={14} />}
			>
				<div className="mb-4 flex justify-end">
					<Btn
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => {
							void usage.refetch();
							void generations.refetch();
						}}
					>
						<Icon.refresh size={14} />
						{t("storageUsage.refresh")}
					</Btn>
				</div>
				{usage.isPending ? <LoadingBlock label={t("storageUsage.measuring")} /> : null}
				{usage.error ? (
					<ErrorNote>{t("storageUsage.loadFailed", { reason: usage.error.message })}</ErrorNote>
				) : null}
				{action.variables?.kind !== "generation" ? feedback : null}
				<div className="mb-4 space-y-2">
					<Btn
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => {
							action.reset();
							setConfirming({ kind: "sweep" });
						}}
					>
						<Icon.refresh size={14} />
						{t("storageUsage.sweep")}
					</Btn>
					<p className="text-bn-xs text-bn-text-secondary">{t("storageUsage.sweepHint")}</p>
				</div>
				{usage.data ? (
					<ul
						aria-label={t("storageUsage.categories")}
						className="divide-y divide-bn-border-subtle"
					>
						{usage.data.rows
							.toSorted(
								(a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
							)
							.map((row) => (
								<li key={row.category} className="flex flex-wrap items-center gap-3 py-4">
									<div className="min-w-0 flex-1 basis-40">
										<h3 className="text-bn-sm font-semibold text-bn-text-primary">
											{storageCategoryText(row.category).label}
										</h3>
										<p className="mt-1 text-bn-xs text-bn-text-secondary">
											{storageCategoryText(row.category).hint}
										</p>
									</div>
									<span className="whitespace-nowrap text-bn-sm tabular-nums text-bn-text-primary">
										{bytes(row.sizeBytes, locale)}
									</span>
									{canClear(row) ? (
										<Btn
											variant="danger-outline"
											size="sm"
											disabled={busy || !!usage.error}
											aria-label={t("storageUsage.clearCategory", {
												category: storageCategoryText(row.category).label,
											})}
											onClick={() => {
												action.reset();
												setConfirming({ kind: "clear", row });
											}}
										>
											{t("storageUsage.clear")}
										</Btn>
									) : null}
								</li>
							))}
					</ul>
				) : null}
			</GlassBox>
			{confirming ? (
				<ConfirmDialog
					title={
						confirming.kind === "sweep"
							? t("storageUsage.sweep")
							: confirming.kind === "clear"
								? t("storageUsage.clearCategory", {
										category: storageCategoryText(confirming.row.category).label,
									})
								: t("storageUsage.deleteGeneration", { seq: confirming.generation.seq })
					}
					message={
						confirming.kind === "sweep" ? (
							t("storageUsage.sweepConfirm")
						) : confirming.kind === "clear" ? (
							<div className="space-y-3">
								<p>
									{t("storageUsage.clearConfirm", {
										bytes: bytes(confirming.row.sizeBytes, locale),
									})}
								</p>
								<p>{storageClearScope(confirming.row.category)}</p>
								<p>{t("storageUsage.graceHint")}</p>
							</div>
						) : (
							t("storageUsage.deleteConfirm", {
								seq: confirming.generation.seq,
								size: bytes(confirming.generation.sizeBytes, locale),
								reclaimable: bytes(confirming.generation.reclaimableBytes, locale),
							})
						)
					}
					confirmLabel={
						confirming.kind === "sweep"
							? t("storageUsage.confirmSweep")
							: confirming.kind === "clear"
								? t("storageUsage.confirmClear")
								: t("storageUsage.confirmDelete")
					}
					cancelLabel={t("storageUsage.cancel")}
					danger
					onCancel={() => setConfirming(null)}
					onConfirm={() => {
						if (busy) return;
						action.mutate(confirming);
						setConfirming(null);
					}}
				/>
			) : null}
			<section aria-label={t("storageUsage.generations")}>
				<GlassBox
					title={t("storageUsage.generations")}
					subtitle={t("storageUsage.generationsHint")}
					icon={<Icon.history size={14} />}
				>
					{action.variables?.kind === "generation" ? feedback : null}
					{generations.isPending ? <LoadingBlock label={t("storageUsage.measuring")} /> : null}
					{generations.error ? (
						<ErrorNote>
							{t("storageUsage.loadFailed", { reason: generations.error.message })}
						</ErrorNote>
					) : null}
					{generations.data?.generations.length === 0 ? (
						<HintNote>{t("storageUsage.noGenerations")}</HintNote>
					) : null}
					{generations.data?.generations.length ? (
						<ul
							aria-label={t("storageUsage.generationList")}
							className="divide-y divide-bn-border-subtle"
						>
							{generations.data.generations.map((entry) => (
								<li
									key={`${entry.seq}:${entry.partial}`}
									className="flex flex-wrap items-start gap-3 py-4"
								>
									<div className="min-w-0 flex-1 basis-52 space-y-1 text-bn-xs text-bn-text-secondary">
										<h3 className="text-bn-sm font-semibold text-bn-text-primary">
											{t("storageUsage.generation", { seq: entry.seq })}
											{entry.partial ? ` · ${t("storageUsage.partial")}` : ""}
										</h3>
										<p>
											{t("storageUsage.generationVersion", {
												version: entry.createdBy ?? "—",
												format: entry.formatVersion ?? "—",
											})}
										</p>
										<p>
											{t("storageUsage.directoryBytes", { bytes: bytes(entry.sizeBytes, locale) })}
										</p>
										<p>
											{t("storageUsage.reclaimableBytes", {
												bytes: bytes(entry.reclaimableBytes, locale),
											})}
										</p>
										<p>{t("storageUsage.lastActive", { time: entry.lastActiveAt ?? "—" })}</p>
										{entry.lockReason ? <p>{generationLockText(entry.lockReason)}</p> : null}
										{entry.deletableAt ? (
											<p>{t("storageUsage.protectedUntil", { time: entry.deletableAt })}</p>
										) : null}
									</div>
									<Btn
										variant="danger-outline"
										size="sm"
										aria-label={t("storageUsage.deleteGeneration", { seq: entry.seq })}
										disabled={
											busy ||
											!!generations.error ||
											!entry.deletable ||
											entry.current ||
											entry.partial
										}
										onClick={() => {
											action.reset();
											setConfirming({ kind: "generation", generation: entry });
										}}
									>
										{t("storageUsage.delete")}
									</Btn>
								</li>
							))}
						</ul>
					) : null}
				</GlassBox>
			</section>
		</>
	);
}
