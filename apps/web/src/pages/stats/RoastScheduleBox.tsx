import {
	DEFAULT_ROAST_CRON,
	ROAST_MAX_DAYS,
	ROAST_MIN_DAYS,
} from "@bilibili-notify/internal/constants";
import { buildPatch } from "@bilibili-notify/internal/patch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Btn, PlatformIcon, Toggle } from "../../components/atoms";
import { Field, TInput } from "../../components/forms";
import { GlassPanel } from "../../components/glass";
import { Icon } from "../../components/icons";
import { api } from "../../services/api";
import type { PushTarget } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";
import { ROAST_PURPLE } from "./RoastShell";

/**
 * 定时周报的配置。
 *
 * 「周期」与「数据范围」是**分开的两个字段**:cron 定何时发,天数定统计多少天。
 * 界面上也不把它们绑在一起 —— 主人想要周报就配「每周一 + 7 天」,想每天看就配
 * 「每天 + 1 天」,不预设几档组合去限制人。
 *
 * 审批开关有个硬前提:主人的私聊通道得**收得到回复**。webhook 这类只出不进的
 * 通道上开了它,每期都会生成、私聊、然后 48 小时后超时作废,一份也发不出去 ——
 * 所以这里直接置灰并说明,服务端也有同一道闸(见 checkApprovalEnable)。
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

	// 停用的目标推不出去,列出来只会让人选中之后收一条「目标不可达」。
	const targets = (targetsQuery.data ?? []).filter((t) => t.enabled);

	// 主人私聊那条通道所在的平台 —— 审批能不能开就看它收不收得到回复。
	const masterTargetId = globalsQuery.data?.master?.targetId;
	const masterTarget = (targetsQuery.data ?? []).find((t) => t.id === masterTargetId);
	// 与服务端同一份判据(INBOUND_CAPABLE_PLATFORMS):目前只有 OneBot 实现了入站。
	const canApprove = masterTarget?.platform === "onebot";
	const approvalHint = !masterTargetId
		? "需要先在「系统」里配好主人私聊目标"
		: !masterTarget
			? "配置里的主人私聊目标已经不存在了"
			: canApprove
				? undefined
				: `主人私聊走的是 ${masterTarget.platform}，这个通道只能发不能收，回复的 y 收不到`;

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

	if (!draft) return null;
	const patch = (over: Partial<GlobalConfig["roastSchedule"]>) => setDraft({ ...draft, ...over });

	const toggleTarget = (id: string) => {
		const has = draft.targets.includes(id);
		patch({ targets: has ? draft.targets.filter((t) => t !== id) : [...draft.targets, id] });
	};

	const daysInvalid = draft.days < ROAST_MIN_DAYS || draft.days > ROAST_MAX_DAYS;

	return (
		<GlassPanel
			title="定时周报"
			subtitle="到点自动生成榜单并发到指定的群"
			accent={ROAST_PURPLE}
			icon={<Icon.bell width={15} height={15} />}
			right={
				<Toggle
					value={draft.enabled}
					onChange={(v) => patch({ enabled: v })}
					ariaLabel="启用定时周报"
				/>
			}
		>
			<div className="grid gap-3">
				<Field
					code="roastSchedule.cron"
					label="发送时间"
					hint="cron 表达式，如「0 9 * * 1」= 每周一早九点"
				>
					<TInput
						value={draft.cron}
						onChange={(v) => patch({ cron: v })}
						placeholder={DEFAULT_ROAST_CRON}
					/>
				</Field>
				<Field
					code="roastSchedule.days"
					label="统计范围"
					hint={`往前统计多少天（${ROAST_MIN_DAYS}–${ROAST_MAX_DAYS}），与发送周期无关`}
				>
					<TInput
						value={String(draft.days)}
						onChange={(v) => patch({ days: Number(v) || ROAST_MIN_DAYS })}
					/>
				</Field>
			</div>
			{daysInvalid && (
				<div className="text-[12px] mt-1" style={{ color: "#e5484d" }}>
					统计天数要在 {ROAST_MIN_DAYS}–{ROAST_MAX_DAYS} 之间
				</div>
			)}

			<Field
				code="roastSchedule.targets"
				label="发送到"
				hint="可以选多个群；一个群发失败不影响其他群"
			>
				<div className="flex flex-wrap gap-2">
					{targets.length === 0 && (
						<div className="text-[12px] opacity-60">还没有可用的推送目标</div>
					)}
					{targets.map((t) => {
						const on = draft.targets.includes(t.id);
						return (
							<button
								type="button"
								key={t.id}
								onClick={() => toggleTarget(t.id)}
								className="flex items-center gap-1 px-2 py-1 rounded-lg text-[12px]"
								style={{
									border: `1px solid ${on ? ROAST_PURPLE : "rgba(128,128,128,.35)"}`,
									background: on ? `${ROAST_PURPLE}1a` : "transparent",
								}}
							>
								<PlatformIcon platform={t.platform} size={13} />
								{t.name}
							</button>
						);
					})}
				</div>
			</Field>

			<div className="mt-3 flex flex-col gap-2">
				<SwitchRow
					label="发送前先给主人过目"
					hint={approvalHint ?? "私聊发预览，回复 y 才进群；48 小时没回复就作废"}
					value={draft.approval && canApprove}
					disabled={!canApprove}
					onChange={(v) => patch({ approval: v })}
				/>
				<SwitchRow
					label="没发出去时通知我"
					hint="生成失败、没配目标、群发失败都会私聊说明原因"
					value={draft.notifyOnError}
					onChange={(v) => patch({ notifyOnError: v })}
				/>
				<SwitchRow
					label="发出去后抄送我一份"
					hint="群里发了什么，同一份也私聊给主人留个底"
					value={draft.ccMaster}
					onChange={(v) => patch({ ccMaster: v })}
				/>
			</div>

			<div className="flex items-center gap-2 mt-4">
				<Btn onClick={() => save.mutate(draft)} disabled={save.isPending || daysInvalid}>
					{save.isPending ? "保存中…" : "保存"}
				</Btn>
				{save.isSuccess && <span className="text-[12px] opacity-70">✓ 已保存</span>}
				{save.isError && (
					<span className="text-[12px]" style={{ color: "#e5484d" }}>
						{save.error instanceof Error ? save.error.message : "保存失败"}
					</span>
				)}
			</div>
		</GlassPanel>
	);
}

function SwitchRow({
	label,
	hint,
	value,
	onChange,
	disabled,
}: {
	label: string;
	hint?: string;
	value: boolean;
	onChange: (v: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<div
			className="flex items-start justify-between gap-3"
			style={{ opacity: disabled ? 0.55 : 1 }}
		>
			<div>
				<div className="text-[13px]">{label}</div>
				{hint && <div className="text-[12px] opacity-60">{hint}</div>}
			</div>
			<Toggle value={value} onChange={onChange} disabled={disabled} ariaLabel={label} />
		</div>
	);
}
