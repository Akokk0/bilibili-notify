/**
 * 集成上下文新增的三格(`http`、`fetchImage`、`storeImage`)在测试里的来源:一个不联网的请求客户端,和一个记账的
 * 「在途」写口。手搓 `createIntegrationContext` 的测试把它们展开进选项就够了,不必各写一份。
 */

import { CookieJar, generateBrowserIdentity, HttpClient } from "@bilibili-notify/http";
import {
	type Disposable,
	fail,
	type ImageRef,
	type IntegrationContext,
	ok,
} from "@bilibili-notify/internal";
import { type ImageWriter, imageRefOf } from "../../images/image-store.js";

export interface IntegrationIo {
	timezoneReader: Pick<IntegrationContext, "timezone" | "onTimezoneChanged">;
	/** 造出来的请求客户端(身份和罐子都是新的)。 */
	http: HttpClient;
	/** 在途写口:认得出是图就回引用,把字节记在 `stored` 里;不是图回 `invalid`。 */
	transitImages: Pick<ImageWriter, "put">;
	/** 写口收到过的字节,按先后。 */
	stored: Uint8Array[];
}

/** 不关心图的测试用的「在途」写口:谁来存都回 `unavailable`,不记账。 */
export const inertTransitImages: Pick<ImageWriter, "put"> = {
	async put() {
		return fail("unavailable", "测试里的在途写口不存图");
	},
};

/** 不关心定时的测试用的可回收定时器:真的 `setTimeout`,`dispose` 清掉它。 */
export function realTimeout(fn: () => void, ms: number): Disposable {
	const timer = setTimeout(fn, ms);
	return { dispose: () => clearTimeout(timer) };
}

export function integrationIo(): IntegrationIo {
	const stored: Uint8Array[] = [];
	return {
		timezoneReader: {
			timezone: () => "Asia/Shanghai",
			onTimezoneChanged: () => ({ dispose() {} }),
		},
		http: new HttpClient({ jar: new CookieJar(), identity: generateBrowserIdentity() }),
		stored,
		transitImages: {
			async put(bytes) {
				const ref: ImageRef | undefined = imageRefOf(bytes);
				if (!ref) return fail("invalid", "不是图库收的图");
				stored.push(bytes);
				return ok({ ref });
			},
		},
	};
}

/** 与本测试无关的时区能力也给明确值,不让生产可选默认掩盖漏装配。 */
export function fixedTimezone(
	timezone: string,
): Pick<IntegrationContext, "timezone" | "onTimezoneChanged"> {
	return { timezone: () => timezone, onTimezoneChanged: () => ({ dispose() {} }) };
}
