import {
	Btn,
	EmptyNote,
	ErrorNote,
	HintNote,
	Icon,
	IconButton,
	LoadingBlock,
	ModalShell,
	TInput,
} from "@bilibili-notify/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	SUBSCRIPTION_TAGS_QUERY_KEY,
	useReplaceSubscriptionTags,
	useSubscriptionTags,
} from "../../hooks/useSubscriptionTags";
import { useT } from "../../i18n";
import { errorTextOf } from "../../services/error-text";
import { newId, type Subscription, type SubscriptionTag } from "../../types/domain";
import { planNewTag } from "./tag-edit";

/** Compare semantic table values, including display order, rather than query object identity. */
function sameTags(
	a: readonly SubscriptionTag[] | undefined,
	b: readonly SubscriptionTag[] | undefined,
) {
	if (a === undefined || b === undefined) return a === b;
	return (
		a.length === b.length &&
		a.every((tag, index) => tag.id === b[index]?.id && tag.name === b[index]?.name)
	);
}

export function TagManagerDialog({
	subscriptions,
	onClose,
}: {
	subscriptions?: readonly Subscription[];
	onClose: () => void;
}) {
	const tx = useT();
	const body = useRef<HTMLDivElement>(null);
	const query = useSubscriptionTags();
	const replace = useReplaceSubscriptionTags();
	const qc = useQueryClient();
	const [baseline, setBaseline] = useState(query.data);
	const [saving, setSaving] = useState(false);
	const [draft, setDraft] = useState<SubscriptionTag[] | null>(null);
	const [newName, setNewName] = useState("");
	const [removed, setRemoved] = useState<string[]>([]);
	const [pendingDelete, setPendingDelete] = useState<SubscriptionTag | null>(null);
	const [error, setError] = useState<
		{ kind: "duplicate" } | { kind: "request"; message: string } | null
	>(null);
	const [discarding, setDiscarding] = useState(false);
	// Keep deleted rows in the working order until save, so independent undo never guesses an index.
	const allRows = draft ?? baseline ?? query.data ?? [];
	const rows = allRows.filter((tag) => !removed.includes(tag.id));
	const removedTags = allRows.filter((tag) => removed.includes(tag.id));
	const pendingNew = newName.trim().length > 0;
	const dirty = !sameTags(rows, baseline ?? query.data ?? []) || pendingNew;
	const busy = saving || replace.isPending;
	const conflict =
		!busy &&
		baseline !== undefined &&
		query.data !== undefined &&
		!sameTags(baseline, query.data) &&
		dirty;
	const names = rows.map((tag) => tag.name.trim());
	const invalid = names.some((name) => !name) || new Set(names).size !== names.length;
	const ready = baseline !== undefined && query.data !== undefined && !query.isError;
	const locked = busy || !ready || conflict;
	useEffect(() => {
		if (!busy && !dirty && query.data !== undefined && !sameTags(query.data, baseline)) {
			setBaseline(query.data);
			setDraft(null);
			setRemoved([]);
			setPendingDelete(null);
		}
	}, [baseline, query.data, busy, dirty]);
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const controls = () => [
			...(body.current?.querySelectorAll<HTMLElement>(
				"button:not([disabled]), input:not([disabled]), a[href]",
			) ?? []),
		];
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Tab") return;
			const items = controls();
			const first = items[0];
			const last = items.at(-1);
			if (!first) {
				event.preventDefault();
				body.current?.focus();
				return;
			}
			if (!items.includes(document.activeElement as HTMLElement)) {
				event.preventDefault();
				(event.shiftKey ? last : first)?.focus();
			} else if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			previous?.focus();
		};
	}, []);

	const view = discarding
		? "discard"
		: pendingDelete
			? `delete:${pendingDelete.id}`
			: query.isError
				? "error"
				: !ready
					? "loading"
					: conflict
						? "conflict"
						: "editor";
	useEffect(() => {
		const selector = view === "editor" ? "input:not([disabled])" : "button:not([disabled])";
		body.current?.querySelector<HTMLElement>(selector)?.focus();
	}, [view]);

	function reload() {
		if (busy || query.data === undefined) return;
		setBaseline(query.data);
		setDraft(null);
		setNewName("");
		setRemoved([]);
		setPendingDelete(null);
		setError(null);
	}

	const usedBy = (id: string) => subscriptions?.filter((sub) => sub.tagIds.includes(id)).length;
	function cancel() {
		if (busy) return;
		if (pendingDelete) setPendingDelete(null);
		else if (discarding) setDiscarding(false);
		else if (dirty) setDiscarding(true);
		else onClose();
	}
	function move(index: number, delta: number) {
		const a = rows[index];
		const b = rows[index + delta];
		if (!a || !b) return;
		const next = [...allRows];
		const first = next.findIndex((tag) => tag.id === a.id);
		const second = next.findIndex((tag) => tag.id === b.id);
		next[first] = b;
		next[second] = a;
		setDraft(next);
		setError(null);
	}
	function add() {
		if (locked) return;
		const plan = planNewTag(rows, newName, newId());
		if (plan.kind === "empty") return;
		if (plan.kind === "existing") {
			setError({ kind: "duplicate" });
			return;
		}
		setDraft([...allRows, plan.tag]);
		setNewName("");
		setError(null);
	}
	async function save() {
		if (
			locked ||
			!dirty ||
			invalid ||
			pendingNew ||
			query.isFetching ||
			!sameTags(baseline, qc.getQueryData<SubscriptionTag[]>(SUBSCRIPTION_TAGS_QUERY_KEY))
		)
			return;
		setError(null);
		setSaving(true);
		try {
			const saved = await replace.mutateAsync(
				rows.map((tag) => ({ ...tag, name: tag.name.trim() })),
			);
			setBaseline(saved);
			onClose();
		} catch (e) {
			setError({ kind: "request", message: errorTextOf(e) });
		} finally {
			setSaving(false);
		}
	}
	return (
		<ModalShell
			width={620}
			bodyClassName="p-5"
			title={tx("subscriptionTags.manage")}
			onCancel={cancel}
		>
			<div ref={body} tabIndex={-1}>
				{discarding ? (
					<>
						<p className="text-bn-sm leading-relaxed text-bn-text-secondary">
							{tx("subscriptionTags.discardQuestion")}
						</p>
						<div className="mt-5 flex justify-end gap-2">
							<Btn size="sm" variant="outline" onClick={() => setDiscarding(false)}>
								{tx("subscriptionTags.continue")}
							</Btn>
							<Btn size="sm" variant="danger-solid" onClick={onClose}>
								{tx("subscriptionTags.discard")}
							</Btn>
						</div>
					</>
				) : pendingDelete ? (
					<>
						<p className="break-all text-bn-sm font-semibold text-bn-text-primary">
							{tx("subscriptionTags.deleteTitle", { name: pendingDelete.name })}
						</p>
						<p className="mt-2 text-bn-xs leading-relaxed text-bn-text-secondary">
							{usedBy(pendingDelete.id) === undefined
								? tx("subscriptionTags.deleteImpactUnknown")
								: tx("subscriptionTags.deleteImpact", { count: usedBy(pendingDelete.id) ?? 0 })}
						</p>
						<HintNote className="mt-4">{tx("subscriptionTags.deleteHint")}</HintNote>
						<div className="mt-5 flex justify-end gap-2">
							<Btn size="sm" variant="outline" onClick={() => setPendingDelete(null)}>
								{tx("subscriptionTags.back")}
							</Btn>
							<Btn
								size="sm"
								variant="danger-solid"
								disabled={locked}
								onClick={() => {
									setRemoved([...removed, pendingDelete.id]);
									setPendingDelete(null);
									setError(null);
								}}
							>
								{tx("subscriptionTags.markDelete")}
							</Btn>
						</div>
					</>
				) : (
					<>
						<p className="mb-3 text-bn-xs leading-relaxed text-bn-text-secondary">
							{tx("subscriptionTags.intro")}
						</p>
						{conflict ? (
							<HintNote className="mb-3">
								{tx("subscriptionTags.changed")}
								<Btn size="sm" variant="outline" onClick={reload}>
									{tx("subscriptionTags.reload")}
								</Btn>
							</HintNote>
						) : null}
						{query.isError ? (
							<ErrorNote size="sm">
								{tx("subscriptionTags.readFailed")}
								<Btn size="sm" variant="outline" onClick={() => void query.refetch()}>
									{tx("subscriptionTags.retry")}
								</Btn>
							</ErrorNote>
						) : query.isPending ? (
							<LoadingBlock variant="inset" label={tx("subscriptionTags.loading")} />
						) : (
							<>
								<div className="mb-3 flex min-w-0 gap-2">
									<TInput
										full
										ariaLabel={tx("subscriptionTags.newName")}
										placeholder={tx("subscriptionTags.newName")}
										value={newName}
										onChange={setNewName}
										disabled={locked}
									/>
									<Btn
										size="sm"
										variant="outline"
										icon={<Icon.plus size={12} />}
										disabled={!pendingNew || locked}
										onClick={add}
									>
										{tx("subscriptionTags.add")}
									</Btn>
								</div>
								{pendingNew ? (
									<p className="mb-2 text-bn-xs text-bn-text-secondary">
										{tx("subscriptionTags.addFirst")}
									</p>
								) : null}
								<section
									aria-label={tx("subscriptionTags.list")}
									className="flex max-h-[60vh] flex-col overflow-y-auto"
								>
									{rows.length === 0 ? (
										<EmptyNote size="sm">{tx("subscriptionTags.empty")}</EmptyNote>
									) : (
										rows.map((tag, index) => {
											const name = tag.name.trim();
											const problem = !name
												? tx("subscriptionTags.emptyName")
												: names.filter((n) => n === name).length > 1
													? tx("subscriptionTags.duplicate")
													: null;
											const count = subscriptions?.filter((sub) =>
												sub.tagIds.includes(tag.id),
											).length;
											return (
												<fieldset
													key={tag.id}
													aria-label={tx("subscriptionTags.row", { name: tag.name })}
													className="m-0 min-w-0 border-0 border-b border-bn-border-subtle py-3 last:border-b-0"
												>
													<div className="flex min-w-0 items-center gap-2">
														<span className="w-4 shrink-0 text-bn-xs tabular-nums text-bn-text-tertiary">
															{index + 1}
														</span>
														<div className="min-w-0 flex-1">
															<TInput
																full
																value={tag.name}
																ariaLabel={tx("subscriptionTags.name", { index: index + 1 })}
																disabled={locked}
																onChange={(value) => {
																	setDraft(
																		allRows.map((t) =>
																			t.id === tag.id ? { ...t, name: value } : t,
																		),
																	);
																	setError(null);
																}}
															/>
														</div>
														<div className="flex shrink-0 items-center gap-1">
															<IconButton
																size="lg"
																className="max-sm:h-11 max-sm:w-11"
																icon={<Icon.arrowUp size={14} />}
																label={tx("subscriptionTags.up", { name: tag.name })}
																disabled={index === 0 || locked}
																onClick={() => move(index, -1)}
															/>
															<IconButton
																size="lg"
																className="max-sm:h-11 max-sm:w-11"
																icon={
																	<span className="inline-flex rotate-180">
																		<Icon.arrowUp size={14} />
																	</span>
																}
																label={tx("subscriptionTags.down", { name: tag.name })}
																disabled={index === rows.length - 1 || locked}
																onClick={() => move(index, 1)}
															/>
															<IconButton
																size="lg"
																className="max-sm:h-11 max-sm:w-11"
																tone="danger"
																icon={<Icon.trash size={14} />}
																label={tx("subscriptionTags.delete", { name: tag.name })}
																disabled={locked}
																onClick={() => setPendingDelete(tag)}
															/>
														</div>
													</div>
													<div className="ml-6 mt-1 text-bn-xs text-bn-text-secondary">
														{count === undefined
															? tx("subscriptionTags.countUnknown")
															: tx("subscriptionTags.count", { count })}
														{count === 0 ? ` · ${tx("subscriptionTags.unused")}` : null}
													</div>
													{problem ? (
														<p className="ml-6 mt-1 text-bn-xs text-bn-danger-text">{problem}</p>
													) : null}
												</fieldset>
											);
										})
									)}
								</section>
							</>
						)}
						{removed.length > 0 ? (
							<div className="mt-3 rounded-lg border border-bn-border-subtle p-3">
								<div className="mb-1 text-bn-xs font-semibold text-bn-text-primary">
									{tx("subscriptionTags.pendingDelete")}
								</div>
								{removedTags.map((tag) => (
									<div
										key={tag.id}
										className="flex min-w-0 items-center justify-between gap-2 text-bn-xs text-bn-text-secondary"
									>
										<span className="min-w-0 truncate" title={tag.name}>
											{tag.name}
										</span>
										<Btn
											size="sm"
											variant="ghost"
											disabled={locked}
											onClick={() => {
												setRemoved(removed.filter((id) => id !== tag.id));
											}}
										>
											{tx("subscriptionTags.undo")}
										</Btn>
									</div>
								))}
							</div>
						) : null}
						{error ? (
							<ErrorNote size="sm" className="mt-3">
								{error.kind === "duplicate" ? tx("subscriptionTags.existingName") : error.message}
							</ErrorNote>
						) : null}
						<div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-bn-border-subtle pt-3">
							<span className="text-bn-xs text-bn-text-secondary">
								{dirty ? tx("subscriptionTags.dirty") : tx("subscriptionTags.clean")}
							</span>
							<div className="ml-auto flex gap-2">
								<Btn size="sm" variant="outline" disabled={busy} onClick={cancel}>
									{tx("subscriptionTags.cancel")}
								</Btn>
								<Btn
									size="sm"
									variant="primary"
									disabled={locked || !dirty || invalid || pendingNew || query.isFetching}
									onClick={() => void save()}
								>
									{busy ? tx("subscriptionTags.saving") : tx("subscriptionTags.save")}
								</Btn>
							</div>
						</div>
					</>
				)}
			</div>
		</ModalShell>
	);
}
