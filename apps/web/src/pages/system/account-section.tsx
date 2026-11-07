import type { AccountView, SettingsResponse } from "@bilibili-notify/contract";
import {
	Btn,
	EmptyNote,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	LoadingBlock,
} from "@bilibili-notify/ui";
import {
	closestCenter,
	DndContext,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { accountRowId, accountSourceLabel } from "../../components/accounts/account-face";
import { type ScanSession, SourceAccountRow } from "../../components/accounts/source-account-row";
import { useAccounts } from "../../hooks/useAccounts";
import { useSources } from "../../hooks/useSources";
import { useT } from "../../i18n";
import { errorTextOf } from "../../services/error-text";
import type { Connection, PushTarget } from "../../types/domain";
import type { GlobalSettingsPatch } from "../../types/globals";
import { MasterSection } from "./master-section";

/** Keep dormant keys in their slots; repeated active keys remain inert at the end. */
function reorderAccounts(order: readonly string[], desired: readonly string[]): string[] {
	const active = new Set(desired),
		seen = new Set<string>(),
		duplicates: string[] = [];
	let next = 0;
	const result = order.flatMap((key) => {
		if (!active.has(key)) return [key];
		if (seen.has(key)) {
			duplicates.push(key);
			return [];
		}
		seen.add(key);
		return [desired[next++]];
	});
	return [...result, ...desired.slice(next), ...duplicates];
}
function orderedAccounts(
	accounts: readonly AccountView[],
	order: readonly string[],
): AccountView[] {
	const remaining = new Map(accounts.map((account) => [account.sourceKey, account]));
	const result: AccountView[] = [];
	for (const key of order) {
		const row = remaining.get(key);
		if (row) {
			result.push(row);
			remaining.delete(key);
		}
	}
	return [...result, ...remaining.values()];
}

export function AccountSection({
	active,
	draft,
	targets,
	connections,
	onPatch,
}: {
	active: boolean;
	draft: SettingsResponse | null;
	targets: PushTarget[];
	connections: Connection[];
	onPatch: (delta: GlobalSettingsPatch) => void;
}) {
	const tx = useT(),
		location = useLocation();
	const query = useAccounts();
	const sources = useSources();
	const rows = query.isError ? [] : (query.data?.accounts ?? []);
	const order = draft?.core.accounts?.order ?? [];
	const shown = orderedAccounts(rows, order);
	const first = rows[0];
	const [sessions, setSessions] = useState<Record<string, ScanSession>>({});
	const openKey = rows.find(
		(a) =>
			sessions[a.sourceKey]?.scanning &&
			!sessions[a.sourceKey]?.dismissed &&
			["awaiting-scan", "confirming"].includes(a.state.status),
	)?.sourceKey;
	const newKey = !openKey
		? rows.find((a) => a.state.status === "awaiting-scan" && !sessions[a.sourceKey]?.scanning)
				?.sourceKey
		: undefined;
	const next: Record<string, ScanSession> =
		query.isError || query.isPending
			? sessions
			: Object.fromEntries(
					rows.map((account) => {
						const prev = sessions[account.sourceKey];
						const scanning =
							account.state.status === "awaiting-scan" ||
							(account.state.status === "confirming" && prev?.scanning === true);
						return [
							account.sourceKey,
							{
								scanning,
								dismissed: scanning
									? prev?.scanning
										? prev.dismissed
										: account.sourceKey !== newKey
									: false,
							},
						];
					}),
				);
	if (JSON.stringify(next) !== JSON.stringify(sessions)) setSessions(next);
	const pendingLogin = rows.find((account) => account.state.status !== "logged-in")?.sourceKey;
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Repeat navigation and data arrival must scroll the newly mounted row.
	useEffect(() => {
		if (!active) return;
		const key = new URLSearchParams(location.search).get("account");
		if (key) document.getElementById(accountRowId(key))?.scrollIntoView?.({ block: "center" });
	}, [active, location.key, location.search, query.data]);
	if (!active) return null;
	const changed = shown.some((account, index) => account.sourceKey !== rows[index]?.sourceKey);
	return (
		<>
			<GlassBox
				title={tx("accounts.title")}
				subtitle={tx("accounts.subtitle")}
				accent="var(--color-bn-blue)"
				icon={<Icon.user size={14} />}
			>
				<p className="mb-1 text-bn-xs text-bn-text-secondary">{tx("accounts.orderHint")}</p>
				{query.isError ? (
					<ErrorNote size="sm" className="mt-3">
						{tx("accounts.readFailed")}
						<p className="my-2 break-all">{errorTextOf(query.error)}</p>
						<Btn size="sm" variant="outline" onClick={() => void query.refetch()}>
							{tx("accounts.retry")}
						</Btn>
					</ErrorNote>
				) : query.isPending ? (
					<LoadingBlock label={tx("accounts.loading")} />
				) : rows.length === 0 ? (
					<EmptyNote size="sm" className="my-3">
						{tx("accounts.empty")}
					</EmptyNote>
				) : (
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						onDragEnd={({ active, over }) => {
							if (!draft || !over || active.id === over.id || query.isError) return;
							const keys = shown.map((account) => account.sourceKey),
								from = keys.indexOf(String(active.id)),
								to = keys.indexOf(String(over.id));
							if (from < 0 || to < 0) return;
							keys.splice(to, 0, ...keys.splice(from, 1));
							onPatch({ accounts: { order: reorderAccounts(order, keys) } });
						}}
					>
						<SortableContext
							items={shown.map((account) => account.sourceKey)}
							strategy={verticalListSortingStrategy}
						>
							<div data-code="core.accounts.order" className="divide-y divide-bn-border-subtle">
								{shown.map((account) => (
									<SourceAccountRow
										key={account.sourceKey}
										account={account}
										source={sources.data?.sources?.find(
											(source) => source.key === account.sourceKey,
										)}
										first={account.sourceKey === first?.sourceKey}
										total={shown.length}
										tour={account.sourceKey === pendingLogin}
										session={next[account.sourceKey]}
										onDismiss={(dismissed) =>
											setSessions((prev) => ({
												...Object.fromEntries(
													Object.entries(prev).map(([key, value]) => [
														key,
														!dismissed && key !== account.sourceKey
															? { ...value, dismissed: true }
															: value,
													]),
												),
												[account.sourceKey]: { ...next[account.sourceKey], dismissed },
											}))
										}
									/>
								))}
							</div>
						</SortableContext>
					</DndContext>
				)}
				{changed && shown[0] ? (
					<HintNote className="mt-3">
						{tx("accounts.orderPending", {
							source: accountSourceLabel(shown[0].sourceKey, sources.data?.sources),
						})}
					</HintNote>
				) : null}
				{rows.length > 1 ? (
					<p className="mt-3 text-bn-xs text-bn-text-tertiary">{tx("accounts.dragHint")}</p>
				) : null}
			</GlassBox>
			{draft ? (
				<MasterSection
					draft={draft.core}
					targets={targets}
					connections={connections}
					onPatch={onPatch}
				/>
			) : null}
			<details className="rounded-sm border border-bn-border bg-bn-surface-muted p-3 text-bn-sm text-bn-text-secondary">
				<summary className="cursor-pointer font-medium">
					{tx("panelUi.pages.system.account-section.21")}
				</summary>
				<pre className="mt-2 overflow-auto leading-relaxed">
					{JSON.stringify(query.data ?? {}, null, 2)}
				</pre>
			</details>
		</>
	);
}
