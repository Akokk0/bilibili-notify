import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { CARD_BG_DIR, listCardBg, saveCardBg } from "../../runtime/card-assets.js";
import { bilibiliLikeSources } from "../../subscriptions/__tests__/fixtures.js";
import { createLibraryRoute } from "../library.js";
import { respondFailure, unhandledErrorMessage } from "../respond-failure.js";
import type { RouteDeps } from "../types.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function depsWithDataDir(dataDir: string): RouteDeps {
	return {
		runtime: { sourceRegistry: bilibiliLikeSources(), dataRoot: dataDir },
		store: {
			getGlobals: () => ({ defaults: { cardSkin: "default", cardSkinKnobs: {} } }),
			getSubscriptions: () => [],
		},
	} as unknown as RouteDeps;
}
// Preserve the existing fixture call shape while the production route only takes RouteDeps.
function route({ deps }: { deps: RouteDeps; puppeteer: null }) {
	return createLibraryRoute(deps);
}
describe("library route — 图廊列表 GET /images", () => {
	it("返回图廊里所有已传背景图 id", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-gallery-"));
		try {
			const id1 = await saveCardBg(dir, PNG, "image/png");
			const id2 = await saveCardBg(dir, PNG, "image/webp");
			const app = route({ deps: depsWithDataDir(dir), puppeteer: null });
			const res = await app.request("/images");
			expect(res.status).toBe(200);
			const json = (await res.json()) as { ok: boolean; ids: string[] };
			expect(json.ok).toBe(true);
			expect(new Set(json.ids)).toEqual(new Set([id1, id2]));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("library route — 图廊删除 DELETE /images/:id", () => {
	function depsWithStore(opts: {
		dataDir: string;
		/** 全局直播封面列表(`cards.liveCoverImageIds`)—— 验证删除引用检查覆盖封面引用。 */
		globalCover?: string[];
		/** 皮肤旋钮那一层(2026-09-14 起背景图的正主)。 */
		knobs?: Record<string, Record<string, unknown>>;
		subs?: Array<
			{
				cover?: string[];
				/** 这位 UP 自己那层旋钮覆盖(ADR-0014 决策 17 的 🔗)。 */
				knobs?: Record<string, Record<string, unknown>>;
			} & ({ uid: string } | { kind: "extension"; externalId: string })
		>;
	}): RouteDeps {
		return {
			runtime: {
				// 删前查引用按在册来源给订阅起称呼(身份标签):B 站这份是「B 站 · uid」,不在册的(douyin)退到来源键。
				sourceRegistry: bilibiliLikeSources(),
				dataRoot: opts.dataDir,
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
			},
			store: {
				getGlobals: () => ({
					defaults: {
						cardSkin: "default",
						cardSkinKnobs: opts.knobs ?? {},
						cards: { enabled: true, liveCoverImageIds: opts.globalCover ?? [] },
					},
				}),
				getSubscriptions: () =>
					(opts.subs ?? []).map((s) => ({
						...("uid" in s
							? { identity: { sourceKey: "bilibili", externalId: s.uid } }
							: { identity: { sourceKey: "douyin", externalId: s.externalId } }),
						overrides: {
							cards: s.cover ? { liveCoverImageIds: s.cover } : undefined,
							cardSkinKnobs: s.knobs,
						},
					})),
			},
		} as unknown as RouteDeps;
	}

	it("删除未被引用的背景图 → 200,文件移除", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-route-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = route({
				deps: depsWithStore({ dataDir: dir }),
				puppeteer: null,
			});
			const res = await app.request(`/images/${id}`, { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true });
			expect(await listCardBg(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除仅被全局直播封面(cards.liveCoverImageIds)引用的图 → 409 拦截", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-cover-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = route({
				deps: depsWithStore({ dataDir: dir, globalCover: [id] }),
				puppeteer: null,
			});
			const res = await app.request(`/images/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			expect(await listCardBg(dir)).toEqual([id]); // 仍在盘上
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除被某 UP 的直播封面引用的图 → conflict(409),message 指出该 UP", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-cover-up-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = route({
				deps: depsWithStore({ dataDir: dir, subs: [{ uid: "30303", cover: [id] }] }),
				puppeteer: null,
			});
			const res = await app.request(`/images/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json.code).toBe("conflict");
			expect(json.message).toContain("B 站 · 30303");
			// 用家并进了 message,不再另占一格。
			expect(json).not.toHaveProperty("referencedBy");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除被**皮肤旋钮**引用的背景图 → conflict(409),message 指出是哪套皮肤", async () => {
		// 2026-09-14 起壁纸的正主是旋钮。漏掉这一处是静默的:删得掉、请求成功,皮肤清单里
		// 留着一个指向空气的 id,出图静静回落渐变。
		const dir = await mkdtemp(join(tmpdir(), "bn-del-knob-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = route({
				deps: depsWithStore({ dataDir: dir, knobs: { neon: { wallpaper: [id] } } }),
				puppeteer: null,
			});
			const res = await app.request(`/images/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { code: string; message: string };
			expect(json.code).toBe("conflict");
			expect(json.message).toContain("皮肤「neon」");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	/**
	 * per-UP 那层旋钮(ADR-0014 决策 17 的 🔗)里的壁纸同样是一条引用 —— 漏看它就是上面那条的
	 * per-UP 版:删得掉、请求成功,这位 UP 的卡静静回落兜底。两支订阅都算。
	 * 验红:把 `cardBgReferences` 里扫订阅旋钮那一段删掉,这条红。
	 */
	it("删除被某 UP 单独拧的**皮肤旋钮**引用的背景图 → conflict(409),message 指出该 UP 与皮肤", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-up-knob-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = route({
				deps: depsWithStore({
					dataDir: dir,
					subs: [
						{ uid: "10086", knobs: { neon: { wallpaper: [id] } } },
						{
							kind: "extension",
							externalId: "sec-1",
							knobs: { neon: { wallpaper: [id] } },
						},
					],
				}),
				puppeteer: null,
			});
			const res = await app.request(`/images/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { code: string; message: string };
			expect(json.code).toBe("conflict");
			expect(json.message).toBe(
				"该背景图还有 2 处在用：B 站 · 10086 · 皮肤「neon」、douyin · sec-1 · 皮肤「neon」，请先在卡片设置里移除再删除",
			);
			expect(await listCardBg(dir)).toEqual([id]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除被某 UP 覆盖引用的封面图 → conflict(409),message 指出该 UP", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-ref-up-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = route({
				deps: depsWithStore({ dataDir: dir, subs: [{ uid: "10086", cover: [id] }] }),
				puppeteer: null,
			});
			const res = await app.request(`/images/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { code: string; message: string };
			expect(json.code).toBe("conflict");
			expect(json.message).toContain("B 站 · 10086");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除被拓展订阅引用的封面图 → conflict(409),message 用外部 id 指认(ADR-0019 决策 47;别名已退役,ADR-0021 决策 16)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-cover-ext-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = route({
				deps: depsWithStore({
					dataDir: dir,
					subs: [
						{ kind: "extension", externalId: "MS4wLjAB-sec", cover: [id] },
						{ kind: "extension", externalId: "sec-2", cover: [id] },
					],
				}),
				puppeteer: null,
			});
			const res = await app.request(`/images/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { message: string };
			expect(json.message).toContain("douyin · MS4wLjAB-sec、douyin · sec-2");
			expect(await listCardBg(dir)).toEqual([id]); // 仍在盘上
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除非法 id → invalid(400)", async () => {
		const app = route({
			deps: depsWithStore({ dataDir: join(tmpdir(), "bn-x-no-such-dir") }),
			puppeteer: null,
		});
		const res = await app.request("/images/..%2f..%2fsecrets.json", { method: "DELETE" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "无效的资产 id" });
	});

	it("用家多了只点前三个名字再报个数 —— 一条错误不该变成一面墙", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-many-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = route({
				deps: depsWithStore({
					dataDir: dir,
					subs: ["101", "102", "103", "104", "105"].map((uid) => ({ uid, cover: [id] })),
				}),
				puppeteer: null,
			});
			const res = await app.request(`/images/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { message: string };
			expect(json.message).toContain("还有 5 处在用：B 站 · 101、B 站 · 102、B 站 · 103 等 5 处");
			expect(json.message).not.toContain("B 站 · 104");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("素材图片的 HTTP 往返刻画", () => {
	it("上传后可列举、读取原字节与私有永久缓存，空目录和非法读取保持原语义", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-library-roundtrip-"));
		try {
			const app = route({ deps: depsWithDataDir(dir), puppeteer: null });
			expect(await (await app.request("/images")).json()).toEqual({ ok: true, ids: [] });
			const form = new FormData();
			form.append("file", new File([PNG], "sample.png", { type: "image/png" }));
			const uploaded = await app.request("/images", { method: "POST", body: form });
			expect(uploaded.status).toBe(200);
			const { id } = (await uploaded.json()) as { id: string };
			expect(await (await app.request("/images")).json()).toEqual({ ok: true, ids: [id] });
			const image = await app.request(`/images/${id}`);
			expect(image.status).toBe(200);
			expect(image.headers.get("content-type")).toBe("image/png");
			expect(image.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
			expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
			expect((await app.request("/images/..%2f..%2fsecret")).status).toBe(404);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("超大图片请求在读 multipart 前以 413 拒绝", async () => {
		const app = route({ deps: depsWithDataDir(join(tmpdir(), "bn-no-library")), puppeteer: null });
		const res = await app.request("/images", {
			method: "POST",
			headers: { "content-length": "6000000" },
			body: "x",
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ code: "invalid" });
	});
});
describe("背景图上传与读取", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-library-failures-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});
	function bgApp() {
		return route({ deps: depsWithDataDir(dataDir), puppeteer: null });
	}

	function uploadPng(app: Pick<Hono, "request">, type = "image/png") {
		const form = new FormData();
		form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", { type }));
		return app.request("/images", { method: "POST", body: form });
	}

	it("没带文件 → invalid(400)", async () => {
		const res = await bgApp().request("/images", { method: "POST", body: new FormData() });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "缺少图片文件" });
	});

	it("不是图片 → invalid(400),说得出支持哪几种", async () => {
		const res = await uploadPng(bgApp(), "application/pdf");
		expect(res.status).toBe(400);
		const json = (await res.json()) as { code: string; message: string };
		expect(json.code).toBe("invalid");
		expect(json.message).toContain("PNG");
	});

	it("磁盘写失败 → 不当成 400 把原话甩出去:走全局出错处理,只回固定一句", async () => {
		// `library` 是个文件而不是目录 —— 建图廊目录必然失败。
		await writeFile(join(dataDir, CARD_BG_DIR[0]), "占位");
		const app = new Hono()
			.onError((_err, c) => respondFailure(c, fail("unavailable", unhandledErrorMessage())))
			.route("/", bgApp());
		const res = await uploadPng(app);
		expect(res.status).toBe(503);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({ code: "unavailable", message: unhandledErrorMessage() });
		expect(text).not.toContain(dataDir);
	});

	it("取一张不存在的图 → not_found(404),说的是中文不是「not found」", async () => {
		const res = await bgApp().request(`/images/${"a".repeat(32)}.png`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "背景图不存在" });
	});

	it("取一款不存在的字体 → not_found(404)", async () => {
		const res = await bgApp().request(`/fonts/${"a".repeat(32)}.woff2`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "字体不存在" });
	});

	it("删一张本来就不在的图 → 200(幂等):面板拿到 200 照常刷新图廊", async () => {
		const res = await bgApp().request(`/images/${"a".repeat(32)}.png`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});

it("reads upload nouns when rejecting a request after the route has been constructed", async () => {
	const app = route({ deps: depsWithDataDir(join(tmpdir(), "bn-no-library")), puppeteer: null });
	const state = i18n.state();
	i18n.set({ locale: "en", voice: "plain" });
	const current = i18n.state().t;
	const spy = vi
		.spyOn(i18n.state(), "t")
		.mockImplementation((key, values) =>
			key === "cards.upload.imageNoun" ? "Current image" : current(key, values),
		);
	try {
		const response = await app.request("/images", {
			method: "POST",
			headers: { "content-length": "6000000" },
			body: "x",
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			code: "invalid",
			message: expect.stringContaining("Current image"),
		});
	} finally {
		spy.mockRestore();
		i18n.set({ locale: state.locale, voice: state.voice });
	}
});
