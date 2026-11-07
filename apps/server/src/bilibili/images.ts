import { BILIBILI_SOURCE_KEY } from "@bilibili-notify/contract";
import { t as serverText } from "./i18n.js";
/**
 * B 站集成自己把图存进图库:作品里的图、正文表情图、直播卡的封面在**出卡之前**抓进图库,交给出卡器的只带图库引用
 * (ADR-0021 决策 22)。翻译(`postFromDynamic`、`liveCardInputFromRoomInfo`)是同步的、只填 `url`,抓图是这里
 * 单独的一步;调用方在确定要出卡时才调(被过滤的、不出卡的一张都不抓)。
 *
 * 抓图走调用方给的抓图服务(`images/image-fetcher.ts`,用 B 站接口那个请求客户端建的;以后换成 `ctx.fetchImage`)。
 * 图库里存的是 B 站图床的缩放版({@link scaledImageUrl}),图床不认缩放后缀时再试一次原图;图上的 `url` 始终是原图地址。
 * 抓不到不抛:那张图保持只有 `url`,记一条 warn。
 */

import { urlWithoutQuery } from "@bilibili-notify/http";
import type { LiveCardInput } from "@bilibili-notify/image";
import {
	type FailureCode,
	type ImageRef,
	type Logger,
	type Post,
	type PostImage,
	type Result,
	type RichText,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";

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
/** 头像单独一档:卡上最大也就画几百像素,480 宽够用,存下来的体积小得多。 */
const AVATAR_MAX_WIDTH = 480;
/** 表情图单独一档:卡上表情只画十几到几十像素,128 宽已是两倍像素,够用;原图可能是体积很大的动图。 */
const EMOJI_MAX_WIDTH = 128;
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
 * `maxWidth` 不给就是作品图那一档({@link SCALED_MAX_WIDTH})。
 */
export function scaledImageUrl(url: string, maxWidth: number = SCALED_MAX_WIDTH): string {
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
	const suffix = `@${maxWidth}w_${SCALED_QUALITY}q${SCALED_FIRST_FRAME}.webp`;
	return query ? `${cleanBase}${suffix}?${query}` : `${cleanBase}${suffix}`;
}

/** 抓这些图时带的请求头:B 站图床按站内引用来取。 */
export const IMAGE_REQUEST_HEADERS = { Referer: "https://www.bilibili.com/" } as const;

/** 一次最多同时抓几张。 */
export const FETCH_CONCURRENCY = 3;

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

/** 富文本里的表情节点换成 `replace` 给的图库引用(回新数组、不改入参);别的片段原样。 */
function mapRichTextEmojis(
	richText: RichText,
	replace: (text: string, image: ImageRef | undefined) => ImageRef | undefined,
): RichText {
	return richText.map((segment) => {
		if (segment.kind !== "emoji") return segment;
		const image = replace(segment.text, segment.image);
		return image === undefined ? segment : { ...segment, image };
	});
}

/**
 * 把作品里每个表情节点的 `image` 换成 `replace` 给的(回新对象,不改入参);被转发的原作品一起走。
 * `Post` 里长 `RichText` 的格子只有 `richText`(外层与 `repost` 内层各一份);加了新格子,这里要跟着加。
 */
function mapPostEmojis(
	post: Post,
	replace: (text: string, image: ImageRef | undefined) => ImageRef | undefined,
): Post {
	const { richText, repost } = post;
	return {
		...post,
		...(richText ? { richText: mapRichTextEmojis(richText, replace) } : {}),
		...(repost ? { repost: mapPostEmojis(repost, replace) } : {}),
	};
}

/**
 * 缩放地址抓不到时,哪几种失败值得再抓一次原地址:图床不认这个缩放后缀(4xx、回来的不是图)或缩放版不存在。
 * 别的(被限流、超时、连不上、没权限、被中止)换成原地址也是同一个结果 —— 再打一次只是把请求量和等的时间翻倍,
 * 原图还更大。
 */
const SCALED_ONLY_FAILURES: ReadonlySet<FailureCode> = new Set(["invalid", "not_found"]);

/**
 * 抓一张图:先抓缩放地址;缩放地址与原地址不同、且失败是 {@link SCALED_ONLY_FAILURES} 里的那几种,再抓一次原地址。
 * 抓不到回 `undefined`、记一条 warn(地址不带 query,里头可能是凭据)。抓图服务本身抛了算这一次失败(原因不明,
 * 照旧再试原地址),不往外抛。
 */
async function fetchRef(url: string, deps: ImagesDeps): Promise<ImageRef | undefined> {
	const scaled = scaledImageUrl(url);
	const candidates = scaled === url ? [url] : [scaled, url];
	let lastMessage = "";
	for (const candidate of candidates) {
		try {
			const result = await deps.images.fetchImage(candidate, { headers: IMAGE_REQUEST_HEADERS });
			if (result.ok) return result.ref;
			lastMessage = `${result.code}: ${result.message}`;
			if (!SCALED_ONLY_FAILURES.has(result.code)) break;
		} catch (e) {
			lastMessage = (e as Error).message;
		}
	}
	deps.logger.warn(
		`[bilibili-images] 抓图失败,这张图保持只有地址 ${urlWithoutQuery(url)}: ${lastMessage}`,
	);
	return undefined;
}

/** 一批活同时最多跑 `limit` 个(默认 {@link FETCH_CONCURRENCY};每个活自己吞掉失败,不抛)。 */
export async function runLimited(
	jobs: Array<() => Promise<void>>,
	limit: number = FETCH_CONCURRENCY,
): Promise<void> {
	const queue = [...jobs];
	const worker = async (): Promise<void> => {
		for (let job = queue.shift(); job !== undefined; job = queue.shift()) await job();
	};
	await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/**
 * 把一条作品里所有只有地址没有引用的图抓进图库,回新对象(不改入参;已有引用的图不动,转发的内层作品也走)。
 * 抓到的图加 `ref`、保留原来的 `url`;抓不到的保持只有 `url`,别的图照抓。
 *
 * 头像一并处理(第三参):外层作者的引用直接填进去;转发的原作者头像地址和配图同一步、同一个并发上限
 * 现抓(头像那一档,见 {@link fetchAvatar}),抓不到就不画。作品不是转发就没有地方放,不抓。
 *
 * @param options.avatar 外层作者的头像(图库引用,通常取自订阅资料);填进 `creator.avatar`,不碰网络。
 * @param options.repostAvatarUrl 被转发的原作者的头像地址(他通常不是订阅的人,资料里没有);
 *   现抓,抓到的填进 `repost.creator.avatar`。
 * @param options.emojiUrls 正文表情的「表情文字 → 图片地址」(`emojiUrlsOf` 从原始动态读出):作品里(外层与
 *   转发内层)每个还没有 `image` 的表情节点按 `text` 查,同一个地址只抓一次(表情那一档,见 {@link fetchEmoji}),
 *   抓到的填进 `image`,抓不到的保持文字。和配图、头像同一步、同一个并发上限。
 */
export async function fetchPostImages(
	post: Post,
	deps: ImagesDeps,
	options: {
		avatar?: ImageRef;
		repostAvatarUrl?: string;
		emojiUrls?: ReadonlyMap<string, string>;
	} = {},
): Promise<Post> {
	const urls = new Set<string>();
	mapPostImages(post, (image) => {
		if (needsFetch(image)) urls.add(image.url);
		return image;
	});
	const refs = new Map<string, ImageRef>();
	const jobs = [...urls].map((url) => async () => {
		const ref = await fetchRef(url, deps);
		if (ref !== undefined) refs.set(url, ref);
	});
	let repostAvatar: ImageRef | undefined;
	const { repostAvatarUrl } = options;
	if (post.repost !== undefined && repostAvatarUrl) {
		jobs.push(async () => {
			repostAvatar = await fetchAvatar(repostAvatarUrl, deps);
		});
	}
	const emojiRefs = new Map<string, ImageRef>();
	const { emojiUrls } = options;
	if (emojiUrls !== undefined) {
		const emojiTexts = new Set<string>();
		mapPostEmojis(post, (text, image) => {
			if (image === undefined && emojiUrls.has(text)) emojiTexts.add(text);
			return image;
		});
		for (const text of emojiTexts) {
			const url = emojiUrls.get(text);
			if (url === undefined) continue;
			jobs.push(async () => {
				const ref = await fetchEmoji(url, deps);
				if (ref !== undefined) emojiRefs.set(text, ref);
			});
		}
	}
	await runLimited(jobs);
	const filled = mapPostImages(post, (image) => {
		const ref = needsFetch(image) ? refs.get(image.url) : undefined;
		return ref === undefined ? image : { ...image, ref };
	});
	const emojiFilled = mapPostEmojis(filled, (text, image) => image ?? emojiRefs.get(text));
	return withAvatars(emojiFilled, options.avatar, repostAvatar);
}

/** 把头像引用填进作品(外层作者、转发的原作者),回新对象;没有引用的那一处原样。 */
function withAvatars(
	post: Post,
	avatar: ImageRef | undefined,
	repostAvatar: ImageRef | undefined,
): Post {
	const repost = post.repost;
	return {
		...post,
		...(avatar === undefined ? {} : { creator: { ...post.creator, avatar } }),
		...(repost === undefined || repostAvatar === undefined
			? {}
			: { repost: { ...repost, creator: { ...repost.creator, avatar: repostAvatar } } }),
	};
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

/**
 * 抓某一档缩放版进图库,回图库引用;**缩放版抓不到不回退原图**,回 `undefined`、记一条 warn(地址不带 query),不抛。
 * 抓图服务本身抛了同样回 `undefined`。非 B 站图床的地址(缩放不动它)只抓一次原地址。`what` 是 warn 里的叫法。
 */
async function fetchScaledOnly(
	url: string,
	maxWidth: number,
	what: string,
	deps: ImagesDeps,
): Promise<ImageRef | undefined> {
	try {
		const result = await deps.images.fetchImage(scaledImageUrl(url, maxWidth), {
			headers: IMAGE_REQUEST_HEADERS,
		});
		if (result.ok) return result.ref;
		deps.logger.warn(
			`[bilibili-images] ${what}抓取失败,这一轮没有${what} ${urlWithoutQuery(url)}: ${result.code}: ${result.message}`,
		);
	} catch (e) {
		// 抓图服务本身抛了也是「这一轮没有」:约定是不抛,调用方不必再包一层。
		deps.logger.warn(
			`[bilibili-images] ${what}抓取出错,这一轮没有${what} ${urlWithoutQuery(url)}: ${(e as Error).message}`,
		);
	}
	return undefined;
}

/**
 * 把一张头像抓进图库,回图库引用;抓不到回 `undefined`、记一条 warn(地址不带 query),不抛。
 * 头像单独一档缩放({@link AVATAR_MAX_WIDTH} 宽),**缩放版抓不到不回退原图**(和作品图不同):这一轮就没头像,
 * 下一轮由调用方再试。
 */
export function fetchAvatar(url: string, deps: ImagesDeps): Promise<ImageRef | undefined> {
	return fetchScaledOnly(url, AVATAR_MAX_WIDTH, serverText("bilibili.images.text.1"), deps);
}

/**
 * 把一个表情图抓进图库,回图库引用;抓不到回 `undefined`、记 warn,不抛。表情单独一档缩放
 * ({@link EMOJI_MAX_WIDTH} 宽),**缩放版抓不到不回退原图**(表情原图可能是很大的动图):那个表情这一轮卡上画文字。
 */
function fetchEmoji(url: string, deps: ImagesDeps): Promise<ImageRef | undefined> {
	return fetchScaledOnly(url, EMOJI_MAX_WIDTH, serverText("bilibili.images.text.2"), deps);
}

/** B 站自己资料状态里头像的两格:`avatar` 是图库引用,`avatarUrl` 是那张图的来源地址。 */
export type ProfileAvatarFields = {
	avatar?: ImageRef;
	avatarUrl?: string;
};

/**
 * 按 B 站这次给的头像地址 `avatarUrl`,算资料里头像两格该是什么(调用方把结果并进 `cachedProfile`)。
 *
 * 规矩:**只要有 `avatar`,`avatarUrl` 就是那张图的来源地址**。
 * - 地址没变且已有 `avatar`:不抓(零网络),原样返回;
 * - 地址变了、或有地址却没有 `avatar`:抓。抓到两格一起换成新的;
 * - 抓不到、原本有 `avatar`:两格都保持原样(下一轮地址仍不同,会再试);
 * - 抓不到、原本没有 `avatar`:`avatarUrl` 记新地址、`avatar` 缺键(下一轮「有地址却没有 avatar」会再试)。
 * B 站没给地址(空)就什么都不动。
 */
export async function syncProfileAvatar(
	current: ProfileAvatarFields | undefined,
	avatarUrl: string | undefined,
	deps: ImagesDeps,
): Promise<ProfileAvatarFields> {
	const kept: ProfileAvatarFields = {
		...(current?.avatar === undefined ? {} : { avatar: current.avatar }),
		...(current?.avatarUrl === undefined ? {} : { avatarUrl: current.avatarUrl }),
	};
	if (!avatarUrl) return kept;
	if (current?.avatar !== undefined && current.avatarUrl === avatarUrl) return kept;
	const avatar = await fetchAvatar(avatarUrl, deps);
	if (avatar !== undefined) return { avatar, avatarUrl };
	return current?.avatar === undefined ? { avatarUrl } : kept;
}

/**
 * uid 对应的**已订阅**的 B 站 UP 在订阅资料里的头像引用;没订阅、资料里还没有头像都回 `undefined`(卡上不画)。
 * 面板预览的真实拉取用它:预览里那位 UP 不一定订阅了,订阅了就和真推送一样读资料、零网络。
 */
export function subscribedAvatar(
	subscriptions: readonly Subscription[],
	profileOf: (subscriptionId: string) => { avatar?: ImageRef } | undefined,
	uid: string,
): ImageRef | undefined {
	const subscription = subscriptions.find((sub) => {
		const identity = subscriptionIdentityOf(sub);
		return identity.sourceKey === BILIBILI_SOURCE_KEY && identity.externalId === uid;
	});
	return subscription ? profileOf(subscription.id)?.avatar : undefined;
}
