/** @jsxImportSource vue */

import { FRAMES } from "../blocks/frames";
import { wordCloudBodyChildren } from "../blocks/wordcloud";

export type WordCloudCardProps = {
	masterName: string;
	masterAvatarUrl?: string;
	colorStart: string;
	colorEnd: string;
};

/**
 * 正文块住在 `blocks/wordcloud.tsx`、外框住在 `blocks/frames.tsx`(皮肤路径共用的同两份);
 * 这里只剩「把正文装进外框」。
 *
 * 铺的是 `wordCloudBodyChildren` 那**三个同级孩子**而不是 `WORDCLOUD_BLOCKS.body` 的
 * Fragment:Vue SSR 给每个 Fragment 插锚点注释,多套一层就凭空多两条(见块库里的说明)。
 */
export function WordCloudCard(p: WordCloudCardProps) {
	return FRAMES.wordcloud(p, wordCloudBodyChildren(p));
}
