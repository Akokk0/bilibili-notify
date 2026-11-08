import type { StatsRoastRunNowResponse, StatsRoastRunResult } from "@bilibili-notify/contract";
import { Btn, ConfirmDialog } from "@bilibili-notify/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useT } from "../../i18n";
import { api } from "../../services/api";
import { errorTextOf } from "../../services/error-text";

/**
 * 「试一次」—— 立刻按现在这套配置跑一轮定时周报。
 *
 * **它不是模拟。** 服务端调的就是 cron 到点调的那个函数,所以:
 * - 审批关着 → 周报**真的会发进选中的那些群**;
 * - 审批开着 → 生成后私聊主人等 y,群里先不发(顺便也就把入站那条路一起验了)。
 *
 * 所以点之前必须先说清楚会发生什么 —— 一个写着「测试」的按钮把真周报发进了群,
 * 是这类按钮最容易造成的事故。文案按审批开关分两种,不含糊其辞。
 *
 * 另一件必须讲的:它读的是**已保存**的配置。面板上刚改完还没存,跑的就是旧那份。
 */
export function RoastRunNowBox({
	approval,
	targetCount,
	/** 面板上有没有还没保存的改动 —— 有的话这一轮跑的是旧配置。 */
	dirty,
	/** id → 群名。失败明细里报 UUID 的话,主人根本读不出是哪个群没收到。 */
	targetName,
	/** 给了就跑这条订阅的单人锐评(两支订阅都行);不给跑全局那条榜单周报。 */
	subscriptionId,
}: {
	approval: boolean;
	targetCount: number;
	dirty: boolean;
	targetName: (id: string) => string;
	subscriptionId?: string;
}) {
	const tx = useT();

	const [asking, setAsking] = useState(false);

	const run = useMutation<StatsRoastRunNowResponse>({
		// 订阅 id 进的是路径 —— 漏掉它会跑成一份全站榜单并真发进群,完全不是主人要试的东西。
		mutationFn: () =>
			api.post<StatsRoastRunNowResponse>(
				subscriptionId
					? `/api/stats/roast/run/${encodeURIComponent(subscriptionId)}`
					: "/api/stats/roast/run",
				{},
			),
	});

	// 这一轮没跑起来(服务没就绪 / 出了 bug)是非 2xx 的 { code, message },走 isError;跑完了(哪怕是
	// 「生成没成」「没配目标」)是 200 + 结局,由 OutcomeLine 说。
	const err = run.isError ? errorTextOf(run.error) : undefined;

	const noun = subscriptionId
		? tx("panelUi.pages.stats.RoastRunNowBox.1")
		: tx("panelUi.pages.stats.RoastRunNowBox.2");
	const confirmMessage = approval ? (
		<>
			{tx("panelUi.pages.stats.RoastRunNowBox.3")}
			{noun}
			{tx("panelUi.pages.stats.RoastRunNowBox.4")}
			<b>{tx("panelUi.pages.stats.RoastRunNowBox.5")}</b>
			{tx("panelUi.pages.stats.RoastRunNowBox.6")}
		</>
	) : (
		<>
			{tx("panelUi.pages.stats.RoastRunNowBox.7")}
			{noun}
			{tx("panelUi.pages.stats.RoastRunNowBox.8")}
			<b className="text-bn-danger-text">
				{tx("panelUi.pages.stats.RoastRunNowBox.9", { count: targetCount })}
			</b>
			{tx("panelUi.pages.stats.RoastRunNowBox.11")}
		</>
	);

	return (
		<div className="mt-3 border-t border-bn-border-subtle pt-3">
			<div className="flex flex-wrap items-center gap-2">
				<Btn
					size="sm"
					variant="outline"
					onClick={() => setAsking(true)}
					disabled={run.isPending || targetCount === 0}
				>
					{run.isPending
						? tx("panelUi.pages.stats.RoastRunNowBox.12")
						: tx("panelUi.pages.stats.RoastRunNowBox.13")}
				</Btn>
				<span className="text-bn-xs text-bn-text-tertiary">
					{targetCount === 0
						? tx("panelUi.pages.stats.RoastRunNowBox.14")
						: tx("panelUi.pages.stats.RoastRunNowBox.15")}
				</span>
			</div>

			{dirty ? (
				<div className="mt-1.5 text-bn-xs text-bn-warning-text">
					{tx("panelUi.pages.stats.RoastRunNowBox.16")}
					<b>{tx("panelUi.pages.stats.RoastRunNowBox.17")}</b>
					{tx("panelUi.pages.stats.RoastRunNowBox.18")}
				</div>
			) : null}

			{err ? (
				<div className="mt-2 text-bn-xs text-bn-danger-text">
					{tx("panelUi.pages.stats.RoastRunNowBox.19")}
					{err}
				</div>
			) : run.data ? (
				<OutcomeLine outcome={run.data.outcome} targetName={targetName} />
			) : null}

			{asking ? (
				<ConfirmDialog
					title={tx("panelUi.pages.stats.RoastRunNowBox.20", { value0: noun })}
					message={confirmMessage}
					confirmLabel={
						approval
							? tx("panelUi.pages.stats.RoastRunNowBox.21")
							: tx("panelUi.pages.stats.RoastRunNowBox.22")
					}
					danger={!approval}
					onCancel={() => setAsking(false)}
					onConfirm={() => {
						setAsking(false);
						run.mutate();
					}}
				/>
			) : null}
		</div>
	);
}

/**
 * 把结局翻成一句人话。
 *
 * 「发出去了」和「在等你批」是**两件完全不同的事**,含糊成一句「已完成」的话,
 * 开着审批的人会以为群里已经收到了。部分失败也必须说 —— 只报成功那几个,
 * 等于告诉主人一切正常。
 */
export function OutcomeLine({
	outcome,
	targetName,
}: {
	outcome: StatsRoastRunResult;
	targetName: (id: string) => string;
}) {
	const tx = useT();

	if (outcome.kind === "no-targets") {
		return (
			<div className="mt-2 text-bn-xs text-bn-danger-text">
				{tx("panelUi.pages.stats.RoastRunNowBox.23")}
			</div>
		);
	}
	if (outcome.kind === "gen-failed") {
		return (
			<div className="mt-2 text-bn-xs text-bn-danger-text">
				{tx("panelUi.pages.stats.RoastRunNowBox.24")}
				{outcome.message}
			</div>
		);
	}
	if (outcome.kind === "pending-approval") {
		return (
			<div className="mt-2 text-bn-xs text-bn-success-text">
				{tx("panelUi.pages.stats.RoastRunNowBox.25", { draftId: outcome.draftId })}
			</div>
		);
	}
	const mode =
		outcome.mode === "image"
			? tx("panelUi.pages.stats.RoastRunNowBox.27")
			: tx("panelUi.pages.stats.RoastRunNowBox.28");
	// 停用而跳过的单独说,不混进失败:停用是主人自己按的,不是「没发出去」;但也不能从
	// 总数里悄悄少一个,那会让人去查网络。
	const skipped =
		outcome.skipped.length > 0
			? tx("panelUi.pages.stats.RoastRunNowBox.29", {
					count: outcome.skipped.length,
					value1: outcome.skipped.map(targetName).join(tx("stats.roast.targetSeparator")),
				})
			: "";
	if (outcome.failed.length > 0) {
		return (
			<div className="mt-2 text-bn-xs text-bn-warning-text">
				{tx("panelUi.pages.stats.RoastRunNowBox.30", {
					sent: outcome.sent,
					count: outcome.failed.length,
					mode,
				})}
				{outcome.failed
					.map((f) => `${targetName(f.targetId)} ${f.message}`)
					.join(tx("stats.roast.failureSeparator"))}
				{skipped}
			</div>
		);
	}
	return (
		<div className="mt-2 text-bn-xs text-bn-success-text">
			{tx("panelUi.pages.stats.RoastRunNowBox.32", { count: outcome.sent, mode })}
			{skipped}
		</div>
	);
}
