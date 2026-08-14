import type { StatsRoastRunNowResponse, StatsRoastRunOutcome } from "@bilibili-notify/contract";
import { Btn, ConfirmDialog } from "@bilibili-notify/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../services/api";

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
	/** 给了就跑这位 UP 的单人锐评;不给跑全局那条榜单周报。 */
	uid,
}: {
	approval: boolean;
	targetCount: number;
	dirty: boolean;
	targetName: (id: string) => string;
	uid?: string;
}) {
	const [asking, setAsking] = useState(false);

	const run = useMutation<StatsRoastRunNowResponse>({
		// uid 进的是路径 —— 漏掉它会跑成一份全站榜单并真发进群,完全不是主人要试的东西。
		mutationFn: () =>
			api.post<StatsRoastRunNowResponse>(
				uid ? `/api/stats/roast/run-now/${encodeURIComponent(uid)}` : "/api/stats/roast/run-now",
				{},
			),
	});

	const err = run.isError
		? ((run.error as Error)?.message ?? "跑不起来")
		: run.data && !run.data.ok
			? run.data.err
			: undefined;

	const noun = uid ? "锐评" : "周报";
	const confirmMessage = approval ? (
		<>
			会立刻生成一份{noun}并私聊发给主人等你回 y，<b>群里先不发</b>。顺便也能验一下「回
			y」这条路通不通。
		</>
	) : (
		<>
			会立刻生成一份{noun}，并<b className="text-bn-danger-text">真的发到 {targetCount} 个群</b>
			里，不是演习。想先看过再发的话，请先打开上面的「发送前先给主人过目」。
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
					{run.isPending ? "跑一轮中…" : "试一次"}
				</Btn>
				<span className="text-[11px] text-bn-text-tertiary">
					{targetCount === 0
						? "先选一个发送目标"
						: "按现在保存好的配置立刻跑一轮，和到点自动跑走的是同一条路"}
				</span>
			</div>

			{dirty ? (
				<div className="mt-1.5 text-[11px] text-bn-warning-text">
					有还没保存的改动 —— 这一轮跑的是<b>已保存</b>的那份配置，先存一下再试。
				</div>
			) : null}

			{err ? (
				<div className="mt-2 text-[11px] text-bn-danger-text">跑不起来:{err}</div>
			) : run.data?.ok && run.data.outcome ? (
				<OutcomeLine outcome={run.data.outcome} targetName={targetName} />
			) : null}

			{asking ? (
				<ConfirmDialog
					title={`立刻跑一轮${noun}`}
					message={confirmMessage}
					confirmLabel={approval ? "生成并私聊我" : "真的发出去"}
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
function OutcomeLine({
	outcome,
	targetName,
}: {
	outcome: StatsRoastRunOutcome;
	targetName: (id: string) => string;
}) {
	if (outcome.kind === "no-targets") {
		return (
			<div className="mt-2 text-[11px] text-bn-danger-text">没有配置推送目标，这一轮跳过了</div>
		);
	}
	if (outcome.kind === "gen-failed") {
		return <div className="mt-2 text-[11px] text-bn-danger-text">没生成出来:{outcome.why}</div>;
	}
	if (outcome.kind === "pending-approval") {
		return (
			<div className="mt-2 text-[11px] text-bn-success-text">
				✓ 已生成并私聊给主人了，回一句「y {outcome.draftId}」就发出去（群里还没发）
			</div>
		);
	}
	const mode = outcome.mode === "image" ? "卡片图" : "文字";
	if (outcome.failed.length > 0) {
		return (
			<div className="mt-2 text-[11px] text-bn-warning-text">
				{outcome.sent} 个目标成功、{outcome.failed.length} 个失败（{mode}）：
				{outcome.failed.map((f) => `${targetName(f.targetId)} ${f.err}`).join("；")}
			</div>
		);
	}
	return (
		<div className="mt-2 text-[11px] text-bn-success-text">
			✓ 已发送到 {outcome.sent} 个目标（{mode}）
		</div>
	);
}
