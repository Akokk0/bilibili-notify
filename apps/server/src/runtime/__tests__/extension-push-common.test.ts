/**
 * 拓展订阅推送的公共件(ADR-0019 决策 54 / 62 / 77):作品与直播两条路都用。
 *
 * - 读订阅资料里的头像(`readProfileAvatar`,锐评卡用)。㉒c 之前这里还有「卡上的作者」(`extensionCardAuthor`:
 *   事件头像 / 资料头像都转成 data URL):拓展直播卡改走图库引用后它退役了,「事件带的优先、没带的用资料里的」
 *   这条规矩由 `live-card-input-from-report.test.ts` 钉着。模板里的 `{name}` 的取法搬去了 contract 的
 *   `displayNameOf`(事件名 → 资料名 → 身份标签,决策 77),由 `apps/contract/src/__tests__/nouns.test.ts` 钉着。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { readProfileAvatar } from "../extension-push-common.js";

const WEBP = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);

describe("读订阅资料里的头像(readProfileAvatar):资料里的 avatar 是图库引用,字节从图库取", () => {
	const REF = `${"a".repeat(64)}.webp`;
	const runtimeWith = (
		cachedProfile: { avatar?: string } | undefined,
		read: (ref: string) => Promise<{ bytes: Buffer; mime: string } | undefined>,
	) => ({
		subscriptionStateStore: { get: () => (cachedProfile ? { cachedProfile } : undefined) },
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

	it("没有图库引用(没有资料或没有头像):不去图库问", async () => {
		for (const profile of [undefined, {}, { avatar: undefined }]) {
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
