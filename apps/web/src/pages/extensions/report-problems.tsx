import type { ExtensionDTO, ExtensionReportProblemView } from "@bilibili-notify/contract";
import { GlassBox, Icon, Pill } from "@bilibili-notify/ui";
import type { Subscription } from "../../types/domain";
import { displayName } from "../../utils/up-display";
import { RelativeTime } from "../up/relative-time";
import { featureLabelOf } from "../up/subscription-source";
import { PARAGRAPH_CLS } from "./shared";

/**
 * 拓展详情页的「上报问题」框(ADR-0019 决策 60):订阅源拓展报上来、BN 没照单全收的那几条 —— 丢了几格,
 * 或者整条拒了;外加周期「正在直播」因为拓展没报新状态而跳过的那几轮(决策 61)。**有问题才出现**(`ext.reportProblems` 服务端有才给);最近 20 条、新的在前,只在服务端
 * 内存里(重启 BN 就清空)。
 *
 * 原因只写进日志的话,主人看见「卡片少了一张图」不会想到去日志里搜;私聊的话,一个系统性的 bug 就是每条
 * 作品一条。所以放在这儿:想查的时候来看。
 */
export function ReportProblemsBox({
	ext,
	subs,
}: {
	ext: ExtensionDTO;
	/** 订阅列表 —— 按订阅 id 印名字。还没回来时先印外部 id。 */
	subs: readonly Subscription[] | undefined;
}) {
	const problems = ext.reportProblems ?? [];
	if (problems.length === 0) return null;
	const postNoun = ext.subscription?.display.postNoun;
	return (
		<section aria-label="上报问题">
			<GlassBox
				title="上报问题"
				badge={`${problems.length} 条`}
				subtitle="这个拓展报上来、BN 没照单全收的几条(最近 20 条,重启 BN 后清空)"
				accent="var(--color-bn-warning)"
				icon={<Icon.warning size={15} />}
			>
				<ul className="flex flex-col divide-y divide-bn-border-subtle">
					{problems.map((problem, index) => (
						<ProblemRow
							// 同一毫秒里可能有两条,时间当不了键;列表只会整份换,序号够用。
							// biome-ignore lint/suspicious/noArrayIndexKey: 整份替换的只读列表,没有增删动画
							key={index}
							problem={problem}
							who={whoOf(problem, subs)}
							kind={kindLabel(problem.kind, postNoun)}
						/>
					))}
				</ul>
			</GlassBox>
		</section>
	);
}

function ProblemRow({
	problem,
	who,
	kind,
}: {
	problem: ExtensionReportProblemView;
	who: string;
	kind: string;
}) {
	const rejected = problem.outcome === "rejected";
	return (
		<li className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<Pill
					size="sm"
					subtle
					color={rejected ? "var(--color-bn-danger)" : "var(--color-bn-warning)"}
				>
					{outcomeLabel(problem)}
				</Pill>
				<span className="text-bn-xs font-bold text-bn-text-primary">{who}</span>
				<span className="text-bn-xs text-bn-text-secondary">{kind}</span>
				<span
					className="ml-auto text-bn-2xs tabular-nums text-bn-text-tertiary"
					title={new Date(problem.at).toLocaleString()}
				>
					<RelativeTime at={problem.at} />
				</span>
			</div>
			{problem.reasons.map((reason, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 原因可能重句,整份替换的只读列表
				<p key={index} className={`${PARAGRAPH_CLS} break-words`}>
					{reason}
				</p>
			))}
		</li>
	);
}

/** 那颗药丸:整条拒了 / 丢了几格 / 周期「正在直播」因为没有新状态跳过了一轮(决策 61)。 */
function outcomeLabel(problem: ExtensionReportProblemView): string {
	switch (problem.outcome) {
		case "rejected":
			return "整条拒了";
		case "dropped":
			return `丢了 ${problem.reasons.length} 格`;
		case "skipped":
			return "跳过一轮";
	}
}

/**
 * 「哪条订阅」:按订阅 id 在订阅列表里找名字(同一个人订了几条、名字一样的只印一次);一条都找不到
 * (订阅删了、拓展报了不在它名下的人、列表还没回来)就印拓展报的外部 id。
 */
function whoOf(
	problem: ExtensionReportProblemView,
	subs: readonly Subscription[] | undefined,
): string {
	const names = new Set<string>();
	for (const id of problem.subscriptionIds) {
		const sub = subs?.find((one) => one.id === id);
		if (sub) names.add(displayName(sub));
	}
	return names.size > 0 ? [...names].join("、") : problem.externalId;
}

/** 报的哪一种。作品按平台叫法(`postNoun`,抖音叫「作品」,不给叫「动态」),开播 / 下播与订阅页同一套字。 */
function kindLabel(kind: ExtensionReportProblemView["kind"], postNoun: string | undefined): string {
	switch (kind) {
		case "post":
			return featureLabelOf("dynamic", { postNoun });
		case "liveStart":
			return featureLabelOf("live", { postNoun });
		case "liveEnd":
			return featureLabelOf("liveEnd", { postNoun });
		case "liveStatus":
			return "直播状态";
		case "profile":
			return "资料";
	}
}
