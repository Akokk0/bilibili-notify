/** @jsxImportSource vue */

/**
 * 弹幕词云卡的块库 —— 整张正文一个 `body` 块。
 *
 * `body` 是从 `templates/wordcloud-card.tsx` **原样搬**进来的玻璃层整段正文(头部 +
 * 分隔线 + 画布),class、inline style、文案一个字都没动;外框仍留在模板里。这张卡在
 * `CARD_SKIN_BUILTIN_BLOCKS` 里整张就是一个内置块,所以没有原子块可抠。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.wordcloud`,一个不多一个不少
 * (`__tests__/card-blocks.test.ts` 对表钉着)。
 */

import { Fragment, h, type VNode } from "vue";
import type { WordCloudCardProps } from "../templates/wordcloud-card";
import type { BlockRenderer } from "./types";

/**
 * 正文的三个同级子节点。模板直接铺这一串而不是铺 `body` 的 Fragment:Vue SSR 给每个
 * Fragment 插锚点注释(`<!--[-->`),多套一层就凭空多两条注释 —— 那既是白白的字节,
 * 也会被 UnoCSS 的 extractor 当成「任意值方括号」吞掉紧随其后的类名(见 `render.ts`)。
 */
export function wordCloudBodyChildren(p: WordCloudCardProps): VNode[] {
	return [
		/* ── 头部：头像 + 标题 ── */
		<div class="flex items-center gap-[10px] px-[16px] pt-[14px] pb-[10px]">
			{p.masterAvatarUrl && (
				<img
					class="w-[44px] h-[44px] rounded-full object-cover shrink-0"
					src={p.masterAvatarUrl}
					alt="头像"
				/>
			)}
			<div class="flex flex-col gap-[2px] min-w-0">
				<span class="text-[16px] font-bold leading-none" style="color: #18191C;">
					{p.masterName}
				</span>
				<span class="text-[12px]" style="color: #999;">
					本场直播弹幕词云
				</span>
			</div>
		</div>,

		/* ── 分隔线 ── */
		<div style="height: 1px; background: rgba(0,0,0,0.06); margin: 0 16px;" />,

		/* ── 词云画布 ── */
		<div class="px-[16px] pt-[12px] pb-[14px]">
			<canvas id="wordCloudCanvas" style="width: 100%; height: 400px; display: block;" />
		</div>,
	];
}

/** wordcloud 卡的块表(整张正文一个块)。 */
export const WORDCLOUD_BLOCKS: Record<string, BlockRenderer<WordCloudCardProps>> = {
	body: (p) => h(Fragment, null, wordCloudBodyChildren(p)),
};
