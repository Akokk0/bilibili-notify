import type { ImageRenderer } from "@bilibili-notify/image";
import type { Logger } from "@bilibili-notify/internal";

/**
 * Threshold for refusing to render a wordcloud — stays in sync with the
 * original `live-service` heuristic: a board-level wordcloud needs a baseline
 * vocabulary or it looks empty.
 */
export const WORDCLOUD_MIN_WORDS = 50;

/** Cap on how many top words are passed into the wordcloud renderer. */
export const WORDCLOUD_TOP_WORDS = 90;

/**
 * Wraps {@link ImageRenderer.generateWordCloudImg} with the engine's gating
 * logic (≥50 unique words required) and surfaces logger messages identical to
 * the original live-service.
 *
 * The output is a `Buffer` so the caller decides how to wrap it for the target
 * platform (e.g. via `LiveContentBuilder.image`).
 */
export class WordcloudGenerator {
	private readonly getImageRenderer: () => ImageRenderer | null;
	private readonly isImageEnabled: () => boolean;
	private readonly logger: Logger;

	constructor(opts: {
		/**
		 * 渲染器 provider —— 每次 generate() 现取最新引用,使 LiveEngine 在 image
		 * 服务上下线时通过 setImageRenderer 替换内部状态,词云生成自动同步,无需子组件
		 * 接 setter。
		 */
		getImageRenderer: () => ImageRenderer | null;
		/**
		 * 卡片渲染总开关查询。返回 false 时直接跳过 puppeteer 调用,与缺失 imageRenderer
		 * 等价。Adapter 通常用 `() => globals.defaults.cardStyle.enabled` 填充;缺省 () => true。
		 */
		isImageEnabled?: () => boolean;
		logger: Logger;
	}) {
		this.getImageRenderer = opts.getImageRenderer;
		this.isImageEnabled = opts.isImageEnabled ?? (() => true);
		this.logger = opts.logger;
	}

	/**
	 * Render a wordcloud image for `(masterName, masterAvatarUrl)`.
	 *
	 * Returns `undefined` when:
	 * - There are fewer than {@link WORDCLOUD_MIN_WORDS} unique words.
	 * - No `ImageRenderer` was injected (image-engine isn't installed).
	 * - The renderer threw; the error is logged and swallowed so the rest of
	 *   the live-end pipeline (summary + downstream push) keeps running.
	 */
	async generate(
		sortedWords: Array<[string, number]>,
		masterName: string,
		masterAvatarUrl?: string,
		/** 这张卡用哪套皮肤(ADR-0014);undefined = 内置默认。 */
		cardSkin?: string,
	): Promise<Buffer | undefined> {
		if (sortedWords.length < WORDCLOUD_MIN_WORDS) {
			this.logger.debug(`[wordcloud] 热词不足${WORDCLOUD_MIN_WORDS}个，放弃生成弹幕词云`);
			return undefined;
		}
		if (!this.isImageEnabled()) {
			this.logger.debug("[wordcloud] cardStyle.enabled=false,跳过词云图片生成");
			return undefined;
		}
		const renderer = this.getImageRenderer();
		if (!renderer?.generateWordCloudImg) return undefined;
		try {
			return await renderer.generateWordCloudImg(
				sortedWords.slice(0, WORDCLOUD_TOP_WORDS),
				masterName,
				masterAvatarUrl,
				{ cardSkin },
			);
		} catch (e) {
			this.logger.error(`[wordcloud] 生成词云失败：${(e as Error).message}`);
			return undefined;
		}
	}
}
