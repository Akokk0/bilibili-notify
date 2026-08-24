import type { StatsRoastResponse, StatsRoastResult } from "@bilibili-notify/contract";
import { Avatar, Icon } from "@bilibili-notify/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { AI_PURPLE } from "../../config/colors";
import { api } from "../../services/api";
import { localTzOffset } from "../../services/stats";
import { RoastPushBox } from "./RoastPushBox";
import { RoastShell, roastError } from "./RoastShell";

interface UpMeta {
	name: string;
	color: string;
	/** B 站头像 URL;没缓存到时 Avatar 退回首字母。 */
	avatar?: string;
}

/**
 * AI 锐评卡 —— 把统计数据喂给智能女仆,评鸽王 / 勤奋 UP 并生成可推送的周报。
 *
 * 只在「全部 UP」视图出现:单人视图下没有可比较的对象,评不出榜。
 */
export function RoastCard({ days, meta }: { days: number; meta: Map<string, UpMeta> }) {
	const roast = useMutation<StatsRoastResponse>({
		// 必须带 tz:服务端会拿这两个参数重算一遍 overview,漏了就按 parseTz(undefined)
		// = UTC 分桶,喂给模型的净增与屏幕上的数对不上,榜单也是据此排的。
		mutationFn: () =>
			api.post<StatsRoastResponse>(`/api/stats/roast?days=${days}&tz=${localTzOffset()}`, {}),
	});

	// 换了时间范围,上一份结论讲的是另一个窗口 —— 留在屏幕上会被 RoastShell 的副标题
	// 和评分说明重新标成新窗口的结论,用户看到的是贴着「近7日」标签的 30 日数字。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 就是要在 days 变化时清掉
	useEffect(() => {
		roast.reset();
	}, [days]);

	const result: StatsRoastResult | undefined = roast.data?.ok ? roast.data.result : undefined;

	const nameOf = (uid: string) => meta.get(uid)?.name ?? `UID ${uid}`;
	const colorOf = (uid: string) => meta.get(uid)?.color ?? AI_PURPLE;
	const avatarOf = (uid: string) => meta.get(uid)?.avatar;

	return (
		<RoastShell
			title="AI 锐评 · 鸽王 vs 勤奋 UP"
			subtitle="把统计数据交给智能女仆,自动评榜并生成可推送的周报"
			pendingText="女仆正在阅读数据并撰写锐评"
			isPending={roast.isPending}
			err={roastError(roast)}
			onRun={() => roast.mutate()}
			idle={
				<>
					点一下,女仆会读完这批 UP 主近 {days} 天的涨粉、投稿与直播数据,评出本期
					<b className="text-bn-danger-text">鸽王</b>和
					<b className="text-bn-success-text">勤奋 UP</b>
					,并整理成一段可直接发到群里的周报 ~(*´∀`)~♡
				</>
			}
		>
			{result ? (
				<div className="grid gap-4 lg:grid-cols-2">
					<div className="flex flex-col gap-3">
						<div className="grid grid-cols-2 gap-2.5">
							{(
								[
									// 图标与推送卡片模板(SVG_FEATHER / SVG_TROPHY)同一套语义,改一边记得改另一边。
									[Icon.feather, "本期鸽王", result.pigeon, "var(--color-bn-danger-text)"],
									[Icon.trophy, "勤奋 UP", result.diligent, "var(--color-bn-success-text)"],
								] as const
							).map(([Glyph, label, who, color]) => (
								<div
									key={label}
									className="rounded-bn-card border border-bn-border-subtle bg-bn-surface-muted px-3 py-2.5"
								>
									<div
										className="mb-1.5 flex items-center gap-1 text-bn-2xs font-bold"
										style={{ color }}
									>
										<Glyph size={12} />
										{label}
									</div>
									<div className="mb-1.5 flex items-center gap-1.5">
										<Avatar
											name={nameOf(who.uid)}
											color={colorOf(who.uid)}
											size={24}
											url={avatarOf(who.uid)}
										/>
										<span className="truncate text-sm font-bold text-bn-text-primary">
											{nameOf(who.uid)}
										</span>
									</div>
									<div className="text-bn-xs leading-relaxed text-bn-text-tertiary">
										{who.reason}
									</div>
								</div>
							))}
						</div>
						{result.roast.length ? (
							<div className="flex flex-col gap-1.5">
								{result.roast.map((r) => (
									<div key={`${r.uid}-${r.comment}`} className="flex gap-2 text-xs leading-relaxed">
										<span
											className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
											style={{ background: colorOf(r.uid) }}
										/>
										<div>
											<b className="text-bn-text-primary">{nameOf(r.uid)}</b>{" "}
											<span className="text-bn-text-tertiary">{r.comment}</span>
										</div>
									</div>
								))}
							</div>
						) : null}
						{result.pushText ? (
							<RoastPushBox
								days={days}
								label="可推送周报"
								text={result.pushText}
								payload={{ kind: "board", result }}
							/>
						) : null}
					</div>

					<div className="rounded-bn-card border border-bn-border-subtle p-3.5">
						<div className="text-xs font-bold text-bn-text-primary">综合勤奋度评分</div>
						<div className="mb-3 text-bn-2xs text-bn-text-secondary">
							由女仆依据本期数据评分 · 0–100
						</div>
						<div className="flex flex-col gap-2.5">
							{[...result.scores]
								.sort((a, b) => b.score - a.score)
								.map((s) => (
									<div key={s.uid} className="flex items-center gap-2 text-bn-xs">
										<span className="w-16 truncate font-semibold text-bn-text-primary">
											{nameOf(s.uid)}
										</span>
										<div className="h-3 flex-1 overflow-hidden rounded-full bg-bn-code-bg">
											<div
												className="h-full rounded-full"
												style={{ width: `${s.score}%`, background: colorOf(s.uid) }}
											/>
										</div>
										<span className="w-7 text-right tabular-nums font-bold text-bn-text-tertiary">
											{s.score}
										</span>
									</div>
								))}
						</div>
					</div>
				</div>
			) : null}
		</RoastShell>
	);
}
