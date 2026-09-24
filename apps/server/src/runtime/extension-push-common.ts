import { Buffer } from "node:buffer";
import { BLOCKED_IMG_PLACEHOLDER } from "@bilibili-notify/image";
import {
	type ExtensionSubscription,
	isExtensionSubscription,
	type Subscription,
	sniffImageFormat,
} from "@bilibili-notify/internal";

/**
 * **拓展订阅推送的公共件**(ADR-0019 决策 54 / 62 / 68 / 77)—— 拓展的作品(`extension-posts.ts`)与拓展的
 * 直播共用:卡上的作者、模板里的名字、「这条订阅现在还该推吗」、字节转 data URL。
 *
 * 绑到订阅上的发送与这条订阅折好的设置在 `engines.ts`(`bindSubscriptionPush` / `boundWorkPush` /
 * `dynamicWorkSettings`),与 B 站那两个适配器挨着 —— B 站那条路也是它们。
 */

/**
 * 拓展订阅推送要从宿主那头**现取**的几样。装载器比引擎晚建起来,拓展的装卸也随时发生,所以都是函数。
 */
export interface ExtensionSourceLookups {
	/** 这个拓展此刻在跑吗(决策 61:拓展停了,等着的推送不补)。 */
	running(extensionId: string): boolean;
	/** 清单里平台对作品的叫法(`contributes.subscription.display.postNoun`);没写就是 `undefined`。 */
	postNoun(extensionId: string): string | undefined;
	/** 这条订阅存下的头像文件(决策 49);没有就是 `undefined`。 */
	readAvatar(
		subscriptionId: string,
	): Promise<{ bytes: Uint8Array; contentType: string } | undefined>;
}

/**
 * 一张图的字节 → data URL。类型按文件头认(`sniffImageFormat`),认不出回 `undefined` —— 上报那一道
 * 已经只收位图,这里认不出多半是 BN 自己的 bug,不往卡里塞一个声明错了类型的图。
 *
 * 卡里的图只认字符串地址(决策 68):拓展交的是字节,没有公网网址。
 */
export function imageDataUrl(bytes: Uint8Array): string | undefined {
	const format = sniffImageFormat(bytes);
	return format ? dataUrl(bytes, `image/${format}`) : undefined;
}

function dataUrl(bytes: Uint8Array, contentType: string): string {
	return `data:${contentType};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`;
}

/** 有字才算有:空串、只有空白的都不算。 */
function filled(text: string | undefined): string | undefined {
	return text !== undefined && text.trim() !== "" ? text : undefined;
}

export interface ExtensionNameSources {
	/** 事件里带的作者名(决策 54)。 */
	eventName?: string;
	/** 订阅资料里的名字(拓展「报资料更新」存下的,`cachedProfile.name`)。 */
	profileName?: string;
}

/**
 * 这条拓展订阅此刻叫什么 —— 模板的 `{name}`(决策 77)与卡上的作者名都用它:事件里的作者名 → 订阅资料里
 * 的名字 → 主人手填的别名(订阅的 `name`)→ 外部 id。外部 id 恒有,所以总有个名字(与历史「没有名字就写
 * 外部 id」同一口径,决策 73)。
 *
 * ⚠️ 面板上标「备注」的是 `notes`,那是自由文字(「推给一群,周末别推」),**不当名字用** —— 印进卡里、
 * 套进文案就成了一句莫名其妙的话。
 */
export function extensionSubscriptionName(
	sub: ExtensionSubscription,
	from: ExtensionNameSources,
): string {
	return filled(from.eventName) ?? filled(from.profileName) ?? filled(sub.name) ?? sub.externalId;
}

/** 卡上的作者:名字与一张卡里加载得到的头像地址。 */
export interface ExtensionCardAuthor {
	name: string;
	avatarUrl: string;
}

export interface ExtensionCardAuthorSources {
	/** 事件里带的作者(名字 / 头像都选填,决策 54)。 */
	event?: { name?: string; avatar?: Uint8Array };
	/** 订阅资料里的名字。 */
	profileName?: string;
	/** 存下的头像文件(`SubAvatarStore.read`)。事件带了头像就不读。 */
	readStoredAvatar(): Promise<{ bytes: Uint8Array; contentType: string } | undefined>;
}

/**
 * 卡上的作者(决策 54):事件带的名字 / 头像优先;没带的那一样用订阅资料 —— 名字见
 * {@link extensionSubscriptionName},头像取存下的头像文件的**字节**转成 data URL(资料里存的是面板的
 * 相对地址 `/api/subs/<id>/avatar?v=…`,截图的浏览器加载不到,决策 68)。
 *
 * 哪儿都没有头像(或者读文件抛了)给透明占位:卡上留一块空的头像位,不画一张裂图。
 */
export async function extensionCardAuthor(
	sub: ExtensionSubscription,
	from: ExtensionCardAuthorSources,
): Promise<ExtensionCardAuthor> {
	const name = extensionSubscriptionName(sub, {
		eventName: from.event?.name,
		profileName: from.profileName,
	});
	const fromEvent = from.event?.avatar && imageDataUrl(from.event.avatar);
	if (fromEvent) return { name, avatarUrl: fromEvent };
	let stored: { bytes: Uint8Array; contentType: string } | undefined;
	try {
		stored = await from.readStoredAvatar();
	} catch {
		stored = undefined;
	}
	return {
		name,
		avatarUrl: stored ? dataUrl(stored.bytes, stored.contentType) : BLOCKED_IMG_PLACEHOLDER,
	};
}

/**
 * 这条订阅现在还该推吗:订阅还在、是拓展订阅、启用着、它的拓展还在跑。
 *
 * 事件分发那一刻 ctx 已经按开关筛过(决策 62),这里是出卡、点评几个 await 之后发送之前的**再核一次**
 * —— 期间主人可能停用了这条订阅、停用了拓展(决策 61:拓展停了,等着的推送不补)、或者删了它。
 */
export function extensionSubscriptionPushable(
	sub: Subscription | undefined,
	extensionRunning: (extensionId: string) => boolean,
): sub is ExtensionSubscription {
	return (
		sub !== undefined &&
		isExtensionSubscription(sub) &&
		sub.enabled &&
		extensionRunning(sub.extensionId)
	);
}
