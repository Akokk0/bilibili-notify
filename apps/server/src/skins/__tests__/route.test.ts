/**
 * 皮肤库 API:上传(multipart zip)/列表/启用/删除/资产 serve。
 * 资产路径穿越与白名单由 store 层兜底,这里验 wire 行为与状态码。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createSkinsRoute } from "../../routes/skins.js";
import { SkinStore } from "../store.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeZipFile(withWallpaper = false, modes?: Record<string, unknown>): File {
	const manifest = {
		schemaVersion: 1,
		name: "樱花夜",
		modes:
			modes ??
			(withWallpaper
				? { light: { wallpaper: { image: "assets/bg.png" } } }
				: { light: { colors: { accent: "#fb7299" } } }),
	};
	const files: Record<string, Uint8Array> = { "skin.json": strToU8(JSON.stringify(manifest)) };
	if (withWallpaper) files["assets/bg.png"] = PNG;
	return new File([Buffer.from(zipSync(files))], "skin.zip", { type: "application/zip" });
}

async function putActive(app: Hono, body: unknown): Promise<Response> {
	return app.request("/active", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function upload(app: Hono, file: File): Promise<Response> {
	const form = new FormData();
	form.set("file", file);
	return app.request("/", { method: "POST", body: form });
}

let app: Hono;
let store: SkinStore;

beforeEach(async () => {
	store = new SkinStore({ skinsDir: await mkdtemp(join(tmpdir(), "bn-skins-route-")) });
	await store.init();
	app = new Hono().route("/", createSkinsRoute({ skinStore: store }));
});

describe("skins route", () => {
	it("GET / 初始为空:list=[] active 双槽全空", async () => {
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.list).toEqual([]);
		expect(body.active).toEqual({ light: null, dark: null });
	});

	it("POST / 合法 zip → 201 带 id;列表随之出现", async () => {
		const res = await upload(app, makeZipFile());
		expect(res.status).toBe(201);
		const body = (await res.json()) as any;
		expect(body.ok).toBe(true);
		expect(typeof body.id).toBe("string");
		const list = (await (await app.request("/")).json()) as any;
		expect(list.list).toHaveLength(1);
		expect(list.list[0].name).toBe("樱花夜");
	});

	it("POST / 非法包 → 400 带 errors", async () => {
		const bad = new File([Buffer.from(strToU8("not a zip"))], "x.zip");
		const res = await upload(app, bad);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.ok).toBe(false);
		expect(body.errors.length).toBeGreaterThan(0);
	});

	it("PUT /active 整套启用(纯亮→亮槽)与清空;不存在的 id → 404", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const on = await putActive(app, { id });
		expect(on.status).toBe(200);
		expect(((await (await app.request("/")).json()) as any).active).toEqual({
			light: id,
			dark: null,
		});

		const off = await putActive(app, { id: null });
		expect(off.status).toBe(200);
		expect(((await (await app.request("/")).json()) as any).active).toEqual({
			light: null,
			dark: null,
		});

		expect((await putActive(app, { id: "nope" })).status).toBe(404);
	});

	it("PUT /active 带 theme:单槽设置;皮肤没有该模式 → 400", async () => {
		const { id: lightSkin } = (await (await upload(app, makeZipFile())).json()) as any;
		const { id: darkSkin } = (await (
			await upload(app, makeZipFile(false, { dark: { colors: { accent: "#00e5ff" } } }))
		).json()) as any;
		expect((await putActive(app, { theme: "light", id: lightSkin })).status).toBe(200);
		expect((await putActive(app, { theme: "dark", id: darkSkin })).status).toBe(200);
		expect(((await (await app.request("/")).json()) as any).active).toEqual({
			light: lightSkin,
			dark: darkSkin,
		});
		// 纯暗皮肤进不了亮槽
		expect((await putActive(app, { theme: "light", id: darkSkin })).status).toBe(400);
		// 单槽卸下,另一槽不动
		expect((await putActive(app, { theme: "light", id: null })).status).toBe(200);
		expect(((await (await app.request("/")).json()) as any).active).toEqual({
			light: null,
			dark: darkSkin,
		});
	});

	it("GET /active:双槽形状,槽里带 manifest,空槽为 null", async () => {
		expect(((await (await app.request("/active")).json()) as any).active).toEqual({
			light: null,
			dark: null,
		});
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		await putActive(app, { id });
		const body = (await (await app.request("/active")).json()) as any;
		expect(body.active.light.id).toBe(id);
		expect(body.active.light.manifest.name).toBe("樱花夜");
		expect(body.active.dark).toBeNull();
	});

	it("DELETE /:id 删除;占槽的被删 → 该槽归 null", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		await putActive(app, { id });
		const res = await app.request(`/${id}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		const list = (await (await app.request("/")).json()) as any;
		expect(list.list).toEqual([]);
		expect(list.active).toEqual({ light: null, dark: null });
	});

	it("GET /:id/assets/:name serve 壁纸;不存在 → 404", async () => {
		const { id } = (await (await upload(app, makeZipFile(true))).json()) as any;
		const ok = await app.request(`/${id}/assets/bg.png`);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toContain("image/png");
		expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG);

		expect((await app.request(`/${id}/assets/none.png`)).status).toBe(404);
		expect((await app.request(`/${id}/assets/..%2Fskin.json`)).status).toBe(404);
	});
});

describe("GET /:id/manifest(试穿/编辑用)", () => {
	it("存在 → manifest + 包内资产清单;不存在 → 404", async () => {
		const { id } = (await (await upload(app, makeZipFile(true))).json()) as any;
		const ok = await app.request(`/${id}/manifest`);
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as any;
		expect(body.manifest.name).toBe("樱花夜");
		expect(body.assets).toEqual(["assets/bg.png"]);
		expect((await app.request("/nope/manifest")).status).toBe(404);
	});
});

describe("GET /:id/export(导出皮肤包)", () => {
	it("导出 zip:含盘上 skin.json 与全部资产,带 attachment 头;不存在 → 404", async () => {
		const { id } = (await (await upload(app, makeZipFile(true))).json()) as any;
		const res = await app.request(`/${id}/export`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/zip");
		expect(res.headers.get("content-disposition")).toContain("attachment");

		const { unzipSync, strFromU8 } = await import("fflate");
		const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
		expect(Object.keys(files).sort()).toEqual(["assets/bg.png", "skin.json"]);
		const manifest = JSON.parse(strFromU8(files["skin.json"] as Uint8Array));
		expect(manifest.name).toBe("樱花夜");
		expect(new Uint8Array(files["assets/bg.png"] as Uint8Array)).toEqual(PNG);

		expect((await app.request("/nope/export")).status).toBe(404);
	});

	it("导出的 zip 能原样再上传(往返闭环)", async () => {
		const { id } = (await (await upload(app, makeZipFile(true))).json()) as any;
		const res = await app.request(`/${id}/export`);
		const file = new File([Buffer.from(await res.arrayBuffer())], "skin.zip", {
			type: "application/zip",
		});
		const again = await upload(app, file);
		expect(again.status).toBe(201);
		expect(((await again.json()) as any).ok).toBe(true);
	});
});

describe("PUT /:id/manifest(编辑器保存)", () => {
	async function putManifest(id: string, manifest: unknown): Promise<Response> {
		return app.request(`/${id}/manifest`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(manifest),
		});
	}

	it("合法 manifest → 200,后续 GET 读到新值,列表条目同步", async () => {
		const { id } = (await (await upload(app, makeZipFile(true))).json()) as any;
		const res = await putManifest(id, {
			schemaVersion: 1,
			name: "樱花夜·改",
			modes: {
				light: { wallpaper: { image: "assets/bg.png", overlay: 0.3 } },
				dark: { colors: { accent: "#00aeec" } },
			},
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).ok).toBe(true);

		const got = (await (await app.request(`/${id}/manifest`)).json()) as any;
		expect(got.manifest.name).toBe("樱花夜·改");
		expect(got.manifest.modes.light.wallpaper.overlay).toBe(0.3);
		const list = (await (await app.request("/")).json()) as any;
		expect(list.list[0]).toMatchObject({ name: "樱花夜·改", modes: ["light", "dark"] });
	});

	it("校验不过 → 400 带 errors,盘上原样", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const res = await putManifest(id, {
			schemaVersion: 1,
			name: "坏",
			modes: { light: { colors: { accent: "url(evil)" } } },
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).errors.length).toBeGreaterThan(0);
		const got = (await (await app.request(`/${id}/manifest`)).json()) as any;
		expect(got.manifest.name).toBe("樱花夜");
	});

	it("引用包里没有的图 → 400", async () => {
		const { id } = (await (await upload(app, makeZipFile(true))).json()) as any;
		const res = await putManifest(id, {
			schemaVersion: 1,
			name: "樱花夜",
			modes: { light: { wallpaper: { image: "assets/nope.png" } } },
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.errors.join()).toContain("assets/nope.png");
	});

	it("不存在的皮肤 → 404;非 JSON → 400", async () => {
		expect(
			(await putManifest("nope", { schemaVersion: 1, name: "x", modes: { light: {} } })).status,
		).toBe(404);
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const bad = await app.request(`/${id}/manifest`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: "not json",
		});
		expect(bad.status).toBe(400);
	});
});

describe("POST /:id/ai-edit(让女仆改,不落盘)", () => {
	function appWithAi(reply: string | null): Hono {
		return new Hono().route(
			"/",
			createSkinsRoute({
				skinStore: store,
				commentary: () =>
					reply === null ? null : { generateRaw: async (_s: string, _u: string) => reply },
			}),
		);
	}

	async function aiEdit(aiApp: Hono, id: string, body: unknown): Promise<Response> {
		return aiApp.request(`/${id}/ai-edit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("AI 给出合法 manifest → 200 带清洗后的 manifest;盘上原样(不落盘)", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const aiApp = appWithAi(
			JSON.stringify({ schemaVersion: 1, name: "AI 改名", modes: { light: {} } }),
		);
		const res = await aiEdit(aiApp, id, {
			instruction: "改个名",
			draft: { schemaVersion: 1, name: "樱花夜", modes: { light: {} } },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.ok).toBe(true);
		expect(body.manifest.name).toBe("AI 改名");
		// 盘上没动
		const got = (await (await app.request(`/${id}/manifest`)).json()) as any;
		expect(got.manifest.name).toBe("樱花夜");
	});

	it("AI 未配置(commentary 为 null)→ 503;皮肤不存在 → 404;缺 instruction → 400", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		expect((await aiEdit(appWithAi(null), id, { instruction: "x", draft: {} })).status).toBe(503);
		const aiApp = appWithAi("{}");
		expect((await aiEdit(aiApp, "nope", { instruction: "x", draft: {} })).status).toBe(404);
		expect((await aiEdit(aiApp, id, { instruction: "", draft: {} })).status).toBe(400);
	});

	it("AI 两答都不合法 → 422 带 errors", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const aiApp = appWithAi("不是 JSON");
		const res = await aiEdit(aiApp, id, { instruction: "x", draft: {} });
		expect(res.status).toBe(422);
		expect(((await res.json()) as any).errors.length).toBeGreaterThan(0);
	});
});
