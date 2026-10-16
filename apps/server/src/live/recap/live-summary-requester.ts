import type { CommentaryCallOverride, CommentaryProvider } from "@bilibili-notify/ai";
import type { Logger } from "@bilibili-notify/internal";
import { errorMessageOf } from "../../util/error-message";
import { renderLiveSummary } from "../live-text";

/**
 * Threshold below which the engine refuses to generate a live summary.
 * Mirrors the original live-service heuristic.
 */
export const LIVE_SUMMARY_MIN_SENDERS = 5;

/**
 * Hands back two bodies (ADR-0032): the template summary is always rendered
 * (`customLiveSummary` per-sub or the global default); the AI one is only made
 * when `commentary` is non-null and the gate is open — a prompt summarising
 * sender count, medal name, total danmaku, top-10 words and top-5 senders,
 * sent through `commentary.comment(prompt, "liveSummary")`. Which body a target
 * gets is the push layer's call, not ours.
 *
 * Returns `undefined` when sender count is below the threshold (signals the
 * caller to skip the summary push entirely).
 */
export class LiveSummaryRequester {
	private commentary: CommentaryProvider | null;
	private readonly isAiEnabled: () => boolean;
	private readonly isWebSearchEnabled: () => boolean;
	private readonly logger: Logger;

	constructor(opts: {
		commentary: CommentaryProvider | null;
		/**
		 * AI 那份要不要做的查询。返回 false 时跳过 commentary 调用,只交模板那份,
		 * 与 commentary === null 行为等价。Adapter 用 `() => globals.ai.enabled` 填充,
		 * 缺省 () => true。
		 */
		isAiEnabled?: () => boolean;
		/**
		 * 联网搜索开关查询。true 时给这一次 comment() 的 override 盖 webSearch 章;
		 * 执行器在不在是生成器的事。Adapter 用
		 * `() => globals.ai.search.engines.live` 填充,缺省 () => false ——
		 * 搜索按次付费,方向要紧:漏接的 adapter 拿到的是不烧钱的那侧。
		 */
		isWebSearchEnabled?: () => boolean;
		logger: Logger;
	}) {
		this.commentary = opts.commentary;
		this.isAiEnabled = opts.isAiEnabled ?? (() => true);
		this.isWebSearchEnabled = opts.isWebSearchEnabled ?? (() => false);
		this.logger = opts.logger;
	}

	/** 热替换 CommentaryProvider 实例。null 表示降级到模板回退。 */
	setCommentary(commentary: CommentaryProvider | null): void {
		this.commentary = commentary;
	}

	/**
	 * 同步交两份正文:`template` 恒在(此刻就渲染好);`ai` 只在门开着且有 commentary 时才有,是不会拒绝的
	 * 约定 —— 失败记 error、回空串都兑现成 `undefined`,由推送层回落模板(ADR-0032 决策 2)。
	 * 没有 AI 版就不带 `ai` 这个键。人数不足回 `undefined`,两份都没有、不问 AI。
	 */
	generate(params: {
		senderRecord: Record<string, number>;
		sortedWords: Array<[string, number]>;
		/** 粉丝团的名字;拿不到给空串。 */
		fanClubName: string;
		customLiveSummary: string;
		/**
		 * per-UP AI 覆盖。adapter 在 SubItemView.aiOverride 上注入,room-session 在调
		 * `generate()` 时透传过来。CommentaryProvider 内部 `?? this.config` 兜底,
		 * 缺失字段不影响其它字段生效。
		 */
		aiOverride?: CommentaryCallOverride;
	}): { template: string; ai?: Promise<string | undefined> } | undefined {
		const { senderRecord, sortedWords, fanClubName, customLiveSummary, aiOverride } = params;
		const senderCount = Object.keys(senderRecord).length;
		if (senderCount < LIVE_SUMMARY_MIN_SENDERS) {
			this.logger.debug(`[summary] 发言人数不足${LIVE_SUMMARY_MIN_SENDERS}位，放弃生成直播总结`);
			return undefined;
		}

		const viewerChatCount = Object.values(senderRecord).reduce((sum, val) => sum + val, 0);
		const top5Senders = Object.entries(senderRecord)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5);

		const template = renderLiveSummary({
			template: customLiveSummary,
			senderCount,
			fanClubName,
			viewerChatCount,
			topSenders: top5Senders,
		});
		const commentary = this.commentary;
		if (!commentary || !this.isAiEnabled()) return { template };

		const top10Words = sortedWords.slice(0, 10).map(([word, count]) => `${word}(${count})`);
		const prompt = [
			"请生成直播总结",
			`弹幕发言人数：${senderCount}`,
			`粉丝牌名：${fanClubName}`,
			`弹幕总数：${viewerChatCount}`,
			`热词TOP10：${top10Words.join("、")}`,
			`弹幕排行TOP5：${top5Senders.map(([u, c]) => `${u}(${c}条)`).join("、")}`,
		].join("，");
		// 联网搜索是引擎级开关,盖在 per-UP 覆盖之上(per-UP 没有这一项)。
		const override = this.isWebSearchEnabled() ? { ...aiOverride, webSearch: true } : aiOverride;
		const ai = (async (): Promise<string | undefined> => {
			try {
				const aiResult = await commentary.comment(prompt, "liveSummary", undefined, override);
				this.logger.debug(`[summary] AI 直播总结生成完毕，长度=${aiResult.length}`);
				// 空串不是一份正文:当没有 AI 版,让推送层用模板。
				return aiResult || undefined;
			} catch (e) {
				this.logger.error(`[summary] AI 直播总结生成失败：${errorMessageOf(e)}，所有目标用模板`);
				return undefined;
			}
		})();
		return { template, ai };
	}
}
