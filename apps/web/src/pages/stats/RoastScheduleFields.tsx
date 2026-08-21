import {
	DEFAULT_ROAST_CRON,
	inboundGapReason,
	platformCanReceiveReply,
} from "@bilibili-notify/internal/constants";
import { PlatformIcon, Toggle, ToneChip } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { Field, Picker, TInput } from "../../components/forms";
import { AI_PURPLE } from "../../config/colors";
import { api } from "../../services/api";
import type { PushTarget } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";

import { STATS_RANGES } from "./ranges";

/**
 * 定时锐评的那几个字段 —— 全局榜单周报与 per-UP 单人锐评**共用这一份表单**。
 *
 * 两处的字段完全同形(`RoastSchedule` 一副形状供两边),各写一份的话,以后加一个
 * 字段就得改两个地方 —— 这一版里已经栽过两次「两边说得不一样」了。差别只有措辞
 * (「周报」/「锐评」)与要不要出「发送到」那栏,交给 props。
 *
 * 「周期」与「数据范围」是**分开的两个字段**:cron 定何时发,天数定统计多少天。
 * 界面上也不把它们绑在一起 —— 想要周报就配「每周一 + 7 天」,想每天看就配
 * 「每天 + 1 天」,不预设几档组合去限制人。
 *
 * 审批开关有个硬前提:主人的私聊通道得**收得到回复**。发不进来的通道上开了它,
 * 每期都会生成、私聊、然后 48 小时后超时作废,一份也发不出去 —— 所以这里置灰
 * 并说明,服务端也有同一道闸(见 checkApprovalReachable)。
 */

export type RoastScheduleValue = GlobalConfig["roastSchedule"];

/**
 * 审批能不能开,以及开不了时那句理由。
 *
 * 判据与理由都跟服务端取同一份(`platformCanReceiveReply` / `inboundGapReason`)——
 * 这里手写一句「只有 onebot」的话,哪天补了平台就会两边说得不一样。
 */
export function useApprovalReachability(): { canApprove: boolean; hint?: string } {
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const masterTargetId = globalsQuery.data?.master?.targetId;
	const masterTarget = (targetsQuery.data ?? []).find((t) => t.id === masterTargetId);
	const canApprove = platformCanReceiveReply(masterTarget?.platform ?? "");
	if (!masterTargetId) return { canApprove: false, hint: "需要先在「系统」里配好主人私聊目标" };
	if (!masterTarget) return { canApprove: false, hint: "配置里的主人私聊目标已经不存在了" };
	if (canApprove) return { canApprove: true };
	return { canApprove: false, hint: inboundGapReason(masterTarget.platform) };
}

export function RoastScheduleFields({
	value,
	onChange,
	/** 措辞:全局是「周报」,per-UP 是「锐评」。只影响说明文案。 */
	noun,
}: {
	value: RoastScheduleValue;
	onChange: (next: RoastScheduleValue) => void;
	noun: string;
}) {
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	// 停用的目标推不出去,列出来只会让人选中之后收一条「目标不可达」。
	const targets = (targetsQuery.data ?? []).filter((t) => t.enabled);
	const { canApprove, hint: approvalHint } = useApprovalReachability();

	const patch = (over: Partial<RoastScheduleValue>) => onChange({ ...value, ...over });

	const toggleTarget = (id: string) => {
		const has = value.targets.includes(id);
		patch({ targets: has ? value.targets.filter((t) => t !== id) : [...value.targets, id] });
	};

	// 三档预设与统计页头的范围切换同源。若配置里存的是别的天数(手改过配置文件),
	// 就临时补一档把它显示出来 —— 不然那格是空的,看不出现在到底统计几天,随手
	// 点一下就把原值悄悄换掉了。
	const presets = STATS_RANGES.map((r) => ({ value: r.days, label: r.label, color: AI_PURPLE }));
	const dayOptions = presets.some((o) => o.value === value.days)
		? presets
		: [...presets, { value: value.days, label: `近${value.days}日`, color: AI_PURPLE }];

	return (
		<>
			<div className="grid gap-3">
				<Field
					code="roastSchedule.cron"
					label="发送时间"
					hint="cron 表达式，如「0 9 * * 1」= 每周一早九点"
				>
					<TInput
						value={value.cron}
						onChange={(v) => patch({ cron: v })}
						placeholder={DEFAULT_ROAST_CRON}
					/>
				</Field>
				<Field
					code="roastSchedule.days"
					label="统计范围"
					hint={`${noun}往前统计多少天，与发送周期无关`}
				>
					<Picker value={value.days} onChange={(days) => patch({ days })} options={dayOptions} />
				</Field>
			</div>

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
						const on = value.targets.includes(t.id);
						return (
							<ToneChip key={t.id} tone={AI_PURPLE} active={on} onClick={() => toggleTarget(t.id)}>
								<PlatformIcon platform={t.platform} size={13} />
								{t.name}
							</ToneChip>
						);
					})}
				</div>
			</Field>

			<div className="mt-3 flex flex-col gap-2">
				<SwitchRow
					label="发送前先给主人过目"
					hint={approvalHint ?? "私聊发预览，回复 y 才进群；48 小时没回复就作废"}
					value={value.approval && canApprove}
					disabled={!canApprove}
					onChange={(v) => patch({ approval: v })}
				/>
				<SwitchRow
					label="没发出去时通知我"
					hint="生成失败、没配目标、群发失败都会私聊说明原因"
					value={value.notifyOnError}
					onChange={(v) => patch({ notifyOnError: v })}
				/>
			</div>
		</>
	);
}

export function SwitchRow({
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
