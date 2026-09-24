/**
 * 拓展订阅推送的公共件(ADR-0019 决策 54 / 62 / 77):作品与直播两条路都用。
 *
 * - 卡上的作者:事件带的名字 / 头像优先,没带的那一样用订阅资料(名字取资料缓存,头像取存下的头像
 *   文件)。头像一律转成 data URL —— 存下的是面板里的相对地址,截图时加载不到(决策 68)。
 * - 模板里的 `{name}`:事件作者名 → 资料里的名字 → 主人手填的别名(`name`)→ 外部 id(决策 77)。
 *   面板上标「备注」的 `notes` 是自由文字,不当名字用。
 * - 这条订阅现在还该推吗:订阅还在、启用着、它的拓展还在跑。
 */

import { BLOCKED_IMG_PLACEHOLDER } from "@bilibili-notify/image";
import { makeEmptySubscription } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import {
	extensionCardAuthor,
	extensionSubscriptionName,
	extensionSubscriptionPushable,
} from "../extension-push-common.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const SUB = makeExtensionSubscription({
	externalId: "sec-uid-1",
	name: "手填的别名",
	notes: "推给一群和二群,周末别推",
});

describe("模板里的 {name}:事件作者名 → 资料名 → 别名 → 外部 id(决策 77)", () => {
	it("一级一级往下退;空串与只有空白的不算有", () => {
		expect(extensionSubscriptionName(SUB, { eventName: "事件里的", profileName: "资料里的" })).toBe(
			"事件里的",
		);
		expect(extensionSubscriptionName(SUB, { eventName: " ", profileName: "资料里的" })).toBe(
			"资料里的",
		);
		expect(extensionSubscriptionName(SUB, { profileName: "" })).toBe("手填的别名");
		expect(extensionSubscriptionName({ ...SUB, name: "  " }, {})).toBe("sec-uid-1");
	});

	it("备注(`notes`)是自由文字,从来不当名字:没有别名就直接退到外部 id", () => {
		expect(extensionSubscriptionName({ ...SUB, name: undefined }, {})).toBe("sec-uid-1");
	});
});

describe("卡上的作者(决策 54)", () => {
	it("事件带了名字与头像:都用事件的,不去读存下的头像", async () => {
		const readStoredAvatar = vi.fn(async () => ({ bytes: WEBP, contentType: "image/webp" }));
		const author = await extensionCardAuthor(SUB, {
			event: { name: "事件里的", avatar: PNG },
			profileName: "资料里的",
			readStoredAvatar,
		});
		expect(author).toEqual({ name: "事件里的", avatarUrl: `data:image/png;base64,${b64(PNG)}` });
		expect(readStoredAvatar).not.toHaveBeenCalled();
	});

	it("事件只带了名字:头像用存下的头像文件,按它的类型转成 data URL", async () => {
		const author = await extensionCardAuthor(SUB, {
			event: { name: "事件里的" },
			profileName: "资料里的",
			readStoredAvatar: async () => ({ bytes: WEBP, contentType: "image/webp" }),
		});
		expect(author).toEqual({ name: "事件里的", avatarUrl: `data:image/webp;base64,${b64(WEBP)}` });
	});

	it("事件只带了头像:名字用资料里的", async () => {
		const author = await extensionCardAuthor(SUB, {
			event: { avatar: PNG },
			profileName: "资料里的",
			readStoredAvatar: async () => undefined,
		});
		expect(author.name).toBe("资料里的");
	});

	it("哪儿都没有头像(或读头像文件抛了):给透明占位,不让卡上裂一张图", async () => {
		const none = await extensionCardAuthor(SUB, { readStoredAvatar: async () => undefined });
		expect(none).toEqual({ name: "手填的别名", avatarUrl: BLOCKED_IMG_PLACEHOLDER });
		const broken = await extensionCardAuthor(SUB, {
			readStoredAvatar: async () => {
				throw new Error("EACCES");
			},
		});
		expect(broken.avatarUrl).toBe(BLOCKED_IMG_PLACEHOLDER);
	});
});

describe("这条订阅现在还该推吗", () => {
	const running = (id: string) => id === "douyin";

	it("订阅还在、是拓展订阅、启用着、它的拓展在跑 —— 四样都得是", () => {
		expect(extensionSubscriptionPushable(SUB, running)).toBe(true);
		expect(extensionSubscriptionPushable(undefined, running)).toBe(false);
		expect(extensionSubscriptionPushable({ ...SUB, enabled: false }, running)).toBe(false);
		expect(extensionSubscriptionPushable({ ...SUB, extensionId: "other" }, running)).toBe(false);
		expect(
			extensionSubscriptionPushable(
				makeEmptySubscription({ id: SUB.id, uid: "100" }) as never,
				() => true,
			),
		).toBe(false);
	});
});
