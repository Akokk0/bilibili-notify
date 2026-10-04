/**
 * 拓展报的资料更新落盘(`bindReportedProfiles`,ADR-0019 决策 7 / 49 / 62)—— 开机级那条
 * (`__tests__/reported-profile-e2e.test.ts`)钉的是「报了 → 订阅列表读得到」;这里钉它够不着的三件:
 *  - 一阵连着的资料更新,面板只被叫一次(一百条订阅不该刷出一百帧、一百次重取);
 *  - 订阅刚删、拓展还没收到通知时报来的,不再替它种资料、存头像(那就是孤儿,要等图库清扫才收);
 *  - 头像存不下来,名字与粉丝照样更新。
 * 头像存进图库(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗):资料里放的是图库引用;没给头像时沿用旧的引用 ——
 * 沿用也是抄引用,要先 `keep` 续期,图已经不在了就两格都缺。
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, SubscriptionReportDelivery } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { JPEG_BYTES, PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import {
	createImageStore,
	type ImageStore,
	type ImageWriter,
	isValidImageRef,
} from "../../images/image-store.js";
import { createNodeMessageBus } from "../message-bus.js";
import { bindReportedProfiles, type ReportedProfilesHandle } from "../reported-profiles.js";
import {
	createSubRuntimeStore,
	SUB_RUNTIME_FILE,
	type SubRuntimeStore,
} from "../sub-runtime-store.js";

// 落盘函数前的闸默认敞开;只有「close」那组用例才 hold(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

const A = "d0000000-0000-4000-8000-000000000001";
const B = "d0000000-0000-4000-8000-000000000002";
const GONE = "d0000000-0000-4000-8000-000000000003";

function makeLogger(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function profileReport(
	subscriptionIds: string[],
	value: { name?: string; fans?: number; avatar?: Uint8Array },
): SubscriptionReportDelivery {
	return {
		extensionId: "douyin",
		externalId: "person",
		subscriptionIds,
		report: { kind: "profile", value },
	};
}

let dataDir: string;
let bus: ReturnType<typeof createNodeMessageBus>;
let subRuntime: SubRuntimeStore;
let imageStore: ImageStore;
let images: ImageWriter;
let alive: string[];
let handle: ReportedProfilesHandle;
let announced: string[][];

function bind(over: { images?: ImageWriter; coalesceMs?: number } = {}): void {
	handle = bindReportedProfiles({
		bus,
		subRuntime,
		images: over.images ?? images,
		subscriptionIds: () => alive,
		logger: makeLogger(),
		coalesceMs: over.coalesceMs ?? 30,
	});
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-reported-profiles-"));
	bus = createNodeMessageBus();
	subRuntime = createSubRuntimeStore({ dataRoot: dataDir, logger: makeLogger() });
	imageStore = createImageStore({ dir: join(dataDir, "images") });
	images = imageStore.register({ name: "订阅资料", listRefs: () => subRuntime.listImageRefs() });
	alive = [A, B];
	announced = [];
	bus.on("subscription-profiles-changed", ({ subscriptionIds }) => {
		announced.push([...subscriptionIds].sort());
	});
});

afterEach(async () => {
	handle.dispose();
	await imageStore.close();
	await rm(dataDir, { recursive: true, force: true });
});

const imagesOnDisk = () => readdir(join(dataDir, "images"));

describe("bindReportedProfiles", () => {
	it("一阵连着报了好几条:面板只被叫一次,带上变了的全部订阅", async () => {
		// 三条是排队一条条落盘的,每条一次原子写(带 fsync):合并窗口从第一条变了开始计时,窄了的话
		// 机器一忙,后面几条还没落完窗口就到了,一阵被拆成两次叫面板。这里要断言的是「一个窗口里
		// 攒齐」,所以窗口给宽、等的时间跟着放宽;别的用例不看合并,仍用默认的窄窗口。
		const coalesceMs = 300;
		bind({ coalesceMs });
		bus.emit("subscription-reported", profileReport([A], { name: "甲" }));
		bus.emit("subscription-reported", profileReport([B], { name: "乙" }));
		bus.emit("subscription-reported", profileReport([A], { fans: 3 }));
		await handle.idle();

		await vi.waitFor(() => expect(announced).toEqual([[A, B]]), { timeout: coalesceMs * 10 });
		await new Promise((resolve) => setTimeout(resolve, coalesceMs + 50));
		expect(announced).toHaveLength(1);
		// 后报的粉丝没把先报的名字冲掉 —— 排成一条队处理。
		expect(subRuntime.get(A)?.cachedProfile).toMatchObject({ name: "甲", fans: 3 });
		expect(subRuntime.get(B)?.cachedProfile).toMatchObject({ name: "乙" });
	});

	it("订阅已经不在了:不种资料、不存头像,也不叫面板", async () => {
		bind();
		bus.emit("subscription-reported", profileReport([GONE], { name: "丙", avatar: PNG_BYTES }));
		await handle.idle();
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(subRuntime.get(GONE)).toBeUndefined();
		await expect(imagesOnDisk()).rejects.toMatchObject({ code: "ENOENT" });
		expect(announced).toEqual([]);
	});

	it("报了头像:存进图库,资料里放图库引用", async () => {
		bind();
		bus.emit("subscription-reported", profileReport([A], { name: "甲", avatar: PNG_BYTES }));
		await handle.idle();

		const avatar = subRuntime.get(A)?.cachedProfile?.avatar;
		expect(avatar && isValidImageRef(avatar)).toBe(true);
		expect(avatar).toMatch(/\.png$/);
		const stored = await imageStore.read(avatar ?? "");
		expect(stored?.bytes.equals(PNG_BYTES)).toBe(true);
		expect(subRuntime.get(A)?.cachedProfile).not.toHaveProperty("avatarUrl");
	});

	it("同一张图再报一次:引用不变,面板不被叫;换一张:引用变,面板被叫", async () => {
		bind();
		bus.emit("subscription-reported", profileReport([A], { name: "甲", avatar: PNG_BYTES }));
		await handle.idle();
		await vi.waitFor(() => expect(announced).toEqual([[A]]));
		const first = subRuntime.get(A)?.cachedProfile?.avatar;

		bus.emit("subscription-reported", profileReport([A], { avatar: PNG_BYTES }));
		await handle.idle();
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(subRuntime.get(A)?.cachedProfile?.avatar).toBe(first);
		expect(announced).toEqual([[A]]);

		bus.emit("subscription-reported", profileReport([A], { avatar: JPEG_BYTES }));
		await handle.idle();
		await vi.waitFor(() => expect(announced).toEqual([[A], [A]]));
		expect(subRuntime.get(A)?.cachedProfile?.avatar).not.toBe(first);
		expect(subRuntime.get(A)?.cachedProfile?.avatar).toMatch(/\.jpg$/);
	});

	it("没给头像:沿用旧的引用,而且先续期(抄引用要 keep)", async () => {
		const old = await images.put(PNG_BYTES);
		if (!old.ok) throw new Error(old.message);
		await subRuntime.patch(A, {
			cachedProfile: { name: "旧名字", avatar: old.ref, sign: "", lastRefreshedAt: "t" },
		});
		const keep = vi.fn(images.keep);
		bind({ images: { put: images.put, keep } });
		bus.emit("subscription-reported", profileReport([A], { name: "新名字" }));
		await handle.idle();

		expect(keep).toHaveBeenCalledWith(old.ref);
		expect(subRuntime.get(A)?.cachedProfile).toMatchObject({ name: "新名字", avatar: old.ref });
	});

	it("没给头像、旧的引用指着的图已经不在了:资料里两格都缺,不留悬空的引用", async () => {
		await subRuntime.patch(A, {
			cachedProfile: {
				name: "旧名字",
				avatar: `${"c".repeat(64)}.png`,
				sign: "",
				lastRefreshedAt: "t",
			},
		});
		bind();
		bus.emit("subscription-reported", profileReport([A], { name: "新名字" }));
		await handle.idle();

		const profile = subRuntime.get(A)?.cachedProfile;
		expect(profile?.name).toBe("新名字");
		expect(profile).not.toHaveProperty("avatar");
		expect(profile).not.toHaveProperty("avatarUrl");
		await vi.waitFor(() => expect(announced).toEqual([[A]]));
	});

	it("头像存不下来:名字与粉丝照样更新,头像留着原来那张", async () => {
		const old = await images.put(PNG_BYTES);
		if (!old.ok) throw new Error(old.message);
		await subRuntime.patch(A, {
			cachedProfile: {
				name: "旧名字",
				avatar: old.ref,
				sign: "",
				fans: 1,
				lastRefreshedAt: "2026-09-01T00:00:00.000Z",
			},
		});
		bind({
			images: {
				put: vi.fn(async () => {
					throw new Error("盘满了");
				}),
				keep: images.keep,
			},
		});
		bus.emit("subscription-reported", profileReport([A], { name: "新名字", avatar: JPEG_BYTES }));
		await handle.idle();

		expect(subRuntime.get(A)?.cachedProfile).toMatchObject({
			name: "新名字",
			avatar: old.ref,
			fans: 1,
		});
	});

	it("报来的头像不是头像收的图(gif):名字照样更新,头像留着原来那张", async () => {
		const old = await images.put(PNG_BYTES);
		if (!old.ok) throw new Error(old.message);
		await subRuntime.patch(A, {
			cachedProfile: { name: "旧名字", avatar: old.ref, sign: "", lastRefreshedAt: "t" },
		});
		bind();
		const gif = new Uint8Array(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"));
		bus.emit("subscription-reported", profileReport([A], { name: "新名字", avatar: gif }));
		await handle.idle();

		expect(subRuntime.get(A)?.cachedProfile).toMatchObject({ name: "新名字", avatar: old.ref });
		expect(await imagesOnDisk()).toEqual([old.ref]);
	});

	it("别的种类的上报不碰资料", async () => {
		bind();
		bus.emit("subscription-reported", {
			...profileReport([A], {}),
			report: { kind: "liveStatus", value: { live: true } },
		});
		await handle.idle();
		expect(subRuntime.get(A)).toBeUndefined();
	});
});

describe("bindReportedProfiles.close", () => {
	beforeEach(() => storageWriteGate.reset());
	afterEach(() => storageWriteGate.reset());

	const runtimeFile = () => join(dataDir, ...SUB_RUNTIME_FILE);

	it("close 等在途的资料落盘(dispose 只摘监听、置标记,不等队列)", async () => {
		bind();
		storageWriteGate.hold();
		bus.emit("subscription-reported", profileReport([A], { name: "甲" }));
		await storageWriteGate.arrived();
		// 关停的 stop 段:摘监听、置标记,在途的那一条照样落。
		handle.dispose();

		let closed = false;
		const closing = handle.close().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(closed).toBe(false);

		storageWriteGate.release();
		await closing;
		const onDisk = JSON.parse(await readFile(runtimeFile(), "utf8")) as Record<string, unknown>;
		expect(onDisk[A]).toMatchObject({ cachedProfile: { name: "甲" } });
	});

	it("close 之后再来的资料不处理、不碰盘", async () => {
		bind();
		bus.emit("subscription-reported", profileReport([A], { name: "甲" }));
		await handle.idle();
		const before = await readFile(runtimeFile(), "utf8");
		await handle.close();
		const writesAtClose = storageWriteGate.writes;

		bus.emit("subscription-reported", profileReport([A], { name: "乙", avatar: PNG_BYTES }));
		await handle.idle();

		expect(storageWriteGate.writes).toBe(writesAtClose);
		expect(await readFile(runtimeFile(), "utf8")).toBe(before);
		await expect(imagesOnDisk()).rejects.toMatchObject({ code: "ENOENT" });
	});
});
