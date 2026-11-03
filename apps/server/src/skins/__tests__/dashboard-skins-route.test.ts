/**
 * 皮肤库 API:上传(multipart zip)/列表/启用/删除/资产 serve。
 * 资产路径穿越与白名单由 store 层兜底,这里验 wire 行为与状态码。
 *
 * 失败只有一种形状(ADR-0026):`{ code, message, issues? }`。一句话的原因只有 `message`;
 * 一串检查意见(装包门、manifest 校验)`message` 一句概括、逐条进 `issues`。码由皮肤库的
 * `SkinStoreError` 自带(没这套 `not_found`、没有那个模式 `invalid`、最后一套模式 / 份数满了 `conflict`)。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDashboardSkinsRoute } from "../../routes/dashboard-skins.js";
import { respondFailure, routeNotFoundMessage } from "../../routes/respond-failure.js";
import { MAX_SKIN_ASSETS, SkinStore } from "../store.js";

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
	// 与生产一样带全局的 notFound:路径压根匹不上路由时(如 `/:id/modes/` 少了 theme)回的是
	// 标准的 `not_found` 错误体,不是 Hono 默认的纯文本 —— 否则这条测试自己造的 404 会被错误体守卫点名。
	app = new Hono()
		.notFound((c) => respondFailure(c, fail("not_found", routeNotFoundMessage())))
		.route("/", createDashboardSkinsRoute({ skinStore: store }));
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

	it("POST / 非法包 → invalid(400),原因就是 message", async () => {
		const bad = new File([Buffer.from(strToU8("not a zip"))], "x.zip");
		const res = await upload(app, bad);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("zip");
		expect(body).not.toHaveProperty("ok");
		expect(body).not.toHaveProperty("errors");
	});

	it("POST / 没带文件 → invalid(400)", async () => {
		const res = await app.request("/", { method: "POST", body: new FormData() });
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).code).toBe("invalid");
	});

	it("PUT /active 单槽:纯暗皮肤放不进亮槽 → invalid(400),码由皮肤库自带、不靠嗅文案", async () => {
		const made = await upload(app, makeZipFile(false, { dark: { colors: { accent: "#00e5ff" } } }));
		const id = ((await made.json()) as any).id as string;
		const res = await putActive(app, { id, theme: "light" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("light");
		// 槽没动。
		const list = (await (await app.request("/")).json()) as any;
		expect(list.active).toEqual({ light: null, dark: null });
	});

	it("PUT /active 参数不对 → invalid(400),原因就是 message", async () => {
		const badId = await putActive(app, { id: 5 });
		expect(badId.status).toBe(400);
		expect(await badId.json()).toEqual({ code: "invalid", message: "id 必须是皮肤 id 或 null" });
		const badTheme = await putActive(app, { id: null, theme: "blue" });
		expect(badTheme.status).toBe(400);
		expect(((await badTheme.json()) as any).message).toContain("light 或 dark");
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

describe("POST /:id/assets(编辑器里传图)", () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);

	async function postAsset(id: string, file: File): Promise<Response> {
		const form = new FormData();
		form.set("file", file);
		return app.request(`/${id}/assets`, { method: "POST", body: form });
	}

	it("传一张 png → 201 带包内名字,manifest 接口那边也看得到", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const res = await postAsset(
			id,
			new File([Buffer.from(PNG)], "壁纸 (1).png", { type: "image/png" }),
		);

		expect(res.status).toBe(201);
		const body = (await res.json()) as any;
		expect(body.name).toMatch(/^assets\/[A-Za-z0-9._-]+\.png$/);
		const manifest = (await (await app.request(`/${id}/manifest`)).json()) as any;
		expect(manifest.assets).toContain(body.name);
	});

	it("不是图片 → 400,别把随便什么字节都收进皮肤包", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const res = await postAsset(
			id,
			new File([Buffer.from("x")], "x.svg", { type: "image/svg+xml" }),
		);

		expect(res.status).toBe(400);
	});

	it("传一款字体 → 201;**后缀取自文件名,不看 mime**", async () => {
		// 卡片字体那边踩过并写进注释的那条:同一个 .ttf,各家浏览器给的可能是
		// font/ttf、application/x-font-ttf、application/octet-stream、甚至空串。
		// 照 mime 判会把一堆正常字体拒在门外 —— 这里用最刁的那个空串来钉住。
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const res = await postAsset(
			id,
			new File([Buffer.from(WOFF2)], "霞鹜文楷 Light.woff2", { type: "" }),
		);

		expect(res.status).toBe(201);
		const body = (await res.json()) as any;
		expect(body.name).toMatch(/^assets\/font-[A-Za-z0-9]+\.woff2$/);
		const manifest = (await (await app.request(`/${id}/manifest`)).json()) as any;
		expect(manifest.assets).toContain(body.name);
	});

	it("字体回读带对的 content-type —— 浏览器靠它决定认不认这份字体", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const { name } = (await (
			await postAsset(id, new File([Buffer.from(WOFF2)], "f.woff2", { type: "" }))
		).json()) as any;

		const got = await app.request(`/${id}/${name}`);
		expect(got.status).toBe(200);
		expect(got.headers.get("content-type")).toBe("font/woff2");
	});

	it("既不是图也不是字体 → 400,别把随便什么字节都收进皮肤包", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const res = await postAsset(
			id,
			new File([Buffer.from("MZ")], "payload.exe", { type: "application/octet-stream" }),
		);
		expect(res.status).toBe(400);
	});

	it("皮肤不存在 → 404", async () => {
		const res = await postAsset(
			"nope",
			new File([Buffer.from(PNG)], "a.png", { type: "image/png" }),
		);
		expect(res.status).toBe(404);
		expect(((await res.json()) as any).code).toBe("not_found");
	});

	it("没带文件 → invalid(400)", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const res = await app.request(`/${id}/assets`, { method: "POST", body: new FormData() });
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).code).toBe("invalid");
	});

	it("份数满了 → conflict(409),不是 400:请求没错,是这套皮肤的状态不许", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		for (let i = 0; i < MAX_SKIN_ASSETS; i++) {
			const ok = await postAsset(
				id,
				new File([Buffer.from(PNG)], `a${i}.png`, { type: "image/png" }),
			);
			expect(ok.status).toBe(201);
		}
		const res = await postAsset(
			id,
			new File([Buffer.from(PNG)], "more.png", { type: "image/png" }),
		);
		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.code).toBe("conflict");
		expect(body.message).toContain(String(MAX_SKIN_ASSETS));
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

describe("资产原名(只做显示,盘上仍是生成名)", () => {
	const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);

	it("传上来的文件名记进清单,manifest 接口带回去给下拉当标签", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const form = new FormData();
		form.set("file", new File([Buffer.from(WOFF2)], "霞鹜文楷 Light.woff2", { type: "" }));
		const { name } = (await (
			await app.request(`/${id}/assets`, { method: "POST", body: form })
		).json()) as any;

		const body = (await (await app.request(`/${id}/manifest`)).json()) as any;
		// 盘上的名字仍旧是生成的 —— 原名一个字都没进路径。
		expect(name).toMatch(/^assets\/font-[A-Za-z0-9]+\.woff2$/);
		expect(body.assetNames).toEqual({ [name]: "霞鹜文楷 Light.woff2" });
	});

	it("原名随导出的 zip 走,再装回来还认得出", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const form = new FormData();
		form.set("file", new File([Buffer.from(PNG)], "樱花壁纸.png", { type: "image/png" }));
		const { name } = (await (
			await app.request(`/${id}/assets`, { method: "POST", body: form })
		).json()) as any;

		const zip = await app.request(`/${id}/export`);
		const { unzipSync } = await import("fflate");
		const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
		expect(Object.keys(files)).toContain("assets/index.json");

		const again = await upload(
			app,
			new File([Buffer.from(zipSync(files))], "skin.zip", { type: "application/zip" }),
		);
		expect(again.status).toBe(201);
		const reborn = (await again.json()) as any;
		const back = (await (await app.request(`/${reborn.id}/manifest`)).json()) as any;
		expect(back.assetNames).toEqual({ [name]: "樱花壁纸.png" });
	});

	it("没有原名可记的包 → assetNames 是空表,不是缺字段", async () => {
		const { id } = (await (await upload(app, makeZipFile(true))).json()) as any;
		const body = (await (await app.request(`/${id}/manifest`)).json()) as any;
		expect(body.assetNames).toEqual({});
	});
});

describe("自带字体的整条路(传 → 存 → 导出 → 再装回去)", () => {
	const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);

	/**
	 * 每一段都有自己的单测,但**接缝上断掉的才是这个功能真正的失败形态** ——
	 * 「存进皮肤包」这个决定的全部意义就是导出的 zip 带着字体走;三道白名单闸
	 * (save / listAssets / assetPath)漏掉任何一道,前面的测试照样全绿,而主人
	 * 拿到的包比传进去的少一个文件,装到另一台机器上字就没了。
	 */
	it("字体随导出的 zip 走,且那个 zip 能原样装回来", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const form = new FormData();
		form.set("file", new File([Buffer.from(WOFF2)], "霞鹜文楷.woff2", { type: "" }));
		const { name } = (await (
			await app.request(`/${id}/assets`, { method: "POST", body: form })
		).json()) as any;

		const saved = await app.request(`/${id}/manifest`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				schemaVersion: 1,
				name: "樱花夜",
				modes: { light: { fonts: { asset: name, body: ["霞鹜文楷"] } } },
			}),
		});
		expect(saved.status).toBe(200);

		const zip = await app.request(`/${id}/export`);
		const { unzipSync, strFromU8 } = await import("fflate");
		const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
		// index.json = 原名清单(主人传的时候叫「霞鹜文楷.woff2」),纯显示用。
		expect(Object.keys(files).sort()).toEqual([name, "assets/index.json", "skin.json"].sort());
		expect(new Uint8Array(files[name] as Uint8Array)).toEqual(WOFF2);
		expect(JSON.parse(strFromU8(files["skin.json"] as Uint8Array)).modes.light.fonts).toEqual({
			asset: name,
			body: ["霞鹜文楷"],
		});

		const again = await upload(
			app,
			new File([Buffer.from(zipSync(files))], "skin.zip", { type: "application/zip" }),
		);
		expect(again.status).toBe(201);
		const reborn = (await again.json()) as any;
		const back = (await (await app.request(`/${reborn.id}/manifest`)).json()) as any;
		expect(back.manifest.modes.light.fonts.asset).toBe(name);
		expect(back.assets).toContain(name);
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

	it("校验不过 → invalid(400),原因进 message / issues,盘上原样", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const res = await putManifest(id, {
			schemaVersion: 1,
			name: "坏",
			modes: { light: { colors: { accent: "url(evil)" } } },
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.code).toBe("invalid");
		// 一句话的原因就是 message;一串则 message 概括、逐条进 issues —— 总之原因一条也不丢。
		const reasons = body.issues?.map((i: any) => i.message) ?? [body.message];
		expect(reasons.length).toBeGreaterThan(0);
		expect(reasons.join()).toContain("accent");
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
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("assets/nope.png");
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
		const body = (await bad.json()) as any;
		expect(body).toEqual({ code: "invalid", message: "请求体不是合法的 JSON" });
	});
});

describe("POST /:id/ai(让女仆改,不落盘)", () => {
	function appWithAi(reply: string | null): Hono {
		return new Hono().route(
			"/",
			createDashboardSkinsRoute({
				skinStore: store,
				commentary: () =>
					reply === null ? null : { generateRaw: async (_s: string, _u: string) => reply },
			}),
		);
	}

	async function aiEdit(aiApp: Hono, id: string, body: unknown): Promise<Response> {
		return aiApp.request(`/${id}/ai`, {
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

	it("设计师看得到资产原名 —— 光给一串 hex,它没法「让配色跟这张图搭」", async () => {
		// 提示词那边有单测,这里钉的是**接线**:route 得真把 assetNames 递进去。
		// 少这一根线,提示词的能力就是白写的,而且两边各自全绿。
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const form = new FormData();
		form.set("file", new File([Buffer.from(PNG)], "樱花壁纸.png", { type: "image/png" }));
		const { name } = (await (
			await app.request(`/${id}/assets`, { method: "POST", body: form })
		).json()) as any;

		let seen = "";
		const aiApp = new Hono().route(
			"/",
			createDashboardSkinsRoute({
				skinStore: store,
				commentary: () => ({
					generateRaw: async (sys: string) => {
						seen = sys;
						return JSON.stringify({ schemaVersion: 1, name: "x", modes: { light: {} } });
					},
				}),
			}),
		);
		await aiEdit(aiApp, id, {
			instruction: "改个名",
			draft: { schemaVersion: 1, name: "樱花夜", modes: { light: {} } },
		});
		expect(seen).toContain(`- ${name} —— 原文件名「樱花壁纸.png」`);
	});

	it("模型那头出错 → unavailable(503),对端给的原因写进 message(与卡片皮肤的 `/:id/ai` 同一口径)", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const failing = new Hono().route(
			"/",
			createDashboardSkinsRoute({
				skinStore: store,
				commentary: () => ({
					generateRaw: async () => {
						throw new Error("上游 429:请求太频繁");
					},
				}),
			}),
		);
		const res = await aiEdit(failing, id, { instruction: "改成暗色", draft: { schemaVersion: 1 } });
		expect(res.status).toBe(503);
		const body = (await res.json()) as any;
		expect(body.code).toBe("unavailable");
		expect(body.message).toContain("上游 429:请求太频繁");
	});

	it("AI 未配置(commentary 为 null)→ not_configured(409);皮肤不存在 → not_found;缺 instruction → invalid", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const unconfigured = await aiEdit(appWithAi(null), id, { instruction: "x", draft: {} });
		expect(unconfigured.status).toBe(409);
		expect(((await unconfigured.json()) as any).code).toBe("not_configured");
		const aiApp = appWithAi("{}");
		const missing = await aiEdit(aiApp, "nope", { instruction: "x", draft: {} });
		expect(missing.status).toBe(404);
		expect(((await missing.json()) as any).code).toBe("not_found");
		const empty = await aiEdit(aiApp, id, { instruction: "", draft: {} });
		expect(empty.status).toBe(400);
		expect(((await empty.json()) as any).code).toBe("invalid");
	});

	it("AI 两答都不合法 → invalid(400),概括进 message、逐条意见进 issues(不再是 422 的私有形状)", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const aiApp = appWithAi("不是 JSON");
		const res = await aiEdit(aiApp, id, { instruction: "x", draft: {} });
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("女仆改出来的皮肤没通过检查");
		expect(body.issues.length).toBeGreaterThan(0);
		expect(body.issues[0].message).toContain("JSON");
		expect(body).not.toHaveProperty("errors");
	});
});

describe("出厂快照 API", () => {
	it("GET /:id/default:上传后即返回出厂 manifest;编辑保存不影响快照", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;

		const before = (await (await app.request(`/${id}/default`)).json()) as any;
		expect(before.manifest.name).toBe("樱花夜");

		const edited = { schemaVersion: 1, name: "樱花夜·改", modes: { light: {} } };
		const put = await app.request(`/${id}/manifest`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(edited),
		});
		expect(put.status).toBe(200);

		const after = (await (await app.request(`/${id}/default`)).json()) as any;
		expect(after.manifest.name).toBe("樱花夜");
	});

	it("PUT /:id/default:把当前 manifest 钉成快照", async () => {
		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const edited = { schemaVersion: 1, name: "樱花夜·改", modes: { light: {} } };
		await app.request(`/${id}/manifest`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(edited),
		});

		const pin = await app.request(`/${id}/default`, { method: "PUT" });
		expect(pin.status).toBe(200);
		expect(((await pin.json()) as any).ok).toBe(true);

		const snap = (await (await app.request(`/${id}/default`)).json()) as any;
		expect(snap.manifest.name).toBe("樱花夜·改");
	});

	it("皮肤不存在 → 双端 404;存量皮肤没钉过快照 → GET 404(文案区分)", async () => {
		expect((await app.request("/nope/default")).status).toBe(404);
		expect((await app.request("/nope/default", { method: "PUT" })).status).toBe(404);

		const { id } = (await (await upload(app, makeZipFile())).json()) as any;
		const { rm } = await import("node:fs/promises");
		await rm(join((store as any).skinsDir, id, "default.json"));
		const res = await app.request(`/${id}/default`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.code).toBe("not_found");
		expect(body.message).toContain("默认值");
	});
});

describe("DELETE /:id/modes/:theme —— 只删一色", () => {
	/** 传一套深浅都有的皮肤,返回 id。 */
	async function uploadDual(): Promise<string> {
		const res = await upload(
			app,
			makeZipFile(false, {
				light: { colors: { accent: "#fb7299" } },
				dark: { colors: { accent: "#00e5ff" } },
			}),
		);
		return ((await res.json()) as any).id as string;
	}

	const del = (id: string, theme: string) =>
		app.request(`/${id}/modes/${theme}`, { method: "DELETE" });

	it("删一色 → 200,列表里那套只剩另一色", async () => {
		const id = await uploadDual();
		expect((await del(id, "light")).status).toBe(200);
		const body = (await (await app.request("/")).json()) as any;
		expect(body.list.find((e: any) => e.id === id).modes).toEqual(["dark"]);
	});

	it("那一色正被启用 → 顺手卸下那个槽,另一个槽不动", async () => {
		const id = await uploadDual();
		// PUT /active 收的是 { id, theme? } —— 不带 theme = 整套启用(双槽都占)。
		await putActive(app, { id });
		await del(id, "light");
		const body = (await (await app.request("/")).json()) as any;
		expect(body.active).toEqual({ light: null, dark: id });
	});

	it("最后一套模式 → conflict(409),并指路去「删除」", async () => {
		const id = await uploadDual();
		await del(id, "light");
		const res = await del(id, "dark");
		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.code).toBe("conflict");
		expect(body.message).toContain("删除");
		// 皮肤还在,没被顺手删掉。
		const after = (await (await app.request("/")).json()) as any;
		expect(after.list).toHaveLength(1);
	});

	it("本来就没有那一色 → invalid(400)", async () => {
		const res = await upload(app, makeZipFile());
		const id = ((await res.json()) as any).id as string;
		const gone = await del(id, "dark");
		expect(gone.status).toBe(400);
		const body = (await gone.json()) as any;
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("深色");
	});

	it("theme 不是 light / dark → invalid(400),压根不进 store", async () => {
		const id = await uploadDual();
		for (const bad of ["blue", "LIGHT"]) {
			const res = await del(id, bad);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).code).toBe("invalid");
		}
		// 空的 theme 连路由都匹不上:落到全局的 not_found,同样不进 store。
		expect((await del(id, "")).status).toBe(404);
		// 一色都没少。
		const body = (await (await app.request("/")).json()) as any;
		expect(body.list.find((e: any) => e.id === id).modes).toHaveLength(2);
	});

	it("不认识的 id → 404", async () => {
		const res = await del("nope", "light");
		expect(res.status).toBe(404);
		expect(((await res.json()) as any).code).toBe("not_found");
	});

	it("id 带路径穿越 → 不给 200", async () => {
		// 与 DELETE /:id 同一条纪律:这条路同样要写盘。
		expect((await del("%2e%2e%2fconversations", "light")).status).not.toBe(200);
	});
});
