import type {
	StatsRoastPushResponse,
	StatsRoastResult,
	StatsSoloRoastResult,
} from "@bilibili-notify/contract";
import { Btn, PlatformIcon } from "@bilibili-notify/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AI_PURPLE } from "../../config/colors";
import { api } from "../../services/api";
import type { PushTarget } from "../../types/domain";

/**
 * 「可推送周报」那一块 —— 显示女仆写的推送文案,并把它真发出去。
 *
 * 榜单卡与单人卡共用。推送的是**屏幕上这一份**:结果整个回传给服务端,服务端不
 * 重新调模型。主人是看过内容才点的推送,重新生成等于推出一份没人审过的文本。
 *
 * 推图还是推文字由服务端定(看图片渲染开关 + 渲染是否成功),前端只如实转述结果 ——
 * 渲染悄悄失败却显示「已推送」会让人以为群里收到的是卡片。
 */

type PushPayload =
	| { kind: "board"; result: StatsRoastResult }
	| { kind: "solo"; result: StatsSoloRoastResult };

export function RoastPushBox({
	days,
	label,
	text,
	payload,
}: {
	days: number;
	/** 区块标题:榜单是「可推送周报」,单人是「可推送短评」。 */
	label: string;
	text: string;
	payload: PushPayload;
}) {
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	// 停用的目标推不出去,列出来只会让人选中之后收一条「目标不可达」。
	const targets = (targetsQuery.data ?? []).filter((t) => t.enabled);
	const [picked, setPicked] = useState("");
	const targetId = picked || targets[0]?.id || "";

	const push = useMutation<StatsRoastPushResponse>({
		mutationFn: () =>
			api.post<StatsRoastPushResponse>("/api/stats/roast/push", { targetId, days, ...payload }),
	});

	// 换了推送目标就把上一次的结果收起来 —— 否则「✓ 已推送」会挂在一个还没推过的
	// 目标旁边,读起来像是这个目标也收到了。
	const onPick = (id: string) => {
		setPicked(id);
		push.reset();
	};

	const err = push.isError
		? ((push.error as Error)?.message ?? "推送失败")
		: push.data && !push.data.ok
			? push.data.err
			: undefined;

	return (
		<div className="rounded-bn-card border border-bn-border-subtle bg-bn-surface-muted p-3">
			<div className="mb-1.5 text-bn-2xs font-bold tracking-wide" style={{ color: AI_PURPLE }}>
				{label}
			</div>
			<div className="text-xs leading-relaxed text-bn-text-tertiary">{text}</div>

			<div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-bn-border-subtle pt-2.5">
				{targets.length === 0 ? (
					<span className="text-bn-xs text-bn-text-tertiary">
						{targetsQuery.isPending ? "正在读取推送目标…" : "还没有启用的推送目标"}
					</span>
				) : (
					<>
						<PlatformIcon platform={targets.find((t) => t.id === targetId)?.platform ?? ""} />
						<select
							value={targetId}
							onChange={(e) => onPick(e.target.value)}
							data-bn="input"
							className="min-w-40 rounded-lg border border-bn-border bg-bn-field px-2.5 py-1.5 text-bn-sm text-bn-text-secondary"
						>
							{targets.map((t) => (
								<option key={t.id} value={t.id}>
									{t.name}
								</option>
							))}
						</select>
						<Btn
							size="sm"
							variant="primary"
							onClick={() => push.mutate()}
							disabled={push.isPending}
						>
							{push.isPending ? "推送中…" : "推送"}
						</Btn>
					</>
				)}

				{err ? (
					<span className="text-bn-xs text-bn-danger-text">推送失败:{err}</span>
				) : push.data?.ok ? (
					<span className="text-bn-xs text-bn-success-text">
						✓ 已推送（{push.data.mode === "image" ? "卡片图" : "文字"}）
					</span>
				) : null}
			</div>
		</div>
	);
}
