/**
 * 测试夹具:把作品里**只有地址**的图换成图库引用,并给一个把引用认回原地址的解析口。
 *
 * 出图只认图库引用(只有 `url` 的图画占位),而很多夹具照 B 站翻译那一步的产物写、图只带 `url` —— 真出卡时
 * 中间还有一步「抓进图库、挂上 `ref`」(`apps/server/src/bilibili/images.ts`),本包够不着它。这里顶替那一步:
 * 每个不同的地址配一个合成引用,解析口把它认回**原来那个字符串**,所以画进 HTML 的字节与图上直接写地址时一样
 * (基准快照靠这个保持不变)。已有 `ref` 的图、没有地址的图原样不动。
 */

import type { ImageRef, Post, PostImage } from "@bilibili-notify/internal";

export interface ImageRefTable {
	/** 引用 → 原来的地址;不认识的引用回 `undefined`。 */
	readonly imageUrl: (ref: ImageRef) => string | undefined;
	/** 地址 → 它的合成引用(同一个地址永远是同一个引用)。 */
	readonly refOf: (url: string) => ImageRef;
}

/** 一张「合成图库」。合成引用形状合规(64 位十六进制 + 扩展名),按登记的先后编号。 */
export function createImageRefTable(): ImageRefTable {
	const refs = new Map<string, ImageRef>();
	const urls = new Map<ImageRef, string>();
	return {
		imageUrl: (ref) => urls.get(ref),
		refOf(url) {
			const known = refs.get(url);
			if (known !== undefined) return known;
			const ref: ImageRef = `${(refs.size + 1).toString(16).padStart(64, "0")}.png`;
			refs.set(url, ref);
			urls.set(ref, url);
			return ref;
		},
	};
}

/**
 * 作品里每一格只有地址的 `PostImage` 换成带合成引用的,回新对象(不改入参);被转发的原作品一起走。
 * `Post` 里长 `PostImage` 的格子与 `apps/server/src/bilibili/images.ts` 的 `mapPostImages` 是同一份名单。
 */
export function withImageRefs(post: Post, table: ImageRefTable = createImageRefTable()): Post {
	const stored = (image: PostImage): PostImage =>
		image.ref === undefined && image.url ? { ...image, ref: table.refOf(image.url) } : image;
	const { article, locked, images, video, attachment, repost } = post;
	return {
		...post,
		...(article?.images ? { article: { ...article, images: article.images.map(stored) } } : {}),
		...(locked?.icon ? { locked: { ...locked, icon: stored(locked.icon) } } : {}),
		...(images ? { images: images.map(stored) } : {}),
		...(video ? { video: { ...video, cover: stored(video.cover) } } : {}),
		...(attachment ? { attachment: withAttachmentRefs(attachment, stored) } : {}),
		...(repost ? { repost: withImageRefs(repost, table) } : {}),
	};
}

function withAttachmentRefs(
	attachment: NonNullable<Post["attachment"]>,
	stored: (image: PostImage) => PostImage,
): NonNullable<Post["attachment"]> {
	switch (attachment.kind) {
		case "card":
			return attachment.cover ? { ...attachment, cover: stored(attachment.cover) } : attachment;
		case "video":
			return { ...attachment, cover: stored(attachment.cover) };
		case "goods":
			return {
				...attachment,
				items: attachment.items.map((item) => ({ ...item, cover: stored(item.cover) })),
			};
	}
}
