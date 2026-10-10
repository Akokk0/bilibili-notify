import type {
	Disposable,
	ImageRef,
	Logger,
	MessageBus,
	Post,
	PostFilterReason,
	ServiceContext,
	Subscription,
	SubscriptionReportValue,
} from "@bilibili-notify/internal";
import {
	createSerialGate,
	type SerialGate,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { ImageWriter } from "../images/image-store.js";
import { deferImageWrites } from "../images/image-writes.js";
import {
	type ExtensionSourceReader,
	extensionSubscriptionName,
	extensionSubscriptionPushable,
	imageDataUrl,
} from "../runtime/extension-push-common.js";
import {
	type DeliverPostDeps,
	type DeliverPostOptions,
	deliverPost,
	type NeutralWork,
	POST_COMMENT_IMAGES_MAX,
	type WorkDeliveryConfig,
	type WorkSubscriptionSettings,
} from "./deliver-post.js";
import { filterPost, type PostFilterRules } from "./post-filter.js";
import { postFromReport } from "./post-from-report.js";
import { postText } from "./post-text.js";

/**
 * **拓展报的作品接进推送链**(ADR-0019 决策 53 / 62 / 66 / 69–72 / 77):bus 上 `subscription-reported` 里
 * `kind === "post"` 的那些,逐条订阅推出去。
 *
 * 一条订阅一条作品:
 * 1. 再核一次这条订阅还该推(还在、启用着、拓展在跑)—— 停用的收下不推(决策 62);动态总开关关着的
 *    也不出卡(推送层反正会挡,白出一张卡、白调一次 AI);
 * 2. 翻成中立的 `Post`(作者名按决策 54 取好;图的写盘推迟到出卡,见 `deferImageWrites`),再过滤 —— 过滤吃 `Post`、
 *    一份实现所有来源同一个(`filterPost`,ADR-0021 决策 43):关键词 / 正则 / 白名单加四个类型开关,全局 + 按 UP
 *    覆盖照常折叠,**类型开关对拓展作品同样生效**(不再豁免)。被挡下的只在推送历史里留一行
 *    (`onPostFiltered`),不往外发任何东西;
 * 3. 同一份 `Post` 交给与 B 站同一份的装配(`deliverPost`):AI 点评的文字、出卡共用它。
 *
 * - **同一条订阅的作品按到达顺序串行**(每条订阅一道 `createSerialGate`):拓展一口气报两条时,先报的那条
 *   出卡慢也先送到;不同订阅互不排队。
 * - **不判新、不去重、不限流**(决策 53):拓展报什么就接什么。
 * - **意外抛错只记错误日志、不重试**(决策 77):拓展的事件只来一次,BN 不替它重放;发不出去的目标推送层
 *   自己接住、落历史「失败」,可以人工重推。
 * - 上报的调用不等这里(决策 62):bus 的回调同步返回,活排进闸里。
 */

type ReportedPost = SubscriptionReportValue<"post">;

/*
 * **拓展报的作品 → 平台中立的作品**(ADR-0019 决策 55 / 66 / 69 / 71 / 72 / 77):装配(`deliverPost`)
 * 只认 {@link NeutralWork} —— 下面的 `extensionPostWork` 把拓展交的上报原件与它翻好的 `Post`({@link postFromReport})
 * 包成装配要的那几格,出卡之后那一段与 B 站动态同一份。
 *
 * 翻译(`postFromReport`)由 `bindExtensionPosts` 做一次,**过滤、AI 点评的文字、出卡共用同一份 `Post`**
 * (ADR-0021 决策 43);图的写盘推迟到出卡那一刻({@link ExtensionPostWorkOptions.commitImages}),被屏蔽的 /
 * 关了出图的 / 版式藏起卡片的作品不为图写盘。AI 的文字走 `postText(post, "labeled")`(ADR-0028 决策 1,
 * 取段只此一份);AI 看的图仍取上报原件的字节(出卡用的是图库引用,点评要的是 data URL)。
 *
 * 作者名与头像引用由调用方先按决策 54 取好、翻进 `Post` 里;这里不碰订阅与资料缓存。
 */

/**
 * 交给 AI 看的图,单张多大就跳过(决策 71)。网址是服务商自己去拉,data URL 却要整张塞进请求体。
 *
 * 取 3 MiB(原始字节;编成 data URL 约 4 MiB):常见服务商对单张 base64 图的上限是 5 MB 上下
 * (Anthropic、智谱都是这个数),Gemini 内联数据整条请求 20 MB —— 四张都顶格时约 16 MiB,两头都放得下。
 * 抖音 CDN 的图多是几百 KB 的 webp,正常的作品碰不到这条线;碰到的多半是原图直出的大图,少看一张
 * 胜过整条点评被服务商 413 掉。
 */
export const POST_COMMENT_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/** 有字才算有。 */
const filled = (text: string | undefined): text is string => !!text && text.trim() !== "";

/** AI 的图(决策 71):作品图 + 视频封面,太大的跳过、让后面的顶上,前 4 张转成 data URL。 */
function commentImagesOf(post: ReportedPost): string[] {
	return [...(post.images ?? []), ...(post.video?.cover ? [post.video.cover] : [])]
		.filter((bytes) => bytes.byteLength <= POST_COMMENT_IMAGE_MAX_BYTES)
		.slice(0, POST_COMMENT_IMAGES_MAX)
		.map(imageDataUrl)
		.filter((url): url is string => url !== undefined);
}

export interface ExtensionPostWorkOptions {
	/** 平台对作品的叫法(清单 `display.postNoun`);不给就叫「动态」(决策 5)。 */
	postNoun?: string;
	/** 把翻译时推迟的图真正写进图库(`deferImageWrites` 的 `commit`);出卡前调,多次调只写一次。 */
	commitImages(): Promise<void>;
}

/**
 * 一条作品 → 装配吃的中立作品。
 *
 * - 卡:`renderCard` 被调到才先 `commitImages()` 把图写进图库、再把翻好的那份 `Post` 交给 `generatePostCard`
 *   (抛错 = 这一次出图失败,装配降级成纯文字);
 * - 链接部件是事件的 `url`(决策 77);
 * - 不附图集(决策 72:图集载荷只带网址,拓展交的是字节);
 * - AI 的文字是 `postText(post, "labeled")`;AI 的图同理,点评真要看时才编(`commentImages` 是个只算一次的 getter)。
 */
export function extensionPostWork(
	report: ReportedPost,
	post: Post,
	opts: ExtensionPostWorkOptions,
): NeutralWork {
	let commentImages: string[] | undefined;
	return {
		renderCard: async (image, colorOptions) => {
			await opts.commitImages();
			return image.generatePostCard(post, colorOptions);
		},
		link: report.url,
		name: post.creator.name,
		isVideo: post.video !== undefined,
		commentText: postText(post, "labeled"),
		get commentImages() {
			commentImages ??= commentImagesOf(report);
			return commentImages;
		},
		postNoun: filled(opts.postNoun) ? opts.postNoun : "动态",
		gallery: [],
	};
}

/** 一条拓展订阅折好的作品设置:装配那几格 + 过滤(已折好全局)+ 动态总开关。 */
export interface ExtensionPostSettings extends WorkSubscriptionSettings {
	/** 这条订阅生效的过滤(折好的 `ContentFilters`:per-UP 覆盖 ?? 全局)。 */
	filter: PostFilterRules;
	/** 作品总开关(全局 + per-UP 折好的 `features.post`)。 */
	post: boolean;
}

export interface BindExtensionPostsOptions {
	bus: MessageBus;
	logger: Logger;
	/** 此刻的这条订阅(现取)。 */
	subscription(id: string): Subscription | undefined;
	/** 订阅资料里的名字(资料缓存,现取)。 */
	profileName(id: string): string | undefined;
	/** 这条订阅折好的作品设置(现折,与 B 站那头同一份,见 `dynamicWorkSettings`)。 */
	settings(sub: Subscription): ExtensionPostSettings;
	/** 拓展在不在跑、平台对作品的叫法、清单里声明的事件(头像不在这里:作品卡用图库引用,见 `avatarRef`)。 */
	sources: Pick<ExtensionSourceReader, "running" | "postNoun" | "events">;
	/** 订阅资料里存进图库的头像引用(资料缓存的 `cachedProfile.avatar`,现取);事件没带头像时卡上用它。 */
	avatarRef(subscriptionId: string): ImageRef | undefined;
	/** 往图库存作品图的口(`AppRuntime.postImages`;作品是在途数据,图靠宽限期活到卡片画完)。 */
	postImages: Pick<ImageWriter, "put">;
	/**
	 * 一条作品被过滤挡下了 —— 在推送历史里留一行(只留痕,不是推送;与 B 站动态引擎的 `onPostFiltered`
	 * 接的是同一个写历史的函数)。`text` 是整条文字(`postText` 的 plain 拼法,没截过),`url` 是上报里的作品地址。
	 * 同步调、不等它;抛错只记日志。
	 */
	onPostFiltered(filtered: {
		subscriptionId: string;
		filteredBy: PostFilterReason;
		text: string;
		url: string;
	}): void;
	/** 绑到这条订阅上的作品推送口(`boundPostPush(push, id)`),交给 `deliverPost`。 */
	pushFor(subscriptionId: string): DeliverPostOptions["push"];
	/** 装配的全局那几样 —— 与 B 站动态同一份(`dynamicConfig()`),现取。 */
	deliveryConfig(): WorkDeliveryConfig;
	/** 装配用到的服务:渲染器与 AI 会被热换,现取;出图失败的计数两条路同一份。 */
	deliveryDeps(): DeliverPostDeps;
	/**
	 * 每条作品的出卡与推送是发出去不等的后台活:登记进 `track`,关停等它推完 —— 推送落历史的那一笔
	 * 得赶在各写道关门之前交进去。
	 */
	serviceCtx: Pick<ServiceContext, "track">;
}

export function bindExtensionPosts(opts: BindExtensionPostsOptions): Disposable {
	const log = opts.logger;
	/** 每条订阅一道闸。订阅删了就扔掉(还排着的照跑完,跑到时发现订阅不在了就不推)。 */
	const gates = new Map<string, SerialGate>();
	let disposed = false;

	const gateOf = (id: string): SerialGate => {
		let gate = gates.get(id);
		if (!gate) {
			gate = createSerialGate();
			gates.set(id, gate);
		}
		return gate;
	};

	/** 这条订阅现在还该推吗。关机之后一律不推。 */
	const pushable = (id: string): Subscription | undefined => {
		if (disposed) return undefined;
		const sub = opts.subscription(id);
		return extensionSubscriptionPushable(sub, opts.sources.running) ? sub : undefined;
	};

	async function deliverOne(id: string, report: ReportedPost): Promise<void> {
		const sub = pushable(id);
		if (!sub) {
			log.debug(`[ext-post] 订阅 ${id} 已停用 / 已删 / 它的拓展没在跑,作品 ${report.id} 不推`);
			return;
		}
		const settings = opts.settings(sub);
		if (!settings.post) {
			log.debug(`[ext-post] 订阅 ${id} 的动态推送关着,作品 ${report.id} 不推`);
			return;
		}
		const postNoun = opts.sources.postNoun(subscriptionIdentityOf(sub).sourceKey);
		const push = opts.pushFor(id);

		// 翻成中立的 `Post`(过滤、AI 点评、出卡共用这一份)。名字按决策 54 取好;图只算引用、
		// 写盘推迟到出卡 —— 被屏蔽的、不出卡的作品不往图库写。
		const authorName = extensionSubscriptionName(sub, {
			eventName: report.author?.name,
			profileName: opts.profileName(id),
		});
		const images = deferImageWrites(opts.postImages);
		const post = await postFromReport(report, {
			authorName,
			profileAvatar: opts.avatarRef(id),
			images: images.sink,
		});

		const filtered = filterPost(post, settings.filter, log);
		if (filtered.blocked && filtered.reason) {
			log.debug(`[ext-post] 订阅 ${id} 的作品 ${report.id} 被过滤,原因:${filtered.reason}`);
			// 留痕(推送历史里的一行)。只交文字与地址 —— 图还没写进图库、卡也不出,也不往外发任何东西。best-effort。
			try {
				opts.onPostFiltered({
					subscriptionId: id,
					filteredBy: filtered.reason,
					text: postText(post, "plain"),
					url: report.url,
				});
			} catch (e) {
				log.warn(`[ext-post] 被过滤的作品留痕失败(忽略): ${(e as Error).message}`);
			}
			return;
		}

		const outcome = await deliverPost({
			work: extensionPostWork(report, post, { postNoun, commitImages: images.commit }),
			settings,
			push,
			// 出卡、点评几个 await 之后再核一次:期间停用了订阅 / 停了拓展 / 删了它,就不发。
			stillSubscribed: () => pushable(id) !== undefined,
			config: opts.deliveryConfig(),
			deps: opts.deliveryDeps(),
			logLabel: `sub=${id}`,
		});
		if (outcome === "unsubscribed") {
			log.debug(`[ext-post] 订阅 ${id} 在出卡途中停用 / 删掉了,作品 ${report.id} 没发`);
		}
	}

	const watches: Disposable[] = [
		opts.bus.on("subscription-reported", (delivery) => {
			if (delivery.report.kind !== "post") return;
			const post = delivery.report.value;
			for (const id of delivery.subscriptionIds) {
				opts.serviceCtx.track(
					gateOf(id)
						.run(() => deliverOne(id, post))
						.catch((err) => {
							log.error(
								`[ext-post] 订阅 ${id} 的作品 ${post.id} 推送途中出错(不重试): ${err instanceof Error ? err.message : String(err)}`,
							);
						}),
				);
			}
		}),
		opts.bus.on("subscription-changed", ({ ops }) => {
			for (const op of ops) if (op.kind === "remove") gates.delete(op.sub.id);
		}),
	];

	return {
		dispose() {
			disposed = true;
			for (const watch of watches) watch.dispose();
			gates.clear();
		},
	};
}
