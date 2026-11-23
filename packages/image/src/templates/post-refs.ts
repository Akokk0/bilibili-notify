/**
 * 一份作品里用到的全部图库引用(㉑d):出图器事先把它们都解析成可画的地址,`nodeFromPost` 再同步去查。
 *
 * 引用只会出现在这几处 —— `PostImage.ref`(配图 / 专栏配图 / 视频封面 / 充电专属的徽标 / 附加块的封面与商品图)、
 * `Creator.avatar`、`RichText` 的 `link.icon` · `emoji.image`、附加块 `lines[].icon`;被转发的原作品里同样有,一并找。
 * 形状新增了装引用的格,这里就得跟上(`post-refs.test.ts` 逐处钉着,漏一处那一处的图永远画占位)。
 */

import type { ImageRef, Post, PostImage } from "@bilibili-notify/internal";

export function collectImageRefs(post: Post): Set<ImageRef> {
	const refs = new Set<ImageRef>();
	const add = (ref: ImageRef | undefined): void => {
		if (ref !== undefined) refs.add(ref);
	};
	const addImage = (image: PostImage | undefined): void => add(image?.ref);
	const walk = (one: Post): void => {
		add(one.creator.avatar);
		for (const segment of one.richText ?? []) {
			if (segment.kind === "link") add(segment.icon);
			else if (segment.kind === "emoji") add(segment.image);
		}
		for (const image of one.article?.images ?? []) addImage(image);
		addImage(one.locked?.icon);
		for (const image of one.images ?? []) addImage(image);
		addImage(one.video?.cover);
		const attachment = one.attachment;
		if (attachment?.kind === "card") {
			addImage(attachment.cover);
			for (const line of attachment.lines ?? []) add(line.icon);
		} else if (attachment?.kind === "video") {
			addImage(attachment.cover);
		} else if (attachment?.kind === "goods") {
			for (const item of attachment.items) addImage(item.cover);
		}
		if (one.repost) walk(one.repost);
	};
	walk(post);
	return refs;
}
