import {
	featuresForEvents,
	type SubscriptionEventKind,
	sniffImageFormat,
} from "@bilibili-notify/internal";
import { bytesDataUrl } from "../images/image-data-url.js";
import type { ImageStore } from "../images/image-store.js";
import type { SubscriptionStateStore } from "./subscription-state-store.js";

/**
 * **拓展订阅推送的公共件**(ADR-0019 决策 54 / 62 / 68 / 77)—— 拓展的作品(`posts/extension-post.ts`)与拓展的
 * 直播共用:字节转 data URL。
 *
 * 绑到订阅上的发送与这条订阅折好的设置在 `engines.ts`(`boundPostPush` / `boundLivePush` /
 * `postSettingsOf` / `liveSettingsOf`),与 B 站那两个适配器挨着 —— B 站那条路也是它们。
 */

/**
 * 拓展订阅推送要从宿主那头**现取**的几样。装载器比引擎晚建起来,拓展的装卸也随时发生,所以都是函数。
 */
export interface ExtensionSourceReader {
	/** 这个拓展此刻在跑吗(决策 61:拓展停了,等着的推送不补)。 */
	running(extensionId: string): boolean;
	/** 清单里平台对作品的叫法(`contributes.subscription.display.postNoun`);没写就是 `undefined`。 */
	postNoun(extensionId: string): string | undefined;
	/**
	 * 清单里这个源声明的事件(`contributes.subscription.events`);现取不到(装载器还没起来、清单没交订阅那一口)
	 * 就是 `undefined`。直播推送的 `hasLiveTick` 据它答,见 {@link extensionHasLiveTick}。
	 */
	events(extensionId: string): readonly SubscriptionEventKind[] | undefined;
}

/**
 * 这个拓展有没有周期「正在直播」这一档:清单声明了开播与下播两种事件才有(`featuresForEvents`,面板上那一行
 * 「直播中」与这里同一条规则)—— 只报开播的源没有下播事件把这一场收掉,周期推送一开就没有尽头。清单现取不到时
 * 不拦:只在明确知道声明不全时才答没有。
 */
export function extensionHasLiveTick(
	sources: Pick<ExtensionSourceReader, "events">,
	sourceKey: string,
): boolean {
	const events = sources.events(sourceKey);
	return events === undefined || featuresForEvents(events).includes("liveStreaming");
}

/** 图库里读出来的一张头像:字节与它的类型(图库按嗅探定的 mime)。 */
export interface StoredAvatar {
	bytes: Uint8Array;
	mime: string;
}

/**
 * 这条订阅资料里存进图库的头像。资料里的 `avatar` 是图库引用(两支订阅都有;`avatarUrl` 只是来源地址,
 * 不是图库的东西);没有头像、或引用指着的图已经不在了都回 `undefined`。读盘出错就抛,调用方各自决定怎么兜底。
 *
 * 锐评卡用:它的图只认字符串地址(决策 68),要把字节转成 data URL,面板用的 `/api/images/<ref>`
 * 截图的浏览器加载不到。拓展作品卡与拓展直播卡不走这里:头像是图库引用,出图器按引用取
 * (`postFromReport` / `liveCardInputFromReport` + `images/image-data-url.ts`)。
 */
export async function readProfileAvatar(
	runtime: {
		subscriptionStateStore: Pick<SubscriptionStateStore, "get">;
		imageStore: Pick<ImageStore, "read">;
	},
	subscriptionId: string,
): Promise<StoredAvatar | undefined> {
	const ref = runtime.subscriptionStateStore.get(subscriptionId)?.cachedProfile?.avatar;
	if (ref === undefined) return undefined;
	return (await runtime.imageStore.read(ref)) ?? undefined;
}

/**
 * 一张图的字节 → data URL。类型按文件头认(`sniffImageFormat`),认不出回 `undefined` —— 上报那一道
 * 已经只收位图,这里认不出多半是 BN 自己的 bug,不往卡里塞一个声明错了类型的图。
 *
 * 卡里的图只认字符串地址(决策 68):拓展交的是字节,没有公网网址。
 */
export function imageDataUrl(bytes: Uint8Array): string | undefined {
	const format = sniffImageFormat(bytes);
	return format ? bytesDataUrl(`image/${format}`, bytes) : undefined;
}
