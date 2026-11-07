/**
 * 资源库中的女仆技能编辑器 —— 一条技能 = 一份 `SKILL.md`。
 *
 * 与AI配置页不同:这里不参与整页那条保存栏。技能不是配置,
 * 它是自己的一份 REST 资源(`/api/ai/skills`),每条各存各的。混进配置草稿的话,
 * 保存栏会开始声称一堆它根本管不着的改动。所以每条底下自带「保存」。
 *
 * 内置那几条**只读**(跟版本走,升级即生效),右侧照样摊开给主人看 —— 看得到
 * 它们怎么写的,自己写第一条时才有个照着抄的样子。
 */

import type { MaidSkillView, MaidSkillWriteRequest } from "@bilibili-notify/contract";
import { complainAboutSkill, MAID_SKILL_LIMITS } from "@bilibili-notify/contract";
import {
	AddFileButton,
	Btn,
	CheckRow,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	LoadingBlock,
	TabBar,
	WarnNote,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { TArea, TInput } from "../../components/forms";
import { ResourceImportDialog } from "../../components/library/resource-import-dialog";
import { useT } from "../../i18n";
import { errorTextOf } from "../../services/error-text";
import {
	createMaidSkill,
	deleteMaidSkill,
	exportMaidSkill,
	listMaidSkills,
	maidSkillsQueryKey,
	previewMaidSkill,
	updateMaidSkill,
} from "../../services/maidSkill";
import { saveResourceFile } from "../../services/resource-download";

/** 新建时右侧那份空白草稿。 */
const BLANK: MaidSkillWriteRequest = {
	name: "",
	description: "",
	disableModelInvocation: false,
	body: "",
};

/** 左栏那颗「新建」的哨兵 id —— 与任何合法技能名都撞不上(名字里没有斜杠)。 */
const NEW_ID = "/new";

function copyName(name: string, list: readonly MaidSkillView[]): string {
	for (let n = 1; ; n++) {
		const suffix = n === 1 ? "-copy" : `-copy-${n}`;
		const candidate = `${name.slice(0, MAID_SKILL_LIMITS.nameChars - suffix.length).replace(/-+$/, "")}${suffix}`;
		if (!list.some((skill) => skill.name === candidate)) return candidate;
	}
}

function toDraft(s: MaidSkillView): MaidSkillWriteRequest {
	const draft: MaidSkillWriteRequest = {
		name: s.name,
		description: s.description,
		disableModelInvocation: s.disableModelInvocation,
		body: s.body,
	};
	if (s.allowedTools) draft.allowedTools = [...s.allowedTools];
	return draft;
}

/** 存之前自己先照一遍尺子,免得为一个一眼可见的问题跑一趟服务端。 */
function localComplaint(d: MaidSkillWriteRequest): string | null {
	// 尺子与判法都在 contract —— 服务端那道真闸照的是同一份,不会出现
	// 「网页说没问题、存进去被拒」。
	return complainAboutSkill(d);
}

/**
 * 一行「标题 + 控件 + 说明」。
 *
 * **标题只准写一次。** 用 div 而不是 `<label>` 包:label 一旦除标题外还含提示文字,
 * 读屏器念出的无障碍名就是**整段无分隔拼接**(实测「名字 · 也是斜杠命令小写字母 /
 * 数字 / 单个连字符。它同时是……」)。名字改由控件自己的 ariaLabel 给 —— 而 WCAG
 * 2.5.3 要求无障碍名**包含可见标签**,所以那两个字符串必须一字不差。
 *
 * 此前四个字段各把自己的标题手打了两遍(可见一份、ariaLabel 一份),八份手抄。
 * 改错一处不会红,只会让读屏器和眼睛看到的对不上 —— 一个没人会发现的 a11y 回归。
 * children 收一个函数,标题作为参数传下去,想漂也漂不了。
 */
function LabeledField(props: {
	label: string;
	hint?: ReactNode;
	children: (ariaLabel: string) => ReactNode;
}) {
	const { label, hint, children } = props;
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-bn-sm font-semibold text-bn-text-secondary">{label}</span>
			{children(label)}
			{hint ? <span className="text-bn-xs text-bn-text-tertiary">{hint}</span> : null}
		</div>
	);
}

export function MaidSkills() {
	const tx = useT();
	const qc = useQueryClient();
	const query = useQuery({ queryKey: maidSkillsQueryKey, queryFn: listMaidSkills });
	const list = query.data?.list ?? [];
	const problems = query.data?.problems ?? [];
	const tools = query.data?.tools ?? [];
	const toolLabels = query.data?.toolLabels ?? {};

	const [activeId, setActiveId] = useState<string | null>(null);
	const [draft, setDraft] = useState<MaidSkillWriteRequest>(BLANK);
	const [err, setErr] = useState<string | null>(null);
	const [importDraft, setImportDraft] = useState<MaidSkillWriteRequest | null>(null);
	const [importError, setImportError] = useState<string | null>(null);
	const [importCopied, setImportCopied] = useState(false);
	const [importedName, setImportedName] = useState<string | null>(null);
	// 首次拉到清单时落在第一条上 —— 右侧空着会让人以为这个 Tab 坏了。
	useEffect(() => {
		if (activeId === null && list.length > 0) {
			const first = list[0];
			if (first) {
				setActiveId(first.name);
				setDraft(toDraft(first));
			}
		}
	}, [activeId, list]);

	const creating = activeId === NEW_ID;
	const current = creating ? undefined : list.find((s) => s.name === activeId);
	const readOnly = current?.builtin === true;

	const invalidate = () => qc.invalidateQueries({ queryKey: maidSkillsQueryKey });
	const preview = useMutation({
		mutationFn: (file: File) => previewMaidSkill(file),
		onSuccess: (result) => {
			if (!result.ok) {
				setErr(result.message);
				return;
			}
			const copied = list.some((skill) => skill.name === result.skill.name);
			setImportCopied(copied);
			setImportError(null);
			setImportDraft({
				...result.skill,
				name: copied ? copyName(result.skill.name, list) : result.skill.name,
			});
		},
		onError: (e: Error) => setErr(errorTextOf(e)),
	});
	const importSkill = useMutation({
		mutationFn: (skill: MaidSkillWriteRequest) => createMaidSkill(skill),
		onSuccess: (_result, skill) => {
			setImportedName(skill.name);
			setImportDraft(null);
			setImportError(null);
			void invalidate();
		},
		onError: (e: Error) => setImportError(errorTextOf(e)),
	});
	const download = useMutation({
		mutationFn: (name: string) => exportMaidSkill(name),
		onSuccess: (blob, name) => {
			saveResourceFile(blob, `${name}.SKILL.md`);
		},
		onError: (e: Error) => setErr(errorTextOf(e)),
	});

	const save = useMutation({
		// 改名是「换目录」,服务端认的是**路径上那个旧名字** —— 从 draft.name 取会
		// 把改名请求发到新名字上,而那条还不存在,收回来一个 404。
		mutationFn: (vars: { originalName: string | null; skill: MaidSkillWriteRequest }) =>
			vars.originalName === null
				? createMaidSkill(vars.skill)
				: updateMaidSkill(vars.originalName, vars.skill),
		onSuccess: (_res, vars) => {
			setErr(null);
			setActiveId(vars.skill.name);
			void invalidate();
		},
		onError: (e: Error) => setErr(errorTextOf(e)),
	});

	const remove = useMutation({
		mutationFn: deleteMaidSkill,
		onSuccess: () => {
			setErr(null);
			setActiveId(null);
			void invalidate();
		},
		onError: (e: Error) => setErr(errorTextOf(e)),
	});

	const submit = () => {
		const complaint = localComplaint(draft);
		if (complaint) {
			setErr(complaint);
			return;
		}
		// 要发的东西随载荷走,别让 mutationFn 回头读组件状态。
		save.mutate({ originalName: creating ? null : (activeId ?? null), skill: draft });
	};

	const toggleTool = (name: string, on: boolean) => {
		// 一把都没勾 = **不限**(字段整个不写),而不是「一把都不给」:后者是个静默
		// 的大收紧,而它最可能的来源是主人根本没打算碰这一栏。
		const next = new Set(draft.allowedTools ?? []);
		if (on) next.add(name);
		else next.delete(name);
		const arr = [...next];
		const { allowedTools: _drop, ...rest } = draft;
		setDraft(arr.length > 0 ? { ...rest, allowedTools: arr } : rest);
	};

	const copyCurrent = () => {
		if (!current) return;
		setErr(null);
		setActiveId(NEW_ID);
		setDraft({ ...toDraft(current), name: copyName(current.name, list) });
	};

	if (query.isLoading) return <LoadingBlock label={tx("maidSkills.loading")} />;
	if (query.isError)
		return (
			<ErrorNote>
				{tx("maidSkills.readFailed")}{" "}
				<Btn onClick={() => void query.refetch()}>{tx("library.retry")}</Btn>
			</ErrorNote>
		);

	return (
		<div className="min-w-0 space-y-4">
			<div className="col-span-full flex flex-wrap items-center justify-between gap-3">
				<span className="text-bn-xs text-bn-text-tertiary">
					{tx("maidSkills.fileHint", { kb: MAID_SKILL_LIMITS.fileBytes / 1024 })}
				</span>
				<div className="flex flex-wrap items-center gap-3">
					<AddFileButton
						accept=".md,text/markdown,text/plain"
						uploading={preview.isPending}
						onFile={(file) => {
							if (!file || preview.isPending) return;
							setErr(null);
							if (file.size > MAID_SKILL_LIMITS.fileBytes) {
								setErr(tx("maidSkills.fileTooLarge", { kb: MAID_SKILL_LIMITS.fileBytes / 1024 }));
								return;
							}
							preview.mutate(file);
						}}
						className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-bn-sm"
					>
						{tx("maidSkills.import")}
					</AddFileButton>
					<Btn
						variant="outline"
						onClick={() => {
							setErr(null);
							setActiveId(NEW_ID);
							setDraft(BLANK);
						}}
					>
						{tx("maidSkills.add")}
					</Btn>
				</div>
			</div>
			<TabBar
				items={[
					...list.map((skill) => ({
						id: skill.name,
						label: skill.name,
						icon: <Icon.sparkle size={14} />,
						code: skill.builtin ? tx("maidSkills.builtin") : undefined,
					})),
					...(creating
						? [{ id: NEW_ID, label: tx("maidSkills.new"), icon: <Icon.plus size={14} /> }]
						: []),
				]}
				value={activeId ?? ""}
				onChange={(id) => {
					setErr(null);
					setActiveId(id);
					const picked = list.find((skill) => skill.name === id);
					if (picked) setDraft(toDraft(picked));
				}}
			/>

			<div className="flex min-w-0 flex-col gap-4">
				{importedName ? (
					<HintNote>{tx("maidSkills.imported", { name: importedName })}</HintNote>
				) : null}
				{problems.length > 0 ? (
					<WarnNote className="leading-relaxed">
						{tx("maidSkills.problems", { count: problems.length })}
						{problems.map((p) => `${p.dir}(${p.reason})`).join(";")}
					</WarnNote>
				) : null}

				<GlassBox
					title={creating ? tx("maidSkills.create") : (current?.name ?? tx("maidSkills.heading"))}
					subtitle={readOnly ? tx("maidSkills.builtinHint") : tx("maidSkills.storageHint")}
					accent="var(--color-bn-pink)"
					icon={<Icon.sparkle size={14} />}
					badge={readOnly ? "builtin" : "skill"}
				>
					<div className="flex flex-col gap-3.5 p-1">
						{current ? (
							<div className="flex flex-wrap justify-end gap-2">
								<Btn size="sm" variant="outline" onClick={copyCurrent}>
									{readOnly ? tx("maidSkills.copyEdit") : tx("maidSkills.copy")}
								</Btn>
								<Btn
									size="sm"
									variant="outline"
									disabled={download.isPending}
									onClick={() => {
										setErr(null);
										download.mutate(current.name);
									}}
								>
									{tx("maidSkills.export")}
								</Btn>
							</div>
						) : null}
						<LabeledField
							label={tx("maidSkills.nameLabel")}
							hint={tx("maidSkills.nameHint", {
								name: draft.name || tx("maidSkills.namePlaceholder"),
							})}
						>
							{(aria) => (
								<TInput
									ariaLabel={aria}
									mono
									value={draft.name}
									disabled={readOnly}
									placeholder="weekly-report"
									onChange={(v) => setDraft({ ...draft, name: v })}
								/>
							)}
						</LabeledField>

						<LabeledField
							label={tx("maidSkills.descriptionLabel")}
							hint={tx("maidSkills.descriptionHint", {
								count: draft.description.length,
								max: MAID_SKILL_LIMITS.descChars,
							})}
						>
							{(aria) => (
								<TInput
									ariaLabel={aria}
									value={draft.description}
									disabled={readOnly}
									placeholder={tx("maidSkills.descriptionPlaceholder")}
									onChange={(v) => setDraft({ ...draft, description: v })}
								/>
							)}
						</LabeledField>

						<LabeledField label={tx("maidSkills.bodyLabel")} hint={tx("maidSkills.bodyHint")}>
							{(aria) => (
								// rows 而不是 min-h-*:TArea 的高度口子就是 rows,11 行 ≈ 原先那个
								// min-h-60(240px);拖动改高由 TArea 自带的 resize-y 提供。
								<TArea
									ariaLabel={aria}
									rows={11}
									mono
									value={draft.body}
									disabled={readOnly}
									placeholder={tx("maidSkills.bodyPlaceholder")}
									onChange={(v) => setDraft({ ...draft, body: v })}
								/>
							)}
						</LabeledField>

						<div className="flex flex-col gap-1.5">
							<span className="text-bn-sm font-semibold text-bn-text-secondary">
								{tx("maidSkills.toolsLabel")}
							</span>
							<span className="text-bn-xs text-bn-text-tertiary">{tx("maidSkills.toolsHint")}</span>
							{/* CheckRow 没有 disabled(见 packages/ui 清单),内置那几条就整块
							    锁住 —— 为一处只读需求给共用件加个开关不值当。 */}
							<div
								className={`grid gap-0.5 sm:grid-cols-2 ${readOnly ? "pointer-events-none opacity-60" : ""}`}
								aria-disabled={readOnly}
							>
								{tools.map((t) => (
									<CheckRow
										key={t}
										checked={draft.allowedTools?.includes(t) ?? false}
										onChange={(on) => toggleTool(t, on)}
									>
										<span className="text-bn-sm" title={t}>
											{toolLabels[t] ?? t}
										</span>
									</CheckRow>
								))}
							</div>
						</div>

						<div
							className={readOnly ? "pointer-events-none opacity-60" : undefined}
							aria-disabled={readOnly}
						>
							<CheckRow
								checked={draft.disableModelInvocation}
								onChange={(on) => setDraft({ ...draft, disableModelInvocation: on })}
							>
								{tx("maidSkills.manualOnly")}
							</CheckRow>
						</div>

						{err ? (
							<ErrorNote className="mt-1">
								{tx("maidSkills.saveFailed", { message: err })}
							</ErrorNote>
						) : null}

						{readOnly ? null : (
							<div className="mt-1 flex items-center gap-2">
								<Btn onClick={submit} disabled={save.isPending}>
									{save.isPending ? tx("maidSkills.saving") : tx("maidSkills.save")}
								</Btn>
								{creating || !current ? null : (
									<Btn
										variant="danger"
										disabled={remove.isPending}
										onClick={() => remove.mutate(current.name)}
									>
										{tx("maidSkills.delete")}
									</Btn>
								)}
							</div>
						)}
					</div>
				</GlassBox>
			</div>
			{importDraft ? (
				<ResourceImportDialog
					title={tx("maidSkills.importTitle")}
					conflict={importCopied}
					pending={importSkill.isPending}
					error={importError}
					onCancel={() => setImportDraft(null)}
					onConfirm={() => {
						const complaint = localComplaint(importDraft);
						if (complaint) {
							setImportError(complaint);
							return;
						}
						setImportError(null);
						importSkill.mutate(importDraft);
					}}
				>
					<LabeledField label={tx("maidSkills.importName")}>
						{(aria) => (
							<TInput
								ariaLabel={aria}
								mono
								value={importDraft.name}
								disabled={importSkill.isPending}
								onChange={(name) => setImportDraft({ ...importDraft, name })}
							/>
						)}
					</LabeledField>
					<p className="text-bn-sm text-bn-text-secondary">{importDraft.description}</p>
					<pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-bn-sm bg-bn-surface-muted p-3 text-bn-sm text-bn-text-secondary">
						{importDraft.body}
					</pre>
					<p className="break-words text-bn-xs text-bn-text-tertiary">
						{tx("maidSkills.importTools", {
							tools: importDraft.allowedTools?.join(", ") || tx("maidSkills.toolsUnlimited"),
						})}
					</p>
					{importDraft.disableModelInvocation ? (
						<HintNote>{tx("maidSkills.manualOnly")}</HintNote>
					) : null}
				</ResourceImportDialog>
			) : null}
		</div>
	);
}
