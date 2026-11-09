import type {
	ExtensionEntryView,
	ReportDiscrepancyView,
	SourceEntry,
} from "@bilibili-notify/contract";
import { GlassBox, Icon, Pill } from "@bilibili-notify/ui";
import { useSources } from "../../hooks/useSources";
import { i18n, useT, useTextOptions } from "../../i18n";
import type { Subscription } from "../../types/domain";
import { displayName } from "../../utils/creator-display";
import { RelativeTime } from "../subscriptions/relative-time";
import { featureLabelOf, subscriptionPlatformOf } from "../subscriptions/subscription-source";
import { PARAGRAPH_CLS } from "./shared";

/**
 * 拓展详情页的「上报出入」框(ADR-0019 决策 60):订阅源拓展报上来、BN 没照单全收的那几条 —— 动了几格
 * (丢掉或截断),或者整条拒了;外加周期「正在直播」因为拓展没报新状态而跳过的那几轮(决策 61)。**有问题才出现**(`ext.reportDiscrepancies` 服务端有才给);最近 20 条、新的在前,只在服务端
 * 内存里(重启 BN 就清空)。
 *
 * 原因只写进日志的话,主人看见「卡片少了一张图」不会想到去日志里搜;私聊的话,一个系统性的 bug 就是每条
 * 作品一条。所以放在这儿:想查的时候来看。
 */
export function ReportDiscrepanciesBox({
	ext,
	subs,
}: {
	ext: ExtensionEntryView;
	/** 订阅列表 —— 按订阅 id 印名字。还没回来时先印外部 id。 */
	subs: readonly Subscription[] | undefined;
}) {
	const t = useT();
	// 作品那一类按这个平台的叫法写(来源表里的描述符,取自清单)。
	const sources = useSources().data?.sources;
	const liveLabel = t("extension.reportDiscrepancies.kindLive");
	const problemLabel = t("extension.reportDiscrepancies.kindProblem");
	const discrepancies = ext.reportDiscrepancies ?? [];
	if (discrepancies.length === 0) return null;
	const postNoun = sources?.find((one) => one.key === ext.id)?.descriptor.postNoun;
	return (
		<section aria-label={t("sourceUi.pages.extensions.report.discrepancies.arialabel.1")}>
			<GlassBox
				title={t("sourceUi.pages.extensions.report.discrepancies.arialabel.1")}
				badge={t("extension.reportDiscrepancies.count", { count: discrepancies.length })}
				subtitle={t("sourceUi.pages.extensions.report.discrepancies.subtitle.2")}
				accent="var(--color-bn-warning)"
				icon={<Icon.warning size={15} />}
			>
				<ul className="flex flex-col divide-y divide-bn-border-subtle">
					{discrepancies.map((discrepancy, index) => (
						<DiscrepancyRow
							// 同一毫秒里可能有两条,时间当不了键;列表只会整份换,序号够用。
							// biome-ignore lint/suspicious/noArrayIndexKey: 整份替换的只读列表,没有增删动画
							key={index}
							discrepancy={discrepancy}
							who={whoOf(discrepancy, subs, sources)}
							kind={kindLabel(discrepancy.kind, postNoun, liveLabel, problemLabel)}
						/>
					))}
				</ul>
			</GlassBox>
		</section>
	);
}

function DiscrepancyRow({
	discrepancy,
	who,
	kind,
}: {
	discrepancy: ReportDiscrepancyView;
	who: string | undefined;
	kind: string;
}) {
	const rejected = discrepancy.outcome === "rejected";
	const { locale } = useTextOptions();
	return (
		<li className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<Pill
					size="sm"
					subtle
					color={rejected ? "var(--color-bn-danger)" : "var(--color-bn-warning)"}
				>
					{outcomeLabel(discrepancy)}
				</Pill>
				{who ? <span className="text-bn-xs font-bold text-bn-text-primary">{who}</span> : null}
				<span className="text-bn-xs text-bn-text-secondary">{kind}</span>
				<span
					className="ml-auto text-bn-2xs tabular-nums text-bn-text-tertiary"
					title={new Date(discrepancy.at).toLocaleString(locale)}
				>
					<RelativeTime at={discrepancy.at} />
				</span>
			</div>
			{discrepancy.reasons.map((reason, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 原因可能重句,整份替换的只读列表
				<p key={index} className={`${PARAGRAPH_CLS} break-words`}>
					{reason}
				</p>
			))}
		</li>
	);
}

/**
 * 那颗药丸:整条拒了 / 动了几格。「动了」不说「丢了」:
 * 超长的正文与视频标题是截断收下的(决策 59 的 09-24 🔗),也走 `dropped` 这一种 —— 丢了还是截了由每一句自己说。
 */
function outcomeLabel(discrepancy: ReportDiscrepancyView): string {
	switch (discrepancy.outcome) {
		case "rejected":
			return i18n.t("sourceUi.pages.extensions.report.discrepancies.outcomeLabel.3");
		case "dropped":
			return i18n.t("sourceUi.pages.extensions.report.discrepancies.outcomeLabel.4", {
				value1: discrepancy.reasons.length,
			});
	}
}

/**
 * 「哪条订阅」:按订阅 id 在订阅列表里找名字(同一个人订了几条、名字一样的只印一次);一条都找不到
 * (订阅删了、拓展报了不在它名下的人、列表还没回来)就印拓展报的外部 id。
 */
function whoOf(
	discrepancy: ReportDiscrepancyView,
	subs: readonly Subscription[] | undefined,
	sources: readonly SourceEntry[] | undefined,
): string | undefined {
	const names = new Set<string>();
	for (const id of discrepancy.subscriptionIds) {
		const sub = subs?.find((one) => one.id === id);
		if (sub) names.add(displayName(sub, subscriptionPlatformOf(sub.identity, sources)));
	}
	return names.size > 0 ? [...names].join("、") : discrepancy.externalId;
}

/** 报的哪一种。作品按平台叫法(`postNoun`,抖音叫「作品」,不给叫「动态」)。 */
function kindLabel(
	kind: ReportDiscrepancyView["kind"],
	postNoun: string | undefined,
	/** 第 3 版 `live` 一条的标签(面板字典里的字,调用方取好递进来)。 */
	liveLabel: string,
	/** 问题上报被拒的标签(面板字典里的字,调用方取好递进来)。 */
	problemLabel: string,
): string {
	switch (kind) {
		case "live":
			return liveLabel;
		case "problem":
			return problemLabel;
		case "post":
			return featureLabelOf("post", { postNoun });
		case "profile":
			return i18n.t("sourceUi.pages.extensions.report.discrepancies.kindLabel.5");
	}
}
