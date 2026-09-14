/**
 * `/api/card-skins` 的 wire 测试(ADR-0014 决策 2 / 5 / 17)。
 *
 * 这一层自己要钉住的只有四件(验 / 洗 / 落盘归 store 与 package,那边各有自己的测试):
 *
 * ① **`:id` 进不了磁盘路径**:每条带 `:id` 的路先过 `CardSkinIdSchema`,大小写 / 点 / 斜杠
 *    一律 400 —— dashboard 皮肤那次审计(2026-08-19)`DELETE /%2e%2e%2f…` 删掉过整个目录。
 * ② **内置那份改不了删不了**(决策 5),而且报的是 400 不是 404:它明明列得出来。
 * ③ **还有人在用就不许删**(409,并说清是谁)。删掉正在用的那套,出图会静默回落默认皮肤,
 *    主人看到的只是「皮肤突然没了」。
 * ④ **启用指针写的是配置**,不是店里的某个文件 —— `PUT /active` 落到 `patchGlobals`。
 *
 * 全程在 `mkdtemp` 的临时目录里跑,一个字节都不碰真实 dataDir。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardSkinFallback } from "@bilibili-notify/contract";
import { DEFAULT_CARD_SKIN_ID } from "@bilibili-notify/internal";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CARD_SKIN_MANIFEST_FILE } from "../../card-skins/package.js";
import { CardSkinStore } from "../../card-skins/store.js";
import type { ConfigStore } from "../../config/store.js";
import { createCardSkinsRoute } from "../card-skins.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function manifest(extra?: Record<string, unknown>): Record<string, unknown> {
	return {
		schemaVersion: 1,
		dataVersion: 1,
		name: "测试卡片皮肤",
		cards: {
			live: {
				width: 600,
				blocks: [
					{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
				],
			},
		},
		...extra,
	};
}

function pack(
	m: Record<string, unknown> = manifest(),
	assets: Record<string, Uint8Array> = {},
): Uint8Array {
	return zipSync({ [CARD_SKIN_MANIFEST_FILE]: strToU8(JSON.stringify(m)), ...assets });
}

interface SubStub {
	uid: string;
	name?: string;
	cardSkin?: string;
}

let dir: string;
let store: CardSkinStore;
let app: ReturnType<typeof createCardSkinsRoute>;
let patchGlobals: ReturnType<typeof vi.fn>;
/** 面板上「全局在用哪套」的活值 —— patchGlobals 写它,GET / 读它。 */
let active: string;
/** 各套皮肤拧过的旋钮,按皮肤 id 分层(globals.defaults.cardSkinKnobs 的活值)。 */
let knobs: Record<string, Record<string, unknown>>;
let subs: SubStub[];
/** 出图回落的账本(真实的那一份由 index.ts 建,这里直接摆一份现成的)。 */
let fallbacks: CardSkinFallback[];

function mount(): void {
	patchGlobals = vi.fn(async (patch: any) => {
		if (patch.defaults.cardSkin !== undefined) active = patch.defaults.cardSkin;
		for (const [id, ov] of Object.entries(patch.defaults.cardSkinKnobs ?? {})) {
			knobs[id] = ov as Record<string, unknown>;
		}
	});
	const config = {
		getGlobals: () => ({ defaults: { cardSkin: active, cardSkinKnobs: knobs } }),
		getSubscriptions: () =>
			subs.map((s) => ({
				uid: s.uid,
				...(s.name === undefined ? {} : { name: s.name }),
				overrides: s.cardSkin === undefined ? {} : { cardSkin: s.cardSkin },
			})),
		patchGlobals,
	} as unknown as ConfigStore;
	app = createCardSkinsRoute({
		store,
		config,
		fallbacks: () => fallbacks,
		clearFallbacks: () => {
			fallbacks = [];
		},
	});
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-card-skin-route-"));
	store = new CardSkinStore({ dir });
	active = DEFAULT_CARD_SKIN_ID;
	knobs = {};
	subs = [];
	fallbacks = [];
	mount();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 装一套皮肤进去,回它的 id(走的就是路由自己那条路)。 */
async function install(
	m: Record<string, unknown> = manifest(),
	assets?: Record<string, Uint8Array>,
) {
	const form = new FormData();
	form.append("file", new File([pack(m, assets ?? {})], "skin.zip", { type: "application/zip" }));
	const res = await app.request("/", { method: "POST", body: form });
	expect(res.status).toBe(201);
	return ((await res.json()) as any).id as string;
}

describe("GET / —— 皮肤库列表", () => {
	it("内置那份在首位且标着 builtin;active 跟着配置走", async () => {
		const id = await install();
		active = id;
		const body = (await (await app.request("/")).json()) as any;
		expect(body.skins[0]).toMatchObject({ id: DEFAULT_CARD_SKIN_ID, builtin: true, name: "默认" });
		expect(body.skins.map((s: any) => s.id)).toContain(id);
		expect(body.skins.find((s: any) => s.id === id).builtin).toBe(false);
		expect(body.active).toBe(id);
	});

	// ADR-0014 决策 19:出图回落必须**可见**。仓里没有现成的面板告警通道,所以它随皮肤库
	// 列表一起下发 —— 掉了这一口,用户换的皮肤没生效而面板上一个字都不说。
	it("出图回落过的记录跟着列表一起下发", async () => {
		expect(((await (await app.request("/")).json()) as any).fallbacks).toEqual([]);

		fallbacks = [
			{ skinId: "k1abc-deadbeef", kind: "live", reason: "渲染失败(boom)", at: 1700, count: 3 },
		];
		// 验红:把路由里那句 `fallbacks: deps.fallbacks?.() ?? []` 删掉,这条红。
		expect(((await (await app.request("/")).json()) as any).fallbacks).toEqual(fallbacks);
	});
});

describe("GET /:id —— 清单", () => {
	it("内置那份拿得到,资产清单是空的", async () => {
		const res = await app.request(`/${DEFAULT_CARD_SKIN_ID}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.manifest.name).toBe("默认");
		expect(body.assets).toEqual([]);
	});

	it("没这套 → 404;id 形状不对 → 400(两种失败分得开)", async () => {
		expect((await app.request("/nope-1234")).status).toBe(404);
		// 大写字母不在 `CardSkinIdSchema` 的字符集里 —— 门口这一道拦下,不到 store。
		expect((await app.request("/NOPE")).status).toBe(400);
	});
});

describe("POST / —— 装包", () => {
	it("装得进去,回 id 与 warnings", async () => {
		const form = new FormData();
		form.append("file", new File([pack()], "skin.zip", { type: "application/zip" }));
		const res = await app.request("/", { method: "POST", body: form });
		expect(res.status).toBe(201);
		const body = (await res.json()) as any;
		expect(typeof body.id).toBe("string");
		expect(body.warnings).toEqual([]);
		expect(store.get(body.id)?.name).toBe("测试卡片皮肤");
	});

	it("形状不对的包 → 400,并把逐条原因带出来", async () => {
		const form = new FormData();
		form.append(
			"file",
			new File([pack({ schemaVersion: 1 })], "skin.zip", { type: "application/zip" }),
		);
		const res = await app.request("/", { method: "POST", body: form });
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.ok).toBe(false);
		expect(body.errors.length).toBeGreaterThan(0);
	});

	it("没带文件 → 400", async () => {
		const res = await app.request("/", { method: "POST", body: new FormData() });
		expect(res.status).toBe(400);
	});
});

describe("POST /:id/duplicate —— 复制一份", () => {
	it("复制内置那份就是「要改先复制」的入口,名字可以自己起", async () => {
		const res = await app.request(`/${DEFAULT_CARD_SKIN_ID}/duplicate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "我的皮肤" }),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as any;
		expect(id).not.toBe(DEFAULT_CARD_SKIN_ID);
		expect(store.get(id)?.name).toBe("我的皮肤");
	});

	it("没这套 → 404", async () => {
		const res = await app.request("/nope-1234/duplicate", { method: "POST" });
		expect(res.status).toBe(404);
	});

	/**
	 * 2026-09-14 主人拍板:复制**连我拧好的设置一起**带走。旋钮覆盖按皮肤 id 存,副本是
	 * 新 id —— 不抄一份的话「复制一份再改」会先把人拧好的配色清零,等于让他重拧一遍。
	 */
	it("原皮肤拧过的旋钮跟着复制走,原来那套一个键都不动", async () => {
		knobs[DEFAULT_CARD_SKIN_ID] = { "gradient-start": "#ff0000" };
		const res = await app.request(`/${DEFAULT_CARD_SKIN_ID}/duplicate`, { method: "POST" });
		const { id } = (await res.json()) as any;

		expect(knobs[id]).toEqual({ "gradient-start": "#ff0000" });
		expect(knobs[DEFAULT_CARD_SKIN_ID]).toEqual({ "gradient-start": "#ff0000" });
		// 抄的是一份拷贝,不是同一个对象 —— 否则往后拧副本会连着改原皮肤。
		expect(knobs[id]).not.toBe(knobs[DEFAULT_CARD_SKIN_ID]);
	});

	it("原皮肤没拧过 → 不白写一层空覆盖", async () => {
		const res = await app.request(`/${DEFAULT_CARD_SKIN_ID}/duplicate`, { method: "POST" });
		const { id } = (await res.json()) as any;

		expect(knobs[id]).toBeUndefined();
		expect(patchGlobals).not.toHaveBeenCalled();
	});
});

describe("DELETE /fallbacks —— 面板上那句「知道了」", () => {
	/**
	 * 路由注册顺序要紧:`/fallbacks` 得排在 `/:id` 前面,否则它会被当成一个皮肤 id
	 * (而且 `CardSkinIdSchema` 认不出它,主人点「知道了」收到的是一句「id 不合法」)。
	 */
	it("清空账本,列表那一趟跟着变空", async () => {
		fallbacks = [{ skinId: "x", kind: "live", reason: "渲染失败", at: 1, count: 2 }];
		const res = await app.request("/fallbacks", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(((await (await app.request("/")).json()) as any).fallbacks).toEqual([]);
	});

	it("没接账本时也不炸 —— 宿主可以不给这一口", async () => {
		const bare = createCardSkinsRoute({
			store,
			config: {
				getGlobals: () => ({ defaults: { cardSkin: DEFAULT_CARD_SKIN_ID, cardSkinKnobs: {} } }),
				getSubscriptions: () => [],
			} as unknown as ConfigStore,
		});
		expect((await bare.request("/fallbacks", { method: "DELETE" })).status).toBe(200);
	});
});

describe("DELETE /:id —— 删一套", () => {
	it("删得掉,盘上也没了", async () => {
		const id = await install();
		const res = await app.request(`/${id}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(store.has(id)).toBe(false);
	});

	it("内置那份删不掉 —— 400 而不是 404(它明明列得出来)", async () => {
		const res = await app.request(`/${DEFAULT_CARD_SKIN_ID}`, { method: "DELETE" });
		expect(res.status).toBe(400);
		expect(store.has(DEFAULT_CARD_SKIN_ID)).toBe(true);
	});

	it("全局正用着它 → 409,并说清是全局在用", async () => {
		const id = await install();
		active = id;
		const res = await app.request(`/${id}`, { method: "DELETE" });
		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.usedBy).toEqual({ global: true, subscriptions: [] });
		expect(store.has(id)).toBe(true);
	});

	it("某个 UP 单独指着它 → 409,并把这个 UP 的名字列出来", async () => {
		const id = await install();
		subs = [
			{ uid: "111", name: "阿夸" },
			{ uid: "222", name: "小白", cardSkin: id },
		];
		const res = await app.request(`/${id}`, { method: "DELETE" });
		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.usedBy).toEqual({ global: false, subscriptions: ["小白"] });
		expect(body.err).toContain("小白");
		expect(store.has(id)).toBe(true);
	});

	it("没填昵称的 UP 用 uid 顶上 —— 主人得认得出是哪一个", async () => {
		const id = await install();
		subs = [{ uid: "333", cardSkin: id }];
		const body = (await (await app.request(`/${id}`, { method: "DELETE" })).json()) as any;
		expect(body.usedBy.subscriptions).toEqual(["333"]);
	});

	it("没这套 → 404", async () => {
		expect((await app.request("/nope-1234", { method: "DELETE" })).status).toBe(404);
	});
});

describe("GET /:id/export —— 导出", () => {
	it("导出的包能原样装回来(往返闭环),文件名经过转义", async () => {
		const id = await install(manifest({ name: 'a"b;c' }));
		const res = await app.request(`/${id}/export`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/zip");
		// 引号 / 分号整段 percent-encode 过,越不出 `filename*` 这个字段。
		const cd = res.headers.get("content-disposition") ?? "";
		expect(cd).toBe("attachment; filename*=UTF-8''a%22b%3Bc.zip");

		const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
		const back = JSON.parse(new TextDecoder().decode(zip[CARD_SKIN_MANIFEST_FILE]));
		expect(back.name).toBe('a"b;c');
	});

	it("没这套 → 404", async () => {
		expect((await app.request("/nope-1234/export")).status).toBe(404);
	});
});

describe("PUT /:id —— 编辑器保存", () => {
	it("存得下,回 warnings", async () => {
		const id = await install();
		const res = await app.request(`/${id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(manifest({ name: "改过名" })),
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as any).toEqual({ warnings: [] });
		expect(store.get(id)?.name).toBe("改过名");
	});

	it("内置那份存不了 → 400", async () => {
		const res = await app.request(`/${DEFAULT_CARD_SKIN_ID}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(manifest()),
		});
		expect(res.status).toBe(400);
	});

	it("形状不对 → 400 并逐条带原因", async () => {
		const id = await install();
		const res = await app.request(`/${id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ schemaVersion: 1 }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).errors.length).toBeGreaterThan(0);
		// 没存进去 —— 盘上还是装包时那份。
		expect(store.get(id)?.name).toBe("测试卡片皮肤");
	});
});

describe("GET /:id/assets/:name —— 资产回读", () => {
	it("读得到字节,content-type 按后缀给", async () => {
		const id = await install(manifest(), { "assets/bg.png": PNG });
		const res = await app.request(`/${id}/assets/bg.png`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
	});

	it("名字不在包里 → 404", async () => {
		const id = await install();
		expect((await app.request(`/${id}/assets/bg.png`)).status).toBe(404);
	});
});

describe("PUT /active —— 全局换皮肤", () => {
	it("落到 patchGlobals,不在店里另存一份", async () => {
		const id = await install();
		const res = await app.request("/active", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
		expect(res.status).toBe(200);
		expect(patchGlobals).toHaveBeenCalledWith({ defaults: { cardSkin: id } });
		expect(active).toBe(id);
	});

	it("换回内置那份也行", async () => {
		// 先离开默认 —— 起点就是默认的话,这条断言不管实现怎么坏都是绿的。
		active = await install();
		const res = await app.request("/active", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: DEFAULT_CARD_SKIN_ID }),
		});
		expect(res.status).toBe(200);
		expect(active).toBe(DEFAULT_CARD_SKIN_ID);
	});

	it("不存在的 id → 404,配置一个字节都不动", async () => {
		const res = await app.request("/active", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "nope-1234" }),
		});
		expect(res.status).toBe(404);
		expect(patchGlobals).not.toHaveBeenCalled();
	});

	it("id 不是文本 / 形状不对 → 400", async () => {
		const bad = async (body: unknown) =>
			(
				await app.request("/active", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				})
			).status;
		expect(await bad({})).toBe(400);
		expect(await bad({ id: 7 })).toBe(400);
		expect(await bad({ id: "NOPE" })).toBe(400);
		expect(patchGlobals).not.toHaveBeenCalled();
	});
});
