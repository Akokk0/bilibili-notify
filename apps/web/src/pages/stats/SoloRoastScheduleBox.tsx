import { GlassPanel, Icon, Toggle } from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { AI_PURPLE } from "../../config/colors";
import { useDirtyDraft } from "../../hooks/useDirtyDraft";
import { api } from "../../services/api";
import type { PushTarget, Subscription } from "../../types/domain";
import { RoastRunNowBox } from "./RoastRunNowBox";
import { RoastScheduleFields, useApprovalReachability } from "./RoastScheduleFields";

/**
 * 这位 UP 的定时锐评。
 *
 * 与全局那条(`RoastScheduleBox`)并列同一个位置:页头切到某位 UP,下面这两张卡就
 * 从「榜单周报 + 榜单锐评」换成「这位的定时锐评 + 这位的锐评」。配置跟着看的人走,
 * 不必再跑去别的页面找。
 *
 * 排程本体住在 `Subscription.roastSchedule`(不是 overrides —— 全局那条排的是榜单
 * 周报,这条排的是「单独点评这一位」,两件事各开各的,没有「继承全局」可言)。
 *
 * 表单与全局共用 {@link RoastScheduleFields},字段不会两边漂。
 */
export function SoloRoastScheduleBox({ uid, name }: { uid: string; name: string }) {
	const qc = useQueryClient();
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const sub = (subsQuery.data ?? []).find((s) => s.uid === uid);

	const [draft, setDraft] = useState<Subscription["roastSchedule"] | null>(null);
	// `sub` 是从列表里 find 出来的:换一位 UP 就是另一个对象引用,effect 自然重跑。
	// (Stats 那边还按 uid 给这个组件上了 key,换人时整个重挂,这里只是第二道。)
	useEffect(() => {
		if (sub) setDraft(sub.roastSchedule);
	}, [sub]);

	const { canApprove } = useApprovalReachability();

	const save = useMutation({
		// 要发的东西走 variables,不从闭包里捞 —— 闭包捞到的是这一轮渲染的旧值。
		mutationFn: async (next: Subscription["roastSchedule"]) => {
			if (!sub) return;
			// 整份回传:服务端 deepMerge 对数组是整体替换,所以 targets 清空也是
			// 一次真的清除,不必再走 buildPatch。
			await api.patch<Subscription>(`/api/subs/${sub.id}`, { roastSchedule: next });
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	const baseline = sub?.roastSchedule ?? null;
	const saveMutate = save.mutateAsync;
	// 与全局那条共用 pageKey:两者**永远不会同时挂载**(页头选了某位 UP 就没有
	// 榜单那张),同一个 key 不会打架,而灵动岛上「数据统计」也就始终只有一条。
	// code 投影包一层 `roastSchedule`,与字典里那几条 code 对齐。
	useDirtyDraft({
		pageKey: "stats",
		pageLabel: `${name} · 定时锐评`,
		draft: draft ? { roastSchedule: draft } : null,
		baseline: baseline ? { roastSchedule: baseline } : null,
		onSave: useCallback(async () => {
			if (draft) await saveMutate(draft);
		}, [draft, saveMutate]),
		onDiscard: useCallback(() => setDraft(baseline), [baseline]),
	});

	if (!sub || !draft) return null;

	return (
		<GlassPanel
			title="定时锐评"
			subtitle={`到点自动点评 ${name} 并发到指定的群`}
			accent={AI_PURPLE}
			icon={<Icon.bell width={15} height={15} />}
			right={
				<Toggle
					value={draft.enabled}
					onChange={(v) => setDraft({ ...draft, enabled: v })}
					ariaLabel={`启用 ${name} 的定时锐评`}
				/>
			}
		>
			<RoastScheduleFields value={draft} onChange={setDraft} noun="锐评" />

			<RoastRunNowBox
				uid={uid}
				approval={draft.approval && canApprove}
				targetCount={draft.targets.length}
				dirty={JSON.stringify(draft) !== JSON.stringify(baseline)}
				targetName={(id) => (targetsQuery.data ?? []).find((t) => t.id === id)?.name ?? id}
			/>
		</GlassPanel>
	);
}
