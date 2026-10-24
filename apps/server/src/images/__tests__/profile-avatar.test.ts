import { describe, expect, it, vi } from "vite-plus/test";
import { readProfileAvatar } from "../profile-avatar.js";

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
