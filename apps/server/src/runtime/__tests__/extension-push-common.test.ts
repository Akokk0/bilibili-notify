/**
 * 拓展订阅推送的公共件(ADR-0019 决策 54 / 62 / 77):作品与直播两条路都用。
 *
 * - 卡上的作者:事件带的名字 / 头像优先,没带的那一样用订阅资料(名字取资料缓存,头像取资料里引用的那张
 *   图库里的图)。头像一律转成 data URL —— 面板上用的是同源的 `/api/images/<ref>`,截图时加载不到(决策 68)。
 * - 模板里的 `{name}`:事件作者名 → 资料里的名字 → 外部 id(决策 77;手填的别名已退役,ADR-0021 决策 16)。
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
	readProfileAvatar,
} from "../extension-push-common.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const SUB = makeExtensionSubscription({
	externalId: "sec-uid-1",
	notes: "推给一群和二群,周末别推",
});

describe("模板里的 {name}:事件作者名 → 资料名 → 外部 id(决策 77;别名已退役,ADR-0021 决策 16)", () => {
	it("一级一级往下退;空串与只有空白的不算有", () => {
		expect(extensionSubscriptionName(SUB, { eventName: "事件里的", profileName: "资料里的" })).toBe(
			"事件里的",
		);
		expect(extensionSubscriptionName(SUB, { eventName: " ", profileName: "资料里的" })).toBe(
			"资料里的",
		);
		expect(extensionSubscriptionName(SUB, { profileName: "  " })).toBe("sec-uid-1");
	});

	it("备注(`notes`)是自由文字,从来不当名字:没有资料名就直接退到外部 id", () => {
		expect(extensionSubscriptionName(SUB, {})).toBe("sec-uid-1");
	});
});

describe("卡上的作者(决策 54)", () => {
	it("事件带了名字与头像:都用事件的,不去读存下的头像", async () => {
		const readStoredAvatar = vi.fn(async () => ({ bytes: WEBP, mime: "image/webp" }));
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
			readStoredAvatar: async () => ({ bytes: WEBP, mime: "image/webp" }),
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
		expect(none).toEqual({ name: "sec-uid-1", avatarUrl: BLOCKED_IMG_PLACEHOLDER });
		const broken = await extensionCardAuthor(SUB, {
			readStoredAvatar: async () => {
				throw new Error("EACCES");
			},
		});
		expect(broken.avatarUrl).toBe(BLOCKED_IMG_PLACEHOLDER);
	});
});

describe("读订阅资料里的头像(readProfileAvatar):资料里的 avatar 是图库引用,字节从图库取", () => {
	const REF = `${"a".repeat(64)}.webp`;
	const runtimeWith = (
		cachedProfile: { avatar?: string; avatarUrl?: string } | undefined,
		read: (ref: string) => Promise<{ bytes: Buffer; mime: string } | undefined>,
	) => ({
		subRuntimeStore: { get: () => (cachedProfile ? { cachedProfile } : undefined) },
		imageStore: { read: vi.fn(read) },
	});

	it("有图库引用且图在:交出字节与类型", async () => {
		const runtime = runtimeWith({ avatar: REF }, async () => ({
			bytes: Buffer.from(WEBP),
			mime: "image/webp",
		}));
		const stored = await readProfileAvatar(runtime as never, "s1");
		expect(stored?.mime).toBe("image/webp");
		expect(Buffer.from(stored?.bytes ?? []).equals(Buffer.from(WEBP))).toBe(true);
		expect(runtime.imageStore.read).toHaveBeenCalledWith(REF);
	});

	it("没有图库引用(没有资料、没有头像、B 站的远端网址):不去图库问", async () => {
		for (const profile of [undefined, {}, { avatarUrl: "https://i0.hdslb.com/a.jpg" }]) {
			const runtime = runtimeWith(profile, async () => undefined);
			expect(await readProfileAvatar(runtime as never, "s1")).toBeUndefined();
			expect(runtime.imageStore.read).not.toHaveBeenCalled();
		}
	});

	it("引用指着的图已经不在了:没有头像", async () => {
		const runtime = runtimeWith({ avatar: REF }, async () => undefined);
		expect(await readProfileAvatar(runtime as never, "s1")).toBeUndefined();
	});
});

describe("这条订阅现在还该推吗", () => {
	const running = (id: string) => id === "douyin";

	it("订阅还在、是拓展订阅、启用着、它的拓展在跑 —— 四样都得是", () => {
		expect(extensionSubscriptionPushable(SUB, running)).toBe(true);
		expect(extensionSubscriptionPushable(undefined, running)).toBe(false);
		expect(extensionSubscriptionPushable({ ...SUB, enabled: false }, running)).toBe(false);
		expect(
			extensionSubscriptionPushable(
				{ ...SUB, identity: { ...SUB.identity, sourceKey: "other" } },
				running,
			),
		).toBe(false);
		expect(
			extensionSubscriptionPushable(
				makeEmptySubscription({
					id: SUB.id,
					identity: { sourceKey: "bilibili", externalId: "100" },
				}),
				() => true,
			),
		).toBe(false);
	});
});
