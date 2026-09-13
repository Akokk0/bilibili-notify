/** @jsxImportSource vue */

import { wordCloudBodyChildren } from "../blocks/wordcloud";

export type WordCloudCardProps = {
	masterName: string;
	masterAvatarUrl?: string;
	colorStart: string;
	colorEnd: string;
};

/** 正文块住在 `blocks/wordcloud.tsx`(皮肤按块装配的同一份);这里只剩外框。 */
export function WordCloudCard(p: WordCloudCardProps) {
	return (
		<div
			class="h-auto p-[15px]"
			style={{ background: `linear-gradient(to right bottom, ${p.colorStart}, ${p.colorEnd})` }}
		>
			<div
				class="overflow-hidden rounded-[12px]"
				style="background: rgba(255,255,255,0.82); backdrop-filter: blur(10px); box-shadow: 0 4px 16px rgba(0,0,0,0.12);"
			>
				{wordCloudBodyChildren(p)}
			</div>
		</div>
	);
}
