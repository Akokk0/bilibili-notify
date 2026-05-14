import type { CommentaryCallOverride, CommentaryGenerator } from "@bilibili-notify/ai";
import type { Logger } from "@bilibili-notify/internal";
import type { LiveTemplateRenderer } from "./template-renderer";
import type { MasterInfo } from "./types";

/**
 * Threshold below which the engine refuses to generate a live summary.
 * Mirrors the original live-service heuristic.
 */
export const LIVE_SUMMARY_MIN_SENDERS = 5;

/**
 * Builds the AI prompt + dispatches it through {@link CommentaryGenerator},
 * falling back to the template-based summary when AI is unavailable or fails.
 *
 * Two-tier strategy (kept identical to live-service):
 * 1. If `commentary` is non-null, build a prompt summarising sender count,
 *    medal name, total danmaku, top-10 words and top-5 senders, then call
 *    `commentary.comment(prompt, "liveSummary")`.
 * 2. On failure (AI not configured / API error), fall back to the user-supplied
 *    template (`customLiveSummary` per-sub or the global default).
 *
 * Returns `undefined` when sender count is below the threshold (signals the
 * caller to skip the summary push entirely).
 */
export class LiveSummaryRequester {
	private commentary: CommentaryGenerator | null;
	private readonly isAiEnabled: () => boolean;
	private readonly templateRenderer: LiveTemplateRenderer;
	private readonly logger: Logger;

	constructor(opts: {
		commentary: CommentaryGenerator | null;
		/**
		 * AI 总开关查询。返回 false 时跳过 commentary 调用,直接走模板回退,
		 * 与 commentary === null 行为等价。Adapter 用 `() => globals.defaults.ai.enabled` 填充,
		 * 缺省 () => true。
		 */
		isAiEnabled?: () => boolean;
		templateRenderer: LiveTemplateRenderer;
		logger: Logger;
	}) {
		this.commentary = opts.commentary;
		this.isAiEnabled = opts.isAiEnabled ?? (() => true);
		this.templateRenderer = opts.templateRenderer;
		this.logger = opts.logger;
	}

	/** 热替换 CommentaryGenerator 实例。null 表示降级到模板回退。 */
	setCommentary(commentary: CommentaryGenerator | null): void {
		this.commentary = commentary;
	}

	async generate(params: {
		senderRecord: Record<string, number>;
		sortedWords: Array<[string, number]>;
		master: MasterInfo | undefined;
		customLiveSummary: string;
		/**
		 * per-UP AI 覆盖。adapter 在 SubItemView.aiOverride 上注入,room-session 在调
		 * `generate()` 时透传过来。CommentaryGenerator 内部 `?? this.config` 兜底,
		 * 缺失字段不影响其它字段生效。
		 */
		aiOverride?: CommentaryCallOverride;
	}): Promise<string | undefined> {
		const { senderRecord, sortedWords, master, customLiveSummary, aiOverride } = params;
		const senderCount = Object.keys(senderRecord).length;
		if (senderCount < LIVE_SUMMARY_MIN_SENDERS) {
			this.logger.debug(`[summary] 发言人数不足${LIVE_SUMMARY_MIN_SENDERS}位，放弃生成直播总结`);
			return undefined;
		}

		const danmakuCount = Object.values(senderRecord).reduce((sum, val) => sum + val, 0);
		const top5Senders = Object.entries(senderRecord)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5);

		if (this.commentary && this.isAiEnabled()) {
			try {
				const top10Words = sortedWords.slice(0, 10).map(([word, count]) => `${word}(${count})`);
				const prompt = [
					"请生成直播总结",
					`弹幕发言人数：${senderCount}`,
					`粉丝牌名：${master?.medalName ?? ""}`,
					`弹幕总数：${danmakuCount}`,
					`热词TOP10：${top10Words.join("、")}`,
					`弹幕排行TOP5：${top5Senders.map(([u, c]) => `${u}(${c}条)`).join("、")}`,
				].join("，");
				const aiResult = await this.commentary.comment(
					prompt,
					"liveSummary",
					undefined,
					aiOverride,
				);
				this.logger.debug(`[summary] AI 直播总结生成完毕，长度=${aiResult.length}`);
				return aiResult;
			} catch (e) {
				this.logger.error(`[summary] AI 直播总结生成失败：${(e as Error).message}，回退到模板`);
			}
		}

		return this.templateRenderer.renderLiveSummary({
			template: customLiveSummary,
			senderCount,
			master,
			danmakuCount,
			topSenders: top5Senders,
		});
	}
}
