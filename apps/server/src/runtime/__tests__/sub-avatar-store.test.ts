/**
 * 拓展订阅的头像文件(ADR-0019 决策 49):`<dataDir>/avatars/<订阅 id>.<png|jpeg|webp>`。
 *
 * 建订阅 / 取头像 / 删订阅走的是 `/api/subs` 那几口(见 `routes/__tests__/subs-extension-create.test.ts`);
 * 这里钉路由够不着的三件:
 *  - 开机清扫:订阅已经不在的头像、崩溃时留下的半截临时文件都扫掉,不认得的文件不碰。
 *  - 同一条订阅换了图的类型(png → webp),旧类型的那个文件跟着删掉,读到的是新的。
 *  - 声明的类型与字节对不上 → 拒收,一个字节都不落盘。
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	avatarDataUrl,
	JPEG_BYTES,
	PNG_BYTES,
	WEBP_BYTES,
} from "../../__tests__/support/avatar-fixtures.js";
import { createSubAvatarStore, type SubAvatarStore } from "../sub-avatar-store.js";

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
	store = createSubAvatarStore({ dataDir, logger: makeLogger() });
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
		expect(first).toMatch(new RegExp(`^/api/subs/${KEEP}/avatar\\?v=[0-9a-f]{12}$`));
		expect(second).toMatch(new RegExp(`^/api/subs/${KEEP}/avatar\\?v=[0-9a-f]{12}$`));
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
