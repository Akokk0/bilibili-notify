/**
 * 「女仆技能」Tab —— 一条技能 = 一份 `SKILL.md`,主人在这儿写。
 *
 * 与隔壁三个 Tab 的一处**刻意不同**:这里不参与整页那条保存栏。技能不是配置,
 * 它是自己的一份 REST 资源(`/api/maid-skills`),每条各存各的。混进配置草稿的话,
 * 保存栏会开始声称一堆它根本管不着的改动。所以每条底下自带「保存」。
 *
 * 内置那几条**只读**(跟版本走,升级即生效),右侧照样摊开给主人看 —— 看得到
 * 它们怎么写的,自己写第一条时才有个照着抄的样子。
 */

import type { MaidSkillDTO, MaidSkillWriteRequest } from "@bilibili-notify/contract";
import { MAID_SKILL_LIMITS, MAID_SKILL_NAME_RE } from "@bilibili-notify/contract";
import {
	Btn,
	CheckRow,
	ErrorNote,
	GlassBox,
	Icon,
	LoadingBlock,
	Pill,
	SectionNav,
	WarnNote,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { TArea, TInput } from "../../components/forms";
import {
	createMaidSkill,
	deleteMaidSkill,
	listMaidSkills,
	maidSkillsQueryKey,
	updateMaidSkill,
} from "../../services/maidSkill";

/** 新建时右侧那份空白草稿。 */
const BLANK: MaidSkillWriteRequest = {
	name: "",
	description: "",
	disableModelInvocation: false,
	body: "",
};

/** 左栏那颗「新建」的哨兵 id —— 与任何合法技能名都撞不上(名字里没有斜杠)。 */
const NEW_ID = "/new";

function toDraft(s: MaidSkillDTO): MaidSkillWriteRequest {
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
	if (!MAID_SKILL_NAME_RE.test(d.name) || d.name.length > MAID_SKILL_LIMITS.nameChars) {
		return `名字只收小写字母 / 数字 / 单个连字符(如 weekly-report),最长 ${MAID_SKILL_LIMITS.nameChars} 字符`;
	}
	if (d.description.trim() === "") return "得写一句 description —— 女仆靠它决定要不要用这条";
	if (d.description.length > MAID_SKILL_LIMITS.descChars) {
		return `description 超长(上限 ${MAID_SKILL_LIMITS.descChars} 字)`;
	}
	if (d.body.trim() === "") return "正文是空的 —— 一条什么都不说的技能等于没有";
	if (d.body.length > MAID_SKILL_LIMITS.bodyChars) {
		return `正文超长(上限 ${MAID_SKILL_LIMITS.bodyChars} 字)`;
	}
	return null;
}

export function MaidSkills() {
	const qc = useQueryClient();
	const query = useQuery({ queryKey: maidSkillsQueryKey, queryFn: listMaidSkills });
	const list = query.data?.list ?? [];
	const problems = query.data?.problems ?? [];
	const tools = query.data?.tools ?? [];

	const [activeId, setActiveId] = useState<string | null>(null);
	const [draft, setDraft] = useState<MaidSkillWriteRequest>(BLANK);
	const [err, setErr] = useState<string | null>(null);

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
		onError: (e: Error) => setErr(e.message),
	});

	const remove = useMutation({
		mutationFn: deleteMaidSkill,
		onSuccess: () => {
			setErr(null);
			setActiveId(null);
			void invalidate();
		},
		onError: (e: Error) => setErr(e.message),
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

	if (query.isLoading) return <LoadingBlock label="正在读取技能" />;

	return (
		<div className="grid gap-4 xl:grid-cols-[220px_1fr]">
			<SectionNav
				heading="技能"
				items={[
					...list.map((s) => ({
						id: s.name,
						label: s.name,
						icon: <Icon.sparkle size={14} />,
						badge: s.builtin ? <Pill subtle>内置</Pill> : undefined,
					})),
					...(creating ? [{ id: NEW_ID, label: "新技能", icon: <Icon.plus size={14} /> }] : []),
				]}
				activeId={activeId ?? ""}
				onPick={(id) => {
					setErr(null);
					setActiveId(id);
					const picked = list.find((s) => s.name === id);
					if (picked) setDraft(toDraft(picked));
				}}
				onAdd={() => {
					setErr(null);
					setActiveId(NEW_ID);
					setDraft(BLANK);
				}}
				addLabel="+ 新建"
			/>

			<div className="flex min-w-0 flex-col gap-4">
				{problems.length > 0 ? (
					<WarnNote className="leading-relaxed">
						盘上有 {problems.length} 份读不进来:
						{problems.map((p) => `${p.dir}(${p.reason})`).join(";")}
					</WarnNote>
				) : null}

				<GlassBox
					title={creating ? "新建技能" : (current?.name ?? "技能")}
					subtitle={
						readOnly
							? "内置技能,只读跟版本走 —— 想改就照着它新建一条自己的"
							: "一条技能 = 一份 SKILL.md,存在 <dataDir>/maid-skills/<名字>/"
					}
					accent="var(--color-bn-pink)"
					icon={<Icon.sparkle size={14} />}
					badge={readOnly ? "builtin" : "skill"}
				>
					<div className="flex flex-col gap-3.5 p-1">
						{/* 用 div 而不是 <label> 包:label 一旦除标题外还含提示文字,读屏器念的
						    无障碍名就是**整段无分隔拼接**(实测「名字 · 也是斜杠命令小写字母 / 数字
						    / 单个连字符。它同时是……」)。名字改由控件自己的 ariaLabel 给,取可见
						    标题原文 —— WCAG 2.5.3 要求无障碍名包含可见标签。 */}
						<div className="flex flex-col gap-1.5">
							<span className="text-bn-sm font-semibold text-bn-text-secondary">
								名字 · 也是斜杠命令
							</span>
							<TInput
								ariaLabel="名字 · 也是斜杠命令"
								mono
								value={draft.name}
								disabled={readOnly}
								placeholder="weekly-report"
								onChange={(v) => setDraft({ ...draft, name: v })}
							/>
							<span className="text-bn-xs text-bn-text-tertiary">
								小写字母 / 数字 / 单个连字符。它同时是磁盘上的目录名,所以卡得比较死。 聊天里打{" "}
								<span className="font-mono">/{draft.name || "名字"}</span> 就是用它。
							</span>
						</div>

						<div className="flex flex-col gap-1.5">
							<span className="text-bn-sm font-semibold text-bn-text-secondary">
								description · 女仆靠它决定要不要用
							</span>
							<TInput
								ariaLabel="description · 女仆靠它决定要不要用"
								value={draft.description}
								disabled={readOnly}
								placeholder="一句话说清这条技能干什么"
								onChange={(v) => setDraft({ ...draft, description: v })}
							/>
							<span className="text-bn-xs text-bn-text-tertiary">
								{draft.description.length} / {MAID_SKILL_LIMITS.descChars} 字。这一句每轮对话都带着,
								所以有上限。
							</span>
						</div>

						<div className="flex flex-col gap-1.5">
							<span className="text-bn-sm font-semibold text-bn-text-secondary">
								正文 · 做事的步骤
							</span>
							{/* rows 而不是 min-h-*:TArea 的高度口子就是 rows,11 行 ≈ 原先那个
							    min-h-60(240px);拖动改高由 TArea 自带的 resize-y 提供。 */}
							<TArea
								ariaLabel="正文 · 做事的步骤"
								rows={11}
								mono
								value={draft.body}
								disabled={readOnly}
								placeholder={"## 步骤\n\n1. 先……\n2. 再……\n\n## 输出\n\n……"}
								onChange={(v) => setDraft({ ...draft, body: v })}
							/>
							<span className="text-bn-xs text-bn-text-tertiary">
								Markdown。这段会追加在女仆人格之后 —— 不必重新交代她是谁,只讲这件事怎么做。
							</span>
						</div>

						<div className="flex flex-col gap-1.5">
							<span className="text-bn-sm font-semibold text-bn-text-secondary">
								allowed-tools · 这条技能用得着哪几把
							</span>
							<span className="text-bn-xs text-bn-text-tertiary">
								一把都不勾 = 不限。勾了就只减不加:从这条技能被用上那一刻起,女仆手上只剩勾中的这些。
							</span>
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
										<span className="font-mono text-bn-sm">{t}</span>
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
								不让女仆自己挑这条(只许打斜杠)
							</CheckRow>
						</div>

						{err ? <ErrorNote className="mt-1">保存失败:{err}</ErrorNote> : null}

						{readOnly ? null : (
							<div className="mt-1 flex items-center gap-2">
								<Btn onClick={submit} disabled={save.isPending}>
									{save.isPending ? "保存中…" : "保存"}
								</Btn>
								{creating || !current ? null : (
									<Btn
										variant="danger"
										disabled={remove.isPending}
										onClick={() => remove.mutate(current.name)}
									>
										删除
									</Btn>
								)}
							</div>
						)}
					</div>
				</GlassBox>
			</div>
		</div>
	);
}
