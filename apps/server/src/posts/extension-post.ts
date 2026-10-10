/**
 * **拓展报的作品交给核心入口**(ADR-0019 决策 53 / 62 / 69–72 / 77):bus 上 `subscription-reported` 里
 * `kind === "post"` 的那些,逐条订阅翻成中立的 {@link PostEvent} 交给 `PostQueue`。
 *
 * 这里只负责**生产**,过滤、出卡、AI 点评、推送、图集、留痕、「订阅还该不该推」的回问都是核心入口与装配的事
 * (`post-queue.ts`、`deliver-post.ts`),B 站动态与拓展共用。一条订阅一份信封:
 *
 * 1. 查订阅(没有就跳过);
 * 2. 翻成中立的 `Post`(作者名按决策 54 取好;**图在交出之前就写进图库**,信封里只有图库引用 —— 被过滤的、
 *    关了出图的作品也写,代价主人知情,见 ADR-0028 / 3a-27 决策 3);
 * 3. 交入口。
 *
 * - **同一个绑定的上报按到达顺序一条条翻**(绑定自己一道串行闸):翻译要写图库、是异步的,不排队的话同一条订阅先后
 *   两条上报入队的次序会乱,而入口那一头的串行闸只保证入队之后的次序;
 * - **不判新、不去重、不限流**(决策 53):拓展报什么就接什么;
 * - **意外抛错只记错误日志、不重试**(决策 77):拓展的事件只来一次,BN 不替它重放;
 * - 上报的调用不等这里(决策 62):bus 的回调同步返回,活排进闸里,登记进 `track`(关停等它翻完交完)。
 */

import type {
	Disposable,
	Logger,
	MessageBus,
	PostEvent,
	ServiceContext,
	Subscription,
	SubscriptionReportValue,
} from "@bilibili-notify/internal";
import { createSerialGate, fail, subscriptionIdentityOf } from "@bilibili-notify/internal";
import type { ImageWriter } from "../images/image-store.js";
import { extensionSubscriptionName } from "../runtime/extension-push-common.js";
import { errorMessageOf } from "../util/error-message.js";
import { postFromReport } from "./post-from-report.js";

type ReportedPost = SubscriptionReportValue<"post">;

export interface BindExtensionPostsOptions {
	bus: Pick<MessageBus, "on">;
	logger: Logger;
	/**
	 * 每条订阅的翻译与交入口是发出去不等的后台活:登记进 `track`,关停等它做完 —— 写图库的那一笔得赶在
	 * 各写道关门之前交进去。
	 */
	serviceCtx: Pick<ServiceContext, "track">;
	/** 此刻的这条订阅(现取)。 */
	subscription(id: string): Subscription | undefined;
	/** 订阅资料里的名字(资料缓存,现取)。 */
	profileName(id: string): string | undefined;
	/** 平台对作品的叫法(清单 `display.postNoun`,按拓展 id 现取);没写就是 `undefined`,核心叫「动态」。 */
	postNoun(extensionId: string): string | undefined;
	/** 往图库存作品图的口(`AppRuntime.postImages`;作品是在途数据,图靠宽限期活到卡片画完)。 */
	postImages: Pick<ImageWriter, "put">;
	/** 核心入口(`PostQueue.enqueue`):同步、没有返回值、不抛。 */
	enqueue(event: PostEvent): void;
}

export function bindExtensionPosts(opts: BindExtensionPostsOptions): Disposable {
	const log = opts.logger;
	/** 这个绑定自己的一道闸:上报按到达顺序一条条翻。 */
	const gate = createSerialGate();
	let disposed = false;

	/**
	 * 写图库的口,**写不进的那张图缺着**:图库不收(`invalid`)本来就是缺着;磁盘写失败(`unavailable`)记一条 warn
	 * 也当缺着(卡上画占位),不让整条作品因为一张图存不进去而丢 —— `storeOrSkip` 对非 `invalid` 的失败是抛的。
	 */
	const images: Pick<ImageWriter, "put"> = {
		async put(bytes) {
			const stored = await opts.postImages.put(bytes);
			if (stored.ok || stored.code === "invalid") return stored;
			log.warn(`[ext-post] 作品图存不进图库,这张图缺着: ${stored.message}`);
			return fail("invalid", stored.message);
		},
	};

	async function translateFor(id: string, report: ReportedPost): Promise<void> {
		const sub = opts.subscription(id);
		if (!sub) {
			log.debug(`[ext-post] 订阅 ${id} 已删,作品 ${report.id} 不收`);
			return;
		}
		const identity = subscriptionIdentityOf(sub);
		const authorName = extensionSubscriptionName(sub, {
			eventName: report.author?.name,
			profileName: opts.profileName(id),
		});
		const post = await postFromReport(report, { authorName, images });
		if (disposed) return;
		opts.enqueue({
			subscriptionId: id,
			identity,
			postId: report.id,
			url: report.url,
			post,
			postNoun: opts.postNoun(identity.sourceKey),
		});
	}

	const watch = opts.bus.on("subscription-reported", (delivery) => {
		if (delivery.report.kind !== "post") return;
		const report = delivery.report.value;
		const ids = delivery.subscriptionIds;
		opts.serviceCtx.track(
			gate
				.run(async () => {
					for (const id of ids) {
						try {
							await translateFor(id, report);
						} catch (err) {
							log.error(
								`[ext-post] 订阅 ${id} 的作品 ${report.id} 翻译途中出错(不重试): ${errorMessageOf(err)}`,
							);
						}
					}
				})
				.catch((err: unknown) => {
					log.error(`[ext-post] 作品 ${report.id} 处理途中出错(不重试): ${errorMessageOf(err)}`);
				}),
		);
	});

	return {
		dispose() {
			disposed = true;
			watch.dispose();
		},
	};
}
