import { buildPatch } from "@bilibili-notify/internal/patch";
import { GlassPanel, Icon, Toggle } from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useDirtyDraft } from "../../hooks/useDirtyDraft";
import { api } from "../../services/api";
import type { PushTarget } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";
import { RoastRunNowBox } from "./RoastRunNowBox";
import { RoastScheduleFields, useApprovalReachability } from "./RoastScheduleFields";
import { ROAST_PURPLE } from "./RoastShell";

/**
 * 全局那条榜单周报的配置。
 *
 * 表单本体在 {@link RoastScheduleFields} —— per-UP 单人锐评用的是同一份,这里只负责
 * 面板外壳、取数、保存与「试一次」。
 */
export function RoastScheduleBox() {
	const qc = useQueryClient();
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});

	const [draft, setDraft] = useState<GlobalConfig["roastSchedule"] | null>(null);
	useEffect(() => {
		if (globalsQuery.data) setDraft(globalsQuery.data.roastSchedule);
	}, [globalsQuery.data]);

	const { canApprove } = useApprovalReachability();

	const save = useMutation({
		// 要发的东西走 variables,不从闭包里捞 —— 闭包捞到的是这一轮渲染的旧值。
		mutationFn: async (next: GlobalConfig["roastSchedule"]) => {
			const base = globalsQuery.data?.roastSchedule;
			// 与基线 diff 而不是整份回传:`targets` 清空时,整份发是「[]」、
			// buildPatch 才知道这是一次真的清除。
			await api.patch<GlobalConfig>(
				"/api/globals",
				buildPatch({ roastSchedule: next }, { roastSchedule: base }),
			);
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	// 保存交给底部那枚草稿灵动岛(与 Rules / Cards / Ai / System 同一套),面板里
	// 不再自带保存按钮 —— 改了什么、要不要存,统一在同一个地方回答。
	const baseline = globalsQuery.data?.roastSchedule ?? null;
	const saveMutate = save.mutateAsync;
	// 投影时**包一层 `roastSchedule`**:直接把这个对象丢进去,walkTreeDiff 出的是
	// 裸 `cron` / `days`,而字典与 `<Field code>` 用的都是 `roastSchedule.cron`
	// —— 对不上就是灵动岛里显示一串裸 code、点它也跳不到那一栏。per-UP 那侧
	// (projectPerUpIsland)本来就是 nested,两边保持同一套 code。
	useDirtyDraft({
		pageKey: "stats",
		pageLabel: "数据统计",
		draft: draft ? { roastSchedule: draft } : null,
		baseline: baseline ? { roastSchedule: baseline } : null,
		// hook 会捕获 throw 并切到 error 态,所以这里要 await 到底、不吞异常。
		onSave: useCallback(async () => {
			if (draft) await saveMutate(draft);
		}, [draft, saveMutate]),
		onDiscard: useCallback(() => setDraft(baseline), [baseline]),
	});

	if (!draft) return null;

	return (
		<GlassPanel
			title="定时周报"
			subtitle="到点自动生成榜单并发到指定的群"
			accent={ROAST_PURPLE}
			icon={<Icon.bell width={15} height={15} />}
			right={
				<Toggle
					value={draft.enabled}
					onChange={(v) => setDraft({ ...draft, enabled: v })}
					ariaLabel="启用定时周报"
				/>
			}
		>
			<RoastScheduleFields value={draft} onChange={setDraft} noun="周报" />

			{/* 「试一次」读的是**已保存**的那份配置,所以要把「面板上还有没存的改动」
			    告诉它。脏判据用的是灵动岛同一对值(draft / baseline),不另立一套。 */}
			<RoastRunNowBox
				approval={draft.approval && canApprove}
				targetCount={draft.targets.length}
				dirty={JSON.stringify(draft) !== JSON.stringify(baseline)}
				targetName={(id) => (targetsQuery.data ?? []).find((t) => t.id === id)?.name ?? id}
			/>
		</GlassPanel>
	);
}
