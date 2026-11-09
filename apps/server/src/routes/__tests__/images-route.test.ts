/**
 * 图库读口 `GET /api/images/<ref>`(ADR-0036 决策 5 下 10-03 的 🔗):只读;mime 按扩展名;按内容起名的东西
 * 永远不变,所以 `immutable`;引用不合规矩(不碰盘)或文件不在都回 404。接线(真挂上、在两道闸后面)由
 * `routes-by-resource-mount.test.ts` 起整个 app 钉着。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { createImageStore, type ImageStore } from "../../images/image-store.js";
import { createImagesRoute } from "../images.js";
import type { RouteDeps } from "../types.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_SHA256 = "4353a1de7e0dcc4e87350e22d5c9ee9f3e70e8ce9c31533ec991bee8870c4814";
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

let dir: string;
let app: Hono;
let imageStore: ImageStore;
let registered = 0;

beforeEach(async () => {
	i18n.set({ locale: "zh-CN", voice: "maid" });
	dir = await mkdtemp(join(tmpdir(), "bn-images-route-"));
	imageStore = createImageStore({ dir });
	const deps = { runtime: { imageStore } } as unknown as RouteDeps;
	app = new Hono();
	app.route("/api/images", createImagesRoute(deps));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function putOk(bytes: Uint8Array): Promise<string> {
	const result = await imageStore
		.register({ name: `测试-${++registered}`, listRefs: async () => [] })
		.put(bytes);
	if (!result.ok) throw new Error(result.message);
	return result.ref;
}

describe("GET /api/images/:ref", () => {
	it.each([
		["en", "This image was not found in the library."],
		["ja", "この画像は画像ライブラリにありません。"],
		["zh-TW", "圖片庫中找不到此圖片。"],
	] as const)(
		"%s localizes missing and invalid refs while preserving successful binary responses",
		async (locale, message) => {
			i18n.set({ locale, voice: "plain" });
			for (const ref of ["invalid.png", `${PNG_SHA256}.png`]) {
				const res = await app.request(`/api/images/${ref}`);
				expect(res.status).toBe(404);
				expect(await res.json()).toEqual({ code: "not_found", message });
			}
			const ref = await putOk(PNG);
			const res = await app.request(`/api/images/${ref}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("image/png");
			expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
			expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
		},
	);
	it("200:字节原样,Content-Type 按扩展名,缓存一年且 immutable", async () => {
		const ref = await putOk(PNG);
		const res = await app.request(`/api/images/${ref}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
	});

	it("JPEG 回 image/jpeg", async () => {
		const ref = await putOk(JPEG);
		const res = await app.request(`/api/images/${ref}`);
		expect(res.headers.get("content-type")).toBe("image/jpeg");
	});

	it.each([
		["主名不是 64 位", "abc.png"],
		["不收的扩展名", `${PNG_SHA256}.jpeg`],
		["大写 hex", `${PNG_SHA256.toUpperCase()}.png`],
		["编码过的路径穿越", "..%2F..%2Fsecrets%2Fmaster.key"],
	])("引用不合规矩(%s)回 404", async (_label, ref) => {
		await putOk(PNG);
		const res = await app.request(`/api/images/${ref}`);
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: "not_found" });
	});

	it("引用合规矩、文件不在,回 404", async () => {
		const res = await app.request(`/api/images/${PNG_SHA256}.png`);
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: "not_found" });
	});

	it("只读:写不进来", async () => {
		const ref = await putOk(PNG);
		for (const method of ["POST", "PUT", "DELETE"]) {
			const res = await app.request(`/api/images/${ref}`, { method });
			expect(res.status, method).toBe(404);
		}
		expect((await imageStore.read(ref))?.bytes).toBeDefined();
	});
});
