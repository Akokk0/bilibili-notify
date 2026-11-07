import {
	PERSONA_FILE_LIMITS,
	type PersonaContent,
	type PersonaWriteRequest,
} from "@bilibili-notify/contract";
import {
	AddFileButton,
	Btn,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	LoadingBlock,
	ModalShell,
	Pill,
	RailDot,
	SectionNav,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Field, TArea, TInput } from "../../components/forms";
import { ResourceImportDialog } from "../../components/library/resource-import-dialog";
import { getFieldLabel } from "../../config/field-labels";
import { SECTION_ACCENT } from "../../config/section-accents";
import { SETTINGS_KEY } from "../../hooks/useSettings";
import { useT } from "../../i18n";
import { ApiError } from "../../services/api";
import { errorTextOf } from "../../services/error-text";
import {
	exportPersona,
	listPersonas,
	personaQueryKey,
	previewPersona,
	writePersona,
} from "../../services/persona";
import { saveResourceFile } from "../../services/resource-download";
import { personaIconKey } from "./persona-icons";

const NEW_ID = "/new";
const BLANK: PersonaContent = {
	label: "",
	persona: {
		name: "",
		addressUser: "",
		addressSelf: "",
		traits: "",
		catchphrase: "",
		baseRole: "",
		extraSystemPrompt: "",
	},
};

/** 沿用原设置页的字段、标签与控件，库中独立保存，不参与原页配置草稿。 */
function PersonaFields({
	value,
	onChange,
	readOnly = false,
}: {
	value: PersonaContent;
	onChange: (next: PersonaContent) => void;
	readOnly?: boolean;
}) {
	const t = useT();
	return (
		<>
			<Field code="presets" label={t("personas.label")} hint="" full>
				<TInput
					ariaLabel={t("personas.label")}
					value={value.label}
					disabled={readOnly}
					onChange={(label) => onChange({ ...value, label })}
				/>
			</Field>
			<div className="grid grid-cols-1 gap-x-4 lg:grid-cols-2">
				{(["name", "addressUser", "addressSelf", "catchphrase"] as const).map((key) => (
					<Field key={key} code={`persona.${key}`} hint="" full>
						<TInput
							ariaLabel={getFieldLabel(`persona.${key}`)?.label}
							value={value.persona[key]}
							disabled={readOnly}
							onChange={(text) =>
								onChange({ ...value, persona: { ...value.persona, [key]: text } })
							}
						/>
					</Field>
				))}
			</div>
			<Field code="persona.traits" full>
				<TInput
					ariaLabel={getFieldLabel("persona.traits")?.label}
					value={value.persona.traits}
					disabled={readOnly}
					onChange={(traits) => onChange({ ...value, persona: { ...value.persona, traits } })}
				/>
			</Field>
			{(["baseRole", "extraSystemPrompt"] as const).map((key) => (
				<Field key={key} code={`persona.${key}`} full>
					<TArea
						ariaLabel={getFieldLabel(`persona.${key}`)?.label}
						value={value.persona[key]}
						disabled={readOnly}
						rows={2}
						onChange={(text) => onChange({ ...value, persona: { ...value.persona, [key]: text } })}
					/>
				</Field>
			))}
			{(["dynamicPrompt", "liveSummaryPrompt"] as const).map((key) => (
				<Field
					key={key}
					code={`ai.${key}`}
					full
					hint={t("aiSettings.page.personas.promptPlaceholder")}
				>
					<TArea
						ariaLabel={getFieldLabel(`ai.${key}`)?.label}
						value={value[key] ?? ""}
						disabled={readOnly}
						mono
						rows={3}
						onChange={(text) => onChange({ ...value, [key]: text })}
					/>
				</Field>
			))}
		</>
	);
}

export function PersonaLibrary() {
	const t = useT(),
		qc = useQueryClient();
	const query = useQuery({ queryKey: personaQueryKey, queryFn: listPersonas });
	const [active, setActive] = useState<string | null>(null);
	const [draft, setDraft] = useState<PersonaContent>(BLANK);
	const [baseline, setBaseline] = useState<PersonaContent>(BLANK);
	const [revision, setRevision] = useState("");
	const [search, setSearch] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [importDraft, setImportDraft] = useState<PersonaContent | null>(null);
	const [importCopied, setImportCopied] = useState(false);
	const [importRevision, setImportRevision] = useState("");
	const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
	const modal = useRef<HTMLDivElement>(null);
	const list = query.data?.entries ?? [];
	const current = list.find((entry) => entry.id === active);
	const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
	const isModalOpen = pendingAction !== null;
	useEffect(() => {
		if (!isModalOpen) return;
		const previous = document.activeElement as HTMLElement | null;
		const body = modal.current;
		const selector = "input:not([disabled]),textarea:not([disabled]),button:not([disabled])";
		body?.querySelector<HTMLElement>(selector)?.focus();
		const trap = (event: KeyboardEvent) => {
			if (event.key !== "Tab") return;
			const nodes = body?.querySelectorAll<HTMLElement>(selector),
				first = nodes?.[0],
				last = nodes?.[nodes.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		body?.addEventListener("keydown", trap);
		return () => {
			body?.removeEventListener("keydown", trap);
			previous?.focus();
		};
	}, [isModalOpen]);
	const select = useCallback((id: string, content: PersonaContent, version: string) => {
		const snapshot = {
			label: content.label,
			persona: { ...content.persona },
			dynamicPrompt: content.dynamicPrompt,
			liveSummaryPrompt: content.liveSummaryPrompt,
		};
		setActive(id);
		setDraft(snapshot);
		setBaseline(snapshot);
		setRevision(version);
		setError(null);
		setNotice(null);
	}, []);
	useEffect(() => {
		if (active !== null || !query.data?.entries[0]) return;
		select(query.data.entries[0].id, query.data.entries[0], query.data.revision);
	}, [active, query.data, select]);
	function guard(action: () => void) {
		if (dirty) setPendingAction(() => action);
		else action();
	}
	function copyLabel(label: string) {
		let candidate = t("personas.copyLabel", { label }),
			n = 2;
		while (list.some((entry) => entry.label === candidate))
			candidate = t("personas.copyNumber", { label, n: n++ });
		return candidate;
	}
	const write = useMutation({
		mutationFn: writePersona,
		onSuccess: async (result, change) => {
			if (!result.ok) {
				setError(result.message);
				return;
			}
			await qc.invalidateQueries({ queryKey: personaQueryKey });
			void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
			const next = qc.getQueryData<Awaited<ReturnType<typeof listPersonas>>>(personaQueryKey);
			const entry = next?.entries.find((p) => p.id === result.id) ?? next?.entries[0];
			if (entry && next) select(entry.id, entry, next.revision);
			if (change.op === "create") {
				setImportDraft(null);
				setNotice(t("personas.created"));
			}
		},
		onError: (e: Error) => {
			setError(errorTextOf(e));
			if (e instanceof ApiError && e.code === "conflict")
				void qc.invalidateQueries({ queryKey: personaQueryKey });
		},
	});
	const preview = useMutation({
		mutationFn: previewPersona,
		onSuccess: (result) => {
			if (!result.ok) {
				setError(result.message);
				return;
			}
			setError(null);
			setImportRevision(query.data?.revision ?? "");
			const copied = list.some((entry) => entry.label === result.content.label);
			setImportCopied(copied);
			setImportDraft({
				...result.content,
				label: copied ? copyLabel(result.content.label) : result.content.label,
			});
		},
		onError: (e: Error) => setError(errorTextOf(e)),
	});
	const download = useMutation({
		mutationFn: exportPersona,
		onSuccess: (blob) => {
			saveResourceFile(blob, "persona.json");
		},
		onError: (e: Error) => setError(errorTextOf(e)),
	});
	const busy = write.isPending || preview.isPending || download.isPending;
	function submit(content: PersonaContent, version: string, id: string) {
		if (!content.label.trim()) {
			setError(t("personas.labelRequired"));
			return;
		}
		const request: PersonaWriteRequest =
			id === NEW_ID
				? { op: "create", revision: version, content }
				: { op: "update", revision: version, id, content };
		setError(null);
		write.mutate(request);
	}
	if (query.isPending) return <LoadingBlock label={t("personas.loading")} />;
	if (!query.data) return <ErrorNote>{query.error?.message}</ErrorNote>;
	const Glyph = Icon[personaIconKey(active ?? "")];
	return (
		<div className="min-w-0 space-y-4">
			<div className="flex min-w-0 flex-wrap items-center gap-3">
				<div className="min-w-0 flex-1">
					<TInput
						ariaLabel={t("personas.search")}
						placeholder={t("personas.search")}
						value={search}
						onChange={setSearch}
					/>
				</div>
				<AddFileButton
					accept=".json,application/json"
					className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-bn-sm"
					uploading={busy}
					onFile={(file) => {
						if (!file) return;
						guard(() => {
							if (file.size > PERSONA_FILE_LIMITS.bytes) setError(t("personas.tooLarge"));
							else preview.mutate(file);
						});
					}}
				>
					{t("personas.import")}
				</AddFileButton>
				<Btn
					variant="outline"
					disabled={busy}
					icon={<Icon.plus size={14} />}
					onClick={() => guard(() => select(NEW_ID, BLANK, query.data.revision))}
				>
					{t("personas.new")}
				</Btn>
			</div>
			{notice ? <HintNote>{notice}</HintNote> : null}
			{query.isError ? <ErrorNote>{query.error.message}</ErrorNote> : null}
			{error && !importDraft ? <ErrorNote>{error}</ErrorNote> : null}
			<div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-bn-rail">
				<SectionNav
					heading={t("library.personasTitle")}
					items={list
						.filter((p) => p.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
						.map((p) => {
							const Mark = Icon[personaIconKey(p.id)];
							return {
								id: p.id,
								label: p.label,
								desc: p.builtin ? t("personas.builtin") : t("personas.custom"),
								icon: <Mark size={18} />,
								badge: p.usedBy.length ? (
									<RailDot title={p.usedBy.join("、")} active={p.id === active} />
								) : undefined,
							};
						})}
					activeId={active ?? ""}
					onPick={(id) => {
						const entry = list.find((p) => p.id === id);
						if (entry && !busy) guard(() => select(id, entry, query.data.revision));
					}}
				/>
				<div className="min-w-0 space-y-4">
					<GlassBox
						title={active === NEW_ID ? t("personas.new") : draft.label}
						subtitle={t("personas.editorHint")}
						accent={SECTION_ACCENT.persona}
						icon={<Glyph size={16} />}
						badge="persona"
					>
						<div className="mb-4 flex flex-wrap gap-2">
							{current?.builtin ? (
								<Pill color={SECTION_ACCENT.persona} subtle>
									{t("personas.builtin")}
								</Pill>
							) : null}
							{current?.usedBy.map((usage) => (
								<Pill key={usage} color={SECTION_ACCENT.persona} subtle>
									{usage}
								</Pill>
							))}
						</div>
						<PersonaFields value={draft} onChange={setDraft} readOnly={current?.builtin || busy} />
						<div className="mt-4 flex flex-wrap justify-end gap-2">
							<Btn
								variant="outline"
								disabled={busy}
								onClick={() =>
									guard(() =>
										select(
											NEW_ID,
											{ ...draft, label: copyLabel(draft.label) },
											query.data.revision,
										),
									)
								}
							>
								{t("personas.copy")}
							</Btn>
							{current ? (
								<Btn variant="outline" disabled={busy} onClick={() => download.mutate(current.id)}>
									{t("personas.export")}
								</Btn>
							) : null}
							{current && list.length > 1 ? (
								<Btn
									variant="danger-outline"
									disabled={busy || current.usedBy.length > 0}
									title={current.usedBy.length ? t("personas.inUseHint") : undefined}
									onClick={() =>
										setPendingAction(
											() => () => write.mutate({ op: "remove", id: current.id, revision }),
										)
									}
								>
									{t("personas.remove")}
								</Btn>
							) : null}
							{!current?.builtin ? (
								<Btn
									variant="primary"
									disabled={busy || !draft.label.trim()}
									onClick={() => submit(draft, revision, active ?? NEW_ID)}
								>
									{t("personas.save")}
								</Btn>
							) : null}
						</div>
					</GlassBox>
					{query.data.revision !== revision ? (
						<HintNote>
							{t("personas.stale")}{" "}
							<Btn
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() =>
									guard(() => {
										const next = list.find((p) => p.id === active) ?? list[0];
										if (next) select(next.id, next, query.data.revision);
									})
								}
							>
								{t("personas.reload")}
							</Btn>
						</HintNote>
					) : null}
					{query.data.removedBuiltins.length ? (
						<GlassBox title={t("personas.restoreTitle")}>
							<div className="flex flex-wrap gap-2">
								{query.data.removedBuiltins.map((p) => (
									<Btn
										key={p.id}
										variant="outline"
										disabled={busy}
										onClick={() =>
											guard(() =>
												write.mutate({ op: "restore", id: p.id, revision: query.data.revision }),
											)
										}
									>
										{p.label}
									</Btn>
								))}
							</div>
						</GlassBox>
					) : null}
				</div>
			</div>
			{importDraft ? (
				<ResourceImportDialog
					title={t("personas.importTitle")}
					conflict={importCopied}
					pending={busy}
					error={error}
					confirmDisabled={!importDraft.label.trim()}
					onCancel={() => {
						setImportDraft(null);
						setError(null);
					}}
					onConfirm={() => submit(importDraft, importRevision, NEW_ID)}
				>
					<PersonaFields value={importDraft} onChange={setImportDraft} readOnly={busy} />
					{importRevision !== query.data.revision ? (
						<HintNote>
							{t("personas.importStale")}{" "}
							<Btn
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => {
									setImportRevision(query.data.revision);
									setError(null);
								}}
							>
								{t("personas.keepImport")}
							</Btn>
						</HintNote>
					) : null}
				</ResourceImportDialog>
			) : pendingAction ? (
				<ModalShell
					width={460}
					title={t("personas.confirmTitle")}
					description={t("personas.confirmHint")}
					onCancel={() => setPendingAction(null)}
				>
					<div ref={modal} className="flex justify-end gap-2">
						<Btn variant="outline" onClick={() => setPendingAction(null)}>
							{t("library.cancel")}
						</Btn>
						<Btn
							variant="primary"
							onClick={() => {
								pendingAction();
								setPendingAction(null);
							}}
						>
							{t("personas.confirm")}
						</Btn>
					</div>
				</ModalShell>
			) : null}
		</div>
	);
}
