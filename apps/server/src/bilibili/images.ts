/**
 * B 站集成自己把图存进图库:作品里的图、直播卡的封面在**出卡之前**抓进图库,交给出卡器的只带图库引用
 * (ADR-0021 决策 22)。翻译(`postFromDynamic`、`liveCardInputFromRoomInfo`)是同步的、只填 `url`,抓图是这里
 * 单独的一步;调用方在确定要出卡时才调(被过滤的、不出卡的一张都不抓)。
 *
 * 抓图走调用方给的抓图服务(`images/image-fetcher.ts`,用 B 站接口那个请求客户端建的;以后换成 `ctx.fetchImage`)。
 * 图库里存的是 B 站图床的缩放版({@link scaledImageUrl}),抓不到再试一次原图;图上的 `url` 始终是原图地址。
 * 抓不到不抛:那张图保持只有 `url`,记一条 warn。
 */

import { urlWithoutQuery } from "@bilibili-notify/http";
import type { LiveCardInput } from "@bilibili-notify/image";
import type { ImageRef, Logger, Post, PostImage, Result } from "@bilibili-notify/internal";

export interface ImagesDeps {
	images: {
		fetchImage(
			url: string,
			opts?: { headers?: Record<string, string> },
		): Promise<Result<{ ref: ImageRef }>>;
	};
	logger: Logger;
}

/**
 * B 站图片处理服务的缩放目标宽 / 质量(webp)。动态原图常达十几 MB,超图库 8MB 的上限就存不进去。
 * 给 i*.hdslb.com 的 /bfs/ 资源加 `@<w>w_<q>q_1s.webp` 后缀,让 CDN 直接返回缩放压缩版,
 * 既不触发上限,存下来的体积也小一个数量级。
 */
const SCALED_MAX_WIDTH = 1280;
const SCALED_QUALITY = 80;
/**
 * 「只要第一帧」。**没有它 GIF 会被转成动画 webp** —— 实测一张 6.7MB 的 GIF:
 * 带 `_1s` 是 37KB / 0.17s 的静态图,不带是 2.33MB / 6.9s、含 74 个动画帧块。
 * 出图走截图,动画本来就只截得到一帧,那点体积和秒数纯属白烧,还正好撞上抓取超时。
 *
 * 对静图无副作用(实测两张 face 图带不带 `_1s` 返回字节分毫不差),所以不按源
 * 格式分流,一律带上 —— 少一条「靠扩展名猜是不是动图」的分支,也就少一处会错。
 */
const SCALED_FIRST_FRAME = "_1s";

/**
 * 对 B 站图片处理服务器(i0/i1/i2…​.hdslb.com 的 /bfs/ 资源)的地址追加缩放 + webp 转码后缀;
 * 已有 `@…` 处理后缀会被替换。其它 host / 非 /bfs/ 路径原样返回(静态 s1 资源、第三方域不处理)。query 保留。
 */
export function scaledImageUrl(url: string): string {
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		return url;
	}
	if (!/^i\d+\.hdslb\.com$/.test(host)) return url;
	if (!url.includes("/bfs/")) return url;
	const [beforeQuery, query] = url.split("?", 2);
	// B 站图地址无 userinfo,`@` 只可能是已有的处理后缀 → 截到它之前。
	const cleanBase = (beforeQuery ?? url).split("@")[0];
	const suffix = `@${SCALED_MAX_WIDTH}w_${SCALED_QUALITY}q${SCALED_FIRST_FRAME}.webp`;
	return query ? `${cleanBase}${suffix}?${query}` : `${cleanBase}${suffix}`;
}

/** 抓这些图时带的请求头:B 站图床按站内引用来取。 */
export const IMAGE_REQUEST_HEADERS = { Referer: "https://www.bilibili.com/" } as const;

/** 一次最多同时抓几张(与出图器今天的预取并发一致)。 */
const FETCH_CONCURRENCY = 3;

/** 还没存进图库的图:有地址、没有引用。 */
const needsFetch = (image: PostImage | undefined): image is PostImage & { url: string } =>
	image !== undefined && image.ref === undefined && !!image.url;

/** 附加块里的图(卡片封面、视频封面、商品图)。 */
function mapAttachmentImages(
	attachment: NonNullable<Post["attachment"]>,
	replace: (image: PostImage) => PostImage,
): NonNullable<Post["attachment"]> {
	switch (attachment.kind) {
		case "card":
			return attachment.cover ? { ...attachment, cover: replace(attachment.cover) } : attachment;
		case "video":
			return { ...attachment, cover: replace(attachment.cover) };
		case "goods":
			return {
				...attachment,
				items: attachment.items.map((item) => ({ ...item, cover: replace(item.cover) })),
			};
	}
}

/**
 * 把作品里每一格 `PostImage` 换成 `replace` 给的图,回新对象(不改入参);被转发的原作品一起走。
 * `Post` 里长 `PostImage` 的格子只有这几处(其余都是只收图库引用的 `ImageRef`);加了新格子,这里要跟着加。
 */
function mapPostImages(post: Post, replace: (image: PostImage) => PostImage): Post {
	const { article, locked, images, video, attachment, repost } = post;
	return {
		...post,
		...(article?.images ? { article: { ...article, images: article.images.map(replace) } } : {}),
		...(locked?.icon ? { locked: { ...locked, icon: replace(locked.icon) } } : {}),
		...(images ? { images: images.map(replace) } : {}),
		...(video ? { video: { ...video, cover: replace(video.cover) } } : {}),
		...(attachment ? { attachment: mapAttachmentImages(attachment, replace) } : {}),
		...(repost ? { repost: mapPostImages(repost, replace) } : {}),
	};
}

/**
 * 抓一张图:先抓缩放地址,失败且缩放地址与原地址不同再抓一次原地址。两次都失败回 `undefined`、记一条
 * warn(地址不带 query,里头可能是凭据)。
 */
async function fetchRef(url: string, deps: ImagesDeps): Promise<ImageRef | undefined> {
	const scaled = scaledImageUrl(url);
	const candidates = scaled === url ? [url] : [scaled, url];
	let lastMessage = "";
	for (const candidate of candidates) {
		const result = await deps.images.fetchImage(candidate, { headers: IMAGE_REQUEST_HEADERS });
		if (result.ok) return result.ref;
		lastMessage = `${result.code}: ${result.message}`;
	}
	deps.logger.warn(
		`[bilibili-images] 抓图失败,这张图保持只有地址 ${urlWithoutQuery(url)}: ${lastMessage}`,
	);
	return undefined;
}

/** 一批地址(去重)抓进图库,同时最多 {@link FETCH_CONCURRENCY} 张;回「地址 → 引用」(抓不到的不在表里)。 */
async function fetchRefs(urls: Iterable<string>, deps: ImagesDeps): Promise<Map<string, ImageRef>> {
	const queue = [...new Set(urls)];
	const refs = new Map<string, ImageRef>();
	const worker = async (): Promise<void> => {
		for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
			const ref = await fetchRef(url, deps);
			if (ref !== undefined) refs.set(url, ref);
		}
	};
	await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker));
	return refs;
}

/**
 * 把一条作品里所有只有地址没有引用的图抓进图库,回新对象(不改入参;已有引用的图不动,转发的内层作品也走)。
 * 抓到的图加 `ref`、保留原来的 `url`;抓不到的保持只有 `url`,别的图照抓。
 */
export async function fetchPostImages(post: Post, deps: ImagesDeps): Promise<Post> {
	const urls: string[] = [];
	mapPostImages(post, (image) => {
		if (needsFetch(image)) urls.push(image.url);
		return image;
	});
	const refs = await fetchRefs(urls, deps);
	return mapPostImages(post, (image) => {
		const ref = needsFetch(image) ? refs.get(image.url) : undefined;
		return ref === undefined ? image : { ...image, ref };
	});
}

/**
 * 把直播卡输入的封面抓进图库,回新对象(不改入参)。封面没有、或已有引用就原样;抓不到保持只有 `url`。
 */
export async function fetchLiveCover(
	input: LiveCardInput,
	deps: ImagesDeps,
): Promise<LiveCardInput> {
	const { cover } = input;
	if (!needsFetch(cover)) return { ...input };
	const ref = await fetchRef(cover.url, deps);
	return ref === undefined ? { ...input } : { ...input, cover: { ...cover, ref } };
}
