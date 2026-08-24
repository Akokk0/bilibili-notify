import type { StatsSoloRoastResponse, StatsSoloRoastResult } from "@bilibili-notify/contract";
import { Avatar, StatusDot } from "@bilibili-notify/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../../services/api";
import { localTzOffset } from "../../services/stats";
import { RoastPushBox } from "./RoastPushBox";
import { RoastShell, roastError } from "./RoastShell";

/**
 * 单 UP 的 AI 锐评。
 *
 * 与榜单版是**两张不同的卡**,不是同一张的变体:榜单讲「谁比谁强」,离开对照组
 * 就不成立;这张只就这位 UP 自己的数据说话。所以后端也是两个端点、两套提示词。
 */
export function SoloRoastCard({
	uid,
	name,
	color,
	avatar,
	days,
}: {
	uid: string;
	name: string;
	color: string;
	avatar?: string;
	days: number;
}) {
	const roast = useMutation<StatsSoloRoastResponse>({
		// tz 同 RoastCard:漏了服务端就按 UTC 重算 overview,模型看到的不是屏幕上那份数。
		mutationFn: () =>
			api.post<StatsSoloRoastResponse>(
				`/api/stats/roast/${uid}?days=${days}&tz=${localTzOffset()}`,
				{},
			),
	});

	// 换时间范围要清掉上一份结论:组件的 key 只含 uid,切 days 不会重挂载,
	// 30 日的评分会原样留在写着「近7日」的卡里。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 就是要在 days 变化时清掉
	useEffect(() => {
		roast.reset();
	}, [days]);

	const result: StatsSoloRoastResult | undefined = roast.data?.ok ? roast.data.result : undefined;

	return (
		<RoastShell
			title={`AI 锐评 · ${name}`}
			subtitle={`把这位 UP 主近${days}日的数据交给智能女仆,单独点评`}
			pendingText="女仆正在阅读数据并撰写锐评"
			isPending={roast.isPending}
			err={roastError(roast)}
			onRun={() => roast.mutate()}
			idle={
				<>
					点一下,女仆会读完 <b className="text-bn-text-primary">{name}</b> 近 {days}{" "}
					天的涨粉、投稿与直播数据,给出一句总评、分维度点评和勤奋度评分 ~(*´∀`)~♡
				</>
			}
		>
			{result ? (
				<div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
					<div className="flex flex-col gap-3">
						<div className="flex items-start gap-3">
							<Avatar name={name} color={color} size={44} url={avatar} />
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm font-bold text-bn-text-primary">{name}</div>
								<div className="mt-1 text-xs leading-relaxed text-bn-text-tertiary">
									{result.verdict}
								</div>
							</div>
						</div>
						{result.highlights.length ? (
							<div className="flex flex-col gap-1.5">
								{result.highlights.map((h) => (
									<div key={h.label} className="flex gap-2 text-xs leading-relaxed">
										<StatusDot size="sm" color={color} className="mt-1.5" />
										<div>
											<b className="text-bn-text-primary">{h.label}</b>{" "}
											<span className="text-bn-text-tertiary">{h.comment}</span>
										</div>
									</div>
								))}
							</div>
						) : null}
						{result.pushText ? (
							<RoastPushBox
								days={days}
								label="可推送短评"
								text={result.pushText}
								payload={{ kind: "solo", result }}
							/>
						) : null}
					</div>

					<div className="flex flex-col justify-center rounded-bn-card border border-bn-border-subtle p-4">
						<div className="text-xs font-bold text-bn-text-primary">综合勤奋度评分</div>
						<div className="mb-3 text-bn-2xs text-bn-text-secondary">
							由女仆依据近{days}日数据评分 · 0–100
						</div>
						<div className="mb-2 flex items-baseline gap-1.5">
							<span className="tabular-nums text-4xl font-bold leading-none" style={{ color }}>
								{result.score}
							</span>
							<span className="text-xs text-bn-text-secondary">/ 100</span>
						</div>
						<div className="h-3 overflow-hidden rounded-full bg-bn-code-bg">
							<div
								className="h-full rounded-full"
								style={{ width: `${result.score}%`, background: color }}
							/>
						</div>
					</div>
				</div>
			) : null}
		</RoastShell>
	);
}
