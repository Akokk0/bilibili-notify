/**
 * **下播的附加项锚点**(词云 / AI 总结):各一个锚点、按「词云 → 总结」排;弹幕快照同步取,两样随即各自开始做
 * (互不等待,也不等下播卡),内容是各自的约定 —— 谁先做好不要紧,推送层按锚点先后发。
 * 哪个子项关着就没有它的锚点,两个都关着就不取快照、不算词云、不问 AI。
 *
 * 中立:吃订阅 id(弹幕记在谁名下)、两个附加项的开关、主播与粉丝团的名字,不认 uid、房号、B 站的视图。
 * **不判断「引擎拆了没有」**:那是宿主的事,调用方拿到锚点后把每个锚点的 `messages` 再包一层。
 */

import type { CommentaryCallOverride } from "@bilibili-notify/ai";
import type { CardSkinChoice } from "@bilibili-notify/image";
import type { ImageRef, Logger } from "@bilibili-notify/internal";
import type { LiveContentBuilder } from "../content-builder";
import type { LivePushAnchor } from "../live-types";
import type { DanmakuCollector } from "./danmaku-collector";
import type { LiveSummaryRequester } from "./live-summary-requester";
import { parseStopWords } from "./stop-words";
import type { WordcloudGenerator } from "./wordcloud-generator";

export interface RecapOptions {
	/** 弹幕是记在哪条订阅名下的。 */
	subscriptionId: string;
	/** 两个附加项各自开没开;都关着就什么都不做、不取快照。 */
	extras: { wordcloud: boolean; liveSummary: boolean };
	/** 这条订阅额外的停用词(设置里的原文);没有就不额外过滤。 */
	wordcloudStopWords?: string;
	/** 总结的文案模板(订阅的或全局的,调用方挑好)。 */
	summaryTemplate: string;
	/** 这条订阅的 AI 覆盖;没有就走 AI 自己的配置。 */
	aiOverride?: CommentaryCallOverride;
	/** 主播:名字与头像(图库引用,没有就不带)。 */
	creator: { name: string; avatar?: ImageRef };
	/** 粉丝团的名字;拿不到给空串。 */
	fanClubName: string;
	cardSkin?: string;
	cardSkinKnobs?: CardSkinChoice["cardSkinKnobs"];
}

export interface RecapDeps {
	collector: Pick<DanmakuCollector, "snapshot">;
	wordcloud: Pick<WordcloudGenerator, "generate">;
	summary: Pick<LiveSummaryRequester, "generate">;
	content: LiveContentBuilder;
	logger: Logger;
}

export function recapAnchors(options: RecapOptions, deps: RecapDeps): LivePushAnchor[] {
	const { extras, creator } = options;
	const { content } = deps;
	if (!extras.wordcloud && !extras.liveSummary) return [];

	deps.logger.debug(
		`[wordcloud] 开始制作下播总结 wordcloud=${extras.wordcloud} summary=${extras.liveSummary}`,
	);
	const snapshot = deps.collector.snapshot(options.subscriptionId);

	// 订阅额外停用词:记词时按 bundled + 全局过滤,这里对该订阅解析后的覆盖词再过滤一遍 sortedWords,
	// 使它在该订阅的词云 / 总结热词上额外生效。
	const extra = parseStopWords(options.wordcloudStopWords);
	const sortedWords = extra.length
		? snapshot.sortedWords.filter(([word]) => !extra.includes(word))
		: snapshot.sortedWords;

	// 什么都没做出来:给 undefined,那个锚点就跳过。
	const anchors: LivePushAnchor[] = [];
	if (extras.wordcloud) {
		anchors.push({
			role: "extra",
			extra: "wordcloud",
			messages: (async () => {
				const img = await deps.wordcloud.generate(
					sortedWords,
					creator.name,
					creator.avatar,
					options.cardSkin,
					options.cardSkinKnobs,
				);
				if (!img) return undefined;
				return [content.image(img, "image/jpeg")];
			})(),
		});
	}
	if (extras.liveSummary) {
		anchors.push({
			role: "extra",
			extra: "liveSummary",
			messages: (async () => {
				const summary = await deps.summary.generate({
					senderRecord: snapshot.senderRecord,
					sortedWords,
					fanClubName: options.fanClubName,
					customLiveSummary: options.summaryTemplate,
					aiOverride: options.aiOverride,
				});
				if (!summary) return undefined;
				return [content.text(summary)];
			})(),
		});
	}
	return anchors;
}
