/**
 * **拓展报的直播交给场次引擎**(ADR-0019 决策 53 / 57 / 62;ADR-0021 决策 56 的过渡):bus 上
 * `subscription-reported` 里 `kind` 是 `liveStart` / `liveStatus` / `liveEnd` 的那些,逐条订阅翻成中立的
 * {@link LiveSignal} 交 {@link LiveSessionEngine.apply}。照 `posts/extension-post.ts` 的样子:
 *
 * 1. 查订阅(没有就跳过);
 * 2. 翻成中立的 {@link LiveDetails}(拓展交的封面与作者头像是字节,**在交出之前就写进图库**,信号里只有图库引用
 *    —— 关了出图、推送关着的直播也写,代价主人知情,同作品的先例,ADR-0028 / 3a-27 决策 3);图库不收的图
 *    (格式不认、超限)、磁盘写失败的那张缺着,不让整份信号因为一张图丢掉;
 * 3. 交场次引擎。
 *
 * - **同一个绑定的上报按到达顺序一条条翻**(绑定自己一道串行闸):翻译要写图库、是异步的,不排队的话同一条订阅先后
 *   两份信号交进引擎的次序会乱 —— 开播与下播颠倒,这一场就收不对;
 * - **下播的时刻是上报到达的那一刻**(不是翻完图的那一刻):写图库要几十毫秒,断流接续的等待与时长都不该
 *   把它算进去;
 * - **意外抛错只记错误日志、不重试**(决策 77):拓展的事件只来一次,BN 不替它重放;
 * - 上报的调用不等这里(决策 62):bus 的回调同步返回,活排进闸里,登记进 `track`;
 * - 关停先退订,再等闸里已经收下的活翻完交完;场次引擎随后才收场次。
 *
 * 这条路是过渡:3b-42 删拓展 v2 的上报之后,来源直接经 `ctx.reportLive` 交中立信号。
 */

import type {
	LiveDetails,
	LiveSignal,
	Logger,
	MessageBus,
	ServiceContext,
	Subscription,
	SubscriptionReportDelivery,
	SubscriptionReportValue,
} from "@bilibili-notify/internal";
import { createSerialGate, fail, subscriptionIdentityOf } from "@bilibili-notify/internal";
import type { ImageWriter } from "../images/image-store.js";
import { storeOrSkip } from "../images/image-writes.js";
import { extensionSubscriptionName } from "../runtime/extension-push-common.js";
import { errorMessageOf } from "../util/error-message.js";
import type { LiveSessionEngine } from "./live-sessions.js";

type ReportedLive =
	| SubscriptionReportValue<"liveStart">
	| SubscriptionReportValue<"liveStatus">
	| SubscriptionReportValue<"liveEnd">;

export interface BindExtensionLiveOptions {
	bus: Pick<MessageBus, "on">;
	logger: Logger;
	/**
	 * 每条订阅的翻译与交引擎是发出去不等的后台活:登记进 `track`,关停等它做完 —— 写图库的那一笔得赶在各写道
	 * 关门之前交进去。
	 */
	serviceCtx: Pick<ServiceContext, "track">;
	/** 此刻的这条订阅(现取)。 */
	subscription(id: string): Subscription | undefined;
	/** 订阅资料里的名字(资料缓存,现取):作者只带了头像没带名字时,名字按这一条链补。 */
	profileName(id: string): string | undefined;
	/** 往图库存直播封面与作者头像的口(`AppRuntime.liveImages`;名单是在播表各行的封面与头像)。 */
	liveImages: Pick<ImageWriter, "put">;
	/** 场次引擎:信号交到这里。 */
	sessions: Pick<LiveSessionEngine, "apply">;
	/** 只有测试会换。 */
	now?: () => number;
}

/** 毫秒 → ISO;不是有效时刻就是 `undefined`。 */
function isoOf(ms: number | undefined): string | undefined {
	if (ms === undefined) return undefined;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function bindExtensionLive(opts: BindExtensionLiveOptions): {
	dispose(): Promise<void>;
} {
	const log = opts.logger;
	const now = opts.now ?? Date.now;
	/** 这个绑定自己的一道闸:上报按到达顺序一条条翻。 */
	const gate = createSerialGate();
	/** 已进闸、还没翻完的活。关停先退订,再等这张表排空。 */
	const inFlight = new Set<Promise<void>>();
	let stopping: Promise<void> | undefined;

	/**
	 * 写图库的口,**写不进的那张图缺着**:图库不收(`invalid`)本来就是缺着;磁盘写失败(`unavailable`)记一条 warn
	 * 也当缺着,不让整份信号因为一张图存不进去而丢 —— `storeOrSkip` 对非 `invalid` 的失败是抛的。
	 */
	const images: Pick<ImageWriter, "put"> = {
		async put(bytes) {
			const stored = await opts.liveImages.put(bytes);
			if (stored.ok || stored.code === "invalid") return stored;
			log.warn(`[ext-live] 直播图存不进图库,这张图缺着: ${stored.message}`);
			return fail("invalid", stored.message);
		},
	};

	/** 上报里的直播那几格 → 中立详情;字节存进图库换成引用。没报的格不带键。 */
	async function detailsOf(
		sub: Subscription,
		value: ReportedLive,
		profileName: string | undefined,
	): Promise<LiveDetails> {
		const cover = value.cover ? await storeOrSkip(images, value.cover) : undefined;
		const author = value.author;
		let creator: LiveDetails["creator"];
		if (author) {
			const avatar = author.avatar ? await storeOrSkip(images, author.avatar) : undefined;
			creator = {
				name: extensionSubscriptionName(sub, { eventName: author.name, profileName }),
				...(avatar === undefined ? {} : { avatar }),
			};
		}
		const details: LiveDetails = {
			title: value.title,
			cover: cover === undefined ? undefined : { ref: cover },
			category: value.category,
			url: value.url,
			currentViewers: value.viewers,
			totalViewers: value.totalViewers,
			likes: value.likes,
			description: value.description,
			creator,
		};
		return Object.fromEntries(
			Object.entries(details).filter(([, cell]) => cell !== undefined),
		) as LiveDetails;
	}

	async function translateFor(
		id: string,
		report: SubscriptionReportDelivery["report"],
		arrivedAt: number,
	): Promise<void> {
		const sub = opts.subscription(id);
		if (!sub) {
			log.debug(`[ext-live] 订阅 ${id} 已删,直播上报不收`);
			return;
		}
		const identity = subscriptionIdentityOf(sub);
		const base = { subscriptionId: id, identity };
		let signal: LiveSignal;
		switch (report.kind) {
			case "liveStart": {
				const details = await detailsOf(sub, report.value, opts.profileName(id));
				signal = { ...base, kind: "start", startedAt: isoOf(report.value.startedAt), details };
				break;
			}
			case "liveStatus": {
				const details = await detailsOf(sub, report.value, opts.profileName(id));
				signal = {
					...base,
					kind: "status",
					isLive: report.value.live,
					startedAt: isoOf(report.value.startedAt),
					details,
				};
				break;
			}
			case "liveEnd": {
				const details = await detailsOf(sub, report.value, opts.profileName(id));
				signal = {
					...base,
					kind: "end",
					endedAt: new Date(arrivedAt).toISOString(),
					startedAt: isoOf(report.value.startedAt),
					details,
				};
				break;
			}
			default:
				return;
		}
		opts.sessions.apply(signal);
	}

	const watch = opts.bus.on("subscription-reported", (delivery) => {
		const { report } = delivery;
		if (report.kind !== "liveStart" && report.kind !== "liveStatus" && report.kind !== "liveEnd") {
			return;
		}
		const arrivedAt = now();
		const ids = delivery.subscriptionIds;
		const handling = gate
			.run(async () => {
				for (const id of ids) {
					try {
						await translateFor(id, report, arrivedAt);
					} catch (err) {
						log.error(
							`[ext-live] 订阅 ${id} 的${report.kind}翻译途中出错(不重试): ${errorMessageOf(err)}`,
						);
					}
				}
			})
			.catch((err: unknown) => {
				log.error(`[ext-live] ${report.kind} 处理途中出错(不重试): ${errorMessageOf(err)}`);
			});
		inFlight.add(handling);
		void handling.then(() => inFlight.delete(handling));
		opts.serviceCtx.track(handling);
	});

	return {
		dispose() {
			watch.dispose();
			stopping ??= (async () => {
				while (inFlight.size > 0) await Promise.all(inFlight);
			})();
			return stopping;
		},
	};
}
