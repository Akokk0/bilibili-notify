import type {
	StatsRoastPushResponse,
	StatsRoastResult,
	StatsSoloRoastResult,
} from "@bilibili-notify/contract";
import { Btn } from "@bilibili-notify/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { TSelect } from "../../components/forms";
import { targetDisplay } from "../../components/target-display";
import { AI_PURPLE } from "../../config/colors";
import { useT } from "../../i18n";
import { api } from "../../services/api";
import { errorTextOf } from "../../services/error-text";
import type { Connection, PushTarget } from "../../types/domain";

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
	const t = useT();
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	// 图标的平台取自目标挂着的连接。
	const connectionsQuery = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
	});
	// 停用的目标推不出去,列出来只会让人选中之后收一条「目标不可达」。
	const targets = (targetsQuery.data ?? []).filter((target) => target.enabled);
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

	// 两条失败的路:请求本身不对(引擎没起 / 目标没了 / 目标已停用)是非 2xx,走 isError;
	// 请求没问题、一个目标都没送到是 200 + { ok: false, code, message },`message` 是投递那头的原话。
	const err = push.isError
		? errorTextOf(push.error)
		: push.data && !push.data.ok
			? push.data.message
			: undefined;

	return (
		<div className="rounded-bn-card border border-bn-border-subtle bg-bn-surface-muted p-3">
			<div className="mb-1.5 text-bn-2xs font-bold tracking-wide" style={{ color: AI_PURPLE }}>
				{label}
			</div>
			<div className="text-bn-sm leading-relaxed text-bn-text-tertiary">{text}</div>

			<div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-bn-border-subtle pt-2.5">
				{targets.length === 0 ? (
					<span className="text-bn-xs text-bn-text-tertiary">
						{targetsQuery.isPending ? t("stats.push.loadingTargets") : t("stats.push.noTargets")}
					</span>
				) : (
					<>
						<TSelect
							ariaLabel={t("stats.push.target")}
							value={targetId}
							onChange={onPick}
							options={targets.map((target) => targetDisplay(target, connectionsQuery.data ?? []))}
						/>
						<Btn
							size="sm"
							variant="primary"
							onClick={() => push.mutate()}
							disabled={push.isPending}
						>
							{push.isPending ? t("stats.push.sending") : t("stats.push.send")}
						</Btn>
					</>
				)}

				{err ? (
					<span className="text-bn-xs text-bn-danger-text">
						{t("stats.push.failed", { error: err })}
					</span>
				) : push.data?.ok ? (
					<span className="text-bn-xs text-bn-success-text">
						{t("stats.push.sent", {
							mode: push.data.mode === "image" ? t("stats.push.image") : t("stats.push.text"),
						})}
					</span>
				) : null}
			</div>
		</div>
	);
}
