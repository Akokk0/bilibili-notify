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

function makeZipFile(withWallpaper = false): File {
	const manifest = {
		schemaVersion: 1,
		name: "樱花夜",
		modes: withWallpaper
			? { light: { wallpaper: { image: "assets/bg.png" } } }
			: { light: { colors: { accent: "#fb7299" } } },
	};
	const files: Record<string, Uint8Array> = { "skin.json": strToU8(JSON.stringify(manifest)) };
	if (withWallpaper) files["assets/bg.png"] = PNG;
	return new File([Buffer.from(zipSync(files))], "skin.zip", { type: "application/zip" });
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
	it("GET / 初始为空:list=[] activeId=null", async () => {
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.list).toEqual([]);
		expect(body.activeId).toBeNull();
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

	it("PUT /active 启用与取消;不存在的 id → 404", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const on = await app.request("/active", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
		expect(on.status).toBe(200);
		expect(((await (await app.request("/")).json()) as any).activeId as string).toBe(id);

		const off = await app.request("/active", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: null }),
		});
		expect(off.status).toBe(200);
		expect(((await (await app.request("/")).json()) as any).activeId as unknown).toBeNull();

		const missing = await app.request("/active", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "nope" }),
		});
		expect(missing.status).toBe(404);
	});

	it("GET /active:未启用 → {active:null};启用后带 manifest", async () => {
		expect(((await (await app.request("/active")).json()) as any).active as unknown).toBeNull();
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		await app.request("/active", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
		const body = (await (await app.request("/active")).json()) as any;
		expect(body.active.id).toBe(id);
		expect(body.active.manifest.name).toBe("樱花夜");
	});

	it("DELETE /:id 删除;删的是 active → activeId 归 null", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		await app.request("/active", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
		const res = await app.request(`/${id}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		const list = (await (await app.request("/")).json()) as any;
		expect(list.list).toEqual([]);
		expect(list.activeId).toBeNull();
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
