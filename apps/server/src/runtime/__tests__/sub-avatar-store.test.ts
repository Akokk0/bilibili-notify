/**
 * 拓展订阅的头像文件(ADR-0019 决策 49):`<dataDir>/avatars/<订阅 id>.<png|jpeg|webp>`。
 *
 * 建订阅 / 取头像 / 删订阅走的是 `/api/subscriptions` 那几口(见 `routes/__tests__/subs-extension-create.test.ts`);
 * 这里钉路由够不着的三件:
 *  - 开机清扫:订阅已经不在的头像、崩溃时留下的半截临时文件都扫掉,不认得的文件不碰。
 *  - 同一条订阅换了图的类型(png → webp),旧类型的那个文件跟着删掉,读到的是新的。
 *  - 声明的类型与字节对不上 → 拒收,一个字节都不落盘。
 *  - 拓展报资料时交的字节(决策 62):类型按文件头认,内容没变就不重写。
 */

import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Logger, SUBSCRIPTION_AVATAR_MAX_BYTES } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	avatarDataUrl,
	JPEG_BYTES,
	PNG_BYTES,
	WEBP_BYTES,
} from "../../__tests__/support/avatar-fixtures.js";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import { makeTrackingContext, stillPending } from "../../__tests__/support/track-context.js";
import { createNodeMessageBus } from "../message-bus.js";
import {
	bindSubAvatarCleanup,
	createSubAvatarStore,
	type SubAvatarStore,
} from "../sub-avatar-store.js";

// 落盘函数前的闸默认敞开;只有「close」那组用例才 hold(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

const KEEP = "a0000000-0000-4000-8000-000000000001";
const GONE = "a0000000-0000-4000-8000-000000000002";

function makeLogger(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

let dataDir: string;
let avatarsDir: string;
let store: SubAvatarStore;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-sub-avatar-"));
	avatarsDir = join(dataDir, "avatars");
	store = createSubAvatarStore({ dataRoot: dataDir, logger: makeLogger() });
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

async function files(): Promise<string[]> {
	try {
		return (await readdir(avatarsDir)).sort();
	} catch {
		return [];
	}
}

describe("开机清扫", () => {
	it("订阅不在了的、崩溃留下的临时文件都扫掉;还在的留着;不认得的文件不碰", async () => {
		await store.write(KEEP, avatarDataUrl("png", PNG_BYTES));
		await store.write(GONE, avatarDataUrl("jpeg", JPEG_BYTES));
		await writeFile(join(avatarsDir, `${KEEP}.webp.tmp.123.abcdef`), WEBP_BYTES);
		await writeFile(join(avatarsDir, "README.txt"), "主人放的");
		expect(await files()).toEqual([
			"README.txt",
			`${KEEP}.png`,
			`${KEEP}.webp.tmp.123.abcdef`,
			`${GONE}.jpeg`,
		]);

		await store.sweep([KEEP]);

		expect(await files()).toEqual(["README.txt", `${KEEP}.png`]);
		expect(await store.read(GONE)).toBeUndefined();
		expect((await store.read(KEEP))?.bytes.equals(PNG_BYTES)).toBe(true);
	});

	/**
	 * 现在头像走存储层的原子写,写到一半被杀留下的是 `<id>.<后缀>.bn-tmp.<pid>.<随机>`(上一个
	 * 用例里的 `.tmp.` 是升级之前留下的老残留,照样得扫)。两种都得收,不然升级前后各漏一批。
	 */
	it("存储层原子写留下的临时文件也扫掉;还在的头像不碰", async () => {
		await store.write(KEEP, avatarDataUrl("png", PNG_BYTES));
		await writeFile(join(avatarsDir, `${KEEP}.png.bn-tmp.123.abcdef`), PNG_BYTES);
		await writeFile(join(avatarsDir, `${GONE}.webp.bn-tmp.456.0123ab`), WEBP_BYTES);
		await writeFile(join(avatarsDir, "README.txt"), "主人放的");

		await store.sweep([KEEP]);

		expect(await files()).toEqual(["README.txt", `${KEEP}.png`]);
		expect((await store.read(KEEP))?.bytes.equals(PNG_BYTES)).toBe(true);
	});

	it("还没有头像目录 → 什么都不做,也不替它建", async () => {
		await store.sweep([KEEP]);
		await expect(readdir(avatarsDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("写", () => {
	it("同一条订阅换了类型:旧类型那个文件删掉,读到的是新的;地址的摘要跟着变", async () => {
		const first = await store.write(KEEP, avatarDataUrl("png", PNG_BYTES));
		const second = await store.write(KEEP, avatarDataUrl("webp", WEBP_BYTES));

		expect(await files()).toEqual([`${KEEP}.webp`]);
		const read = await store.read(KEEP);
		expect(read?.contentType).toBe("image/webp");
		expect(read?.bytes.equals(WEBP_BYTES)).toBe(true);
		expect(first).toMatch(new RegExp(`^/api/subscriptions/${KEEP}/avatar\\?v=[0-9a-f]{12}$`));
		expect(second).toMatch(new RegExp(`^/api/subscriptions/${KEEP}/avatar\\?v=[0-9a-f]{12}$`));
		expect(second).not.toBe(first);
	});

	it("同一份字节写两次,地址不变(浏览器的缓存照样命中)", async () => {
		const a = await store.write(KEEP, avatarDataUrl("png", PNG_BYTES));
		const b = await store.write(KEEP, avatarDataUrl("png", PNG_BYTES));
		expect(b).toBe(a);
	});

	it.each([
		["声明 png、字节是 jpeg", avatarDataUrl("png", JPEG_BYTES)],
		["声明 webp、字节是 png", avatarDataUrl("webp", PNG_BYTES)],
		["声明 jpeg、字节是 webp", avatarDataUrl("jpeg", WEBP_BYTES)],
		["svg", avatarDataUrl("svg+xml", Buffer.from("<svg/>"))],
	])("%s → 拒收,不落盘", async (_label, dataUrl) => {
		await expect(store.write(KEEP, dataUrl)).rejects.toThrow();
		expect(await files()).toEqual([]);
	});

	it("订阅 id 不是 uuid → 拒收(它要当文件名用)", async () => {
		await expect(store.write("../escape", avatarDataUrl("png", PNG_BYTES))).rejects.toThrow();
		expect(await readdir(dataDir)).toEqual([]);
	});

	/**
	 * 「内容没变就不重写」(ADR-0019 决策 49 / 62):拓展每轮都可能报一次资料,同一张头像每次都改名换
	 * 一个新文件的话,盘在白写、读的人还可能撞上换文件那一瞬。判据是 inode —— 先写临时文件再改名
	 * 就是换了一个 inode,mtime 的精度在有的文件系统上分不出两次写。
	 */
	it("同一份字节再写一次:文件不重写(inode 不变)", async () => {
		await store.write(KEEP, avatarDataUrl("png", PNG_BYTES));
		const before = (await stat(join(avatarsDir, `${KEEP}.png`))).ino;
		await store.writeBytes(KEEP, new Uint8Array(PNG_BYTES));
		expect((await stat(join(avatarsDir, `${KEEP}.png`))).ino).toBe(before);
		expect(await files()).toEqual([`${KEEP}.png`]);
	});
});

describe("写字节(报资料更新,决策 62)", () => {
	it("按文件头认类型:与 data URL 那条路落同一个文件、回同一个地址", async () => {
		const viaBytes = await store.writeBytes(KEEP, new Uint8Array(WEBP_BYTES));
		expect(await files()).toEqual([`${KEEP}.webp`]);
		const read = await store.read(KEEP);
		expect(read?.contentType).toBe("image/webp");
		expect(read?.bytes.equals(WEBP_BYTES)).toBe(true);
		expect(await store.write(KEEP, avatarDataUrl("webp", WEBP_BYTES))).toBe(viaBytes);
	});

	it("换了一张:覆盖,地址的摘要跟着变", async () => {
		const first = await store.writeBytes(KEEP, new Uint8Array(PNG_BYTES));
		const second = await store.writeBytes(KEEP, new Uint8Array(JPEG_BYTES));
		expect(second).not.toBe(first);
		expect(await files()).toEqual([`${KEEP}.jpeg`]);
	});

	it.each([
		["gif", Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")],
		["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
		["空的", Buffer.alloc(0)],
		["超过头像的上限", Buffer.concat([PNG_BYTES, Buffer.alloc(SUBSCRIPTION_AVATAR_MAX_BYTES)])],
	])("%s → 拒收,不落盘", async (_label, bytes) => {
		await expect(store.writeBytes(KEEP, new Uint8Array(bytes))).rejects.toThrow();
		expect(await files()).toEqual([]);
	});
});

describe("删", () => {
	it("删掉这条订阅的头像,别人的不动;删一个没有的不报错", async () => {
		await store.write(KEEP, avatarDataUrl("png", PNG_BYTES));
		await store.write(GONE, avatarDataUrl("jpeg", JPEG_BYTES));
		await store.remove(GONE);
		await store.remove(GONE);
		expect(await files()).toEqual([`${KEEP}.png`]);
	});
});

describe("SubAvatarStore.close", () => {
	beforeEach(() => storageWriteGate.reset());
	afterEach(() => storageWriteGate.reset());

	it("close 等在途的写落盘", async () => {
		storageWriteGate.hold();
		const writing = store.write(KEEP, avatarDataUrl("png", PNG_BYTES));
		await storageWriteGate.arrived();

		let closed = false;
		const closing = store.close().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(closed).toBe(false);

		storageWriteGate.release();
		await closing;
		await writing;
		expect(await files()).toEqual([`${KEEP}.png`]);
	});

	it("close 之后的写被拒且不碰盘", async () => {
		await store.write(KEEP, avatarDataUrl("png", PNG_BYTES));
		await store.close();
		const writesAtClose = storageWriteGate.writes;

		await expect(store.write(GONE, avatarDataUrl("jpeg", JPEG_BYTES))).rejects.toMatchObject({
			code: "queue_closed",
		});
		await expect(store.writeBytes(GONE, WEBP_BYTES)).rejects.toMatchObject({
			code: "queue_closed",
		});
		await expect(store.remove(KEEP)).rejects.toMatchObject({ code: "queue_closed" });
		await expect(store.sweep([])).rejects.toMatchObject({ code: "queue_closed" });

		expect(storageWriteGate.writes).toBe(writesAtClose);
		expect(await files()).toEqual([`${KEEP}.png`]);
	});
});

describe("bindSubAvatarCleanup × ctx.track", () => {
	beforeEach(() => storageWriteGate.reset());
	afterEach(() => storageWriteGate.reset());

	// 删订阅时删头像是发出去就不等的写。不登记的话,关停在头像仓关门时它可能还排在队里 ——
	// 关门之后那次删被拒,头像文件成了没人认的孤儿。
	it("删拓展订阅的头像登记进 track:删完它才落定", async () => {
		await store.write(KEEP, avatarDataUrl("png", PNG_BYTES));
		const ctx = makeTrackingContext();
		const bus = createNodeMessageBus();
		const binding = bindSubAvatarCleanup({
			bus,
			avatars: store,
			logger: makeLogger(),
			serviceCtx: ctx,
		});
		// 队里先压一笔停在半路的写,删排在它后面。
		storageWriteGate.hold();
		const writing = store.write(GONE, avatarDataUrl("jpeg", JPEG_BYTES));
		await storageWriteGate.arrived();

		bus.emit("subscription-changed", {
			ops: [{ type: "remove", sub: makeExtensionSubscription({ id: KEEP }) }],
		});

		expect(ctx.tracked).toHaveLength(1);
		expect(await stillPending(ctx.settled())).toBe(true);
		expect(await files()).toContain(`${KEEP}.png`);
		storageWriteGate.release();
		await ctx.settled();
		await writing;
		expect(await files()).toEqual([`${GONE}.jpeg`]);
		binding.dispose();
	});

	it("头像仓已经关门:登记进去的这件事不拒,记一条 warn", async () => {
		const ctx = makeTrackingContext();
		const bus = createNodeMessageBus();
		const logger = makeLogger();
		bindSubAvatarCleanup({ bus, avatars: store, logger, serviceCtx: ctx });
		await store.close();

		bus.emit("subscription-changed", {
			ops: [{ type: "remove", sub: makeExtensionSubscription({ id: KEEP }) }],
		});

		expect(ctx.tracked).toHaveLength(1);
		await expect(ctx.tracked[0]).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("SerialQueueClosedError"));
	});

	it("B 站订阅没有头像文件:什么都不登记", async () => {
		const ctx = makeTrackingContext();
		const bus = createNodeMessageBus();
		bindSubAvatarCleanup({ bus, avatars: store, logger: makeLogger(), serviceCtx: ctx });

		bus.emit("subscription-changed", {
			ops: [
				{
					type: "remove",
					sub: {
						id: KEEP,
						identity: { sourceKey: "bilibili", externalId: "1" },
						enabled: true,
					} as never,
				},
			],
		});

		expect(ctx.tracked).toHaveLength(0);
	});
});
