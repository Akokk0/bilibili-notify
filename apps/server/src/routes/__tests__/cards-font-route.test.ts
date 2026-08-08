/**
 * 字体图廊的四个端点 —— 上传 / 列表 / 取文件 / 删除。
 *
 * 与背景图那四个同形,纪律也照搬:
 * - id 正则是防穿越的**唯一**闸门(dataDir 里躺着 `bn.config.yaml`,带 apiKey 与 cookie)。
 * - **还被引用着就不许删**,并指出是谁在用 —— 直接删掉的话那一处配置立刻变成悬空引用,
 *   出图静静回落到兜底字体,而设置页上还显示着这款字体的名字,查都没法查。
 *
 * 字体特有的那条:列表要带**原始文件名**。背景图有缩略图可看,字体只有一串 hex ——
 * 名字丢了主人根本认不出哪个是哪个。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { listFontAssets, saveFontAsset } from "../../runtime/font-assets.js";
import { createCardsRoute } from "../cards.js";
import type { RouteDeps } from "../types.js";

const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]);

/** 造一份 deps;`fontAsset` 系列参数用来摆出「这款字体正被某处引用」的局面。 */
function makeDeps(opts: {
	dataDir: string;
	globalFont?: string;
	/** 全局某 per-kind(sc)覆盖里选的字体。 */
	globalKindFont?: string;
	subs?: Array<{ uid: string; font?: string; kindFont?: string }>;
}): RouteDeps {
	return {
		runtime: {
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
		},
		store: {
			bootstrap: { dataDir: opts.dataDir },
			getGlobals: () => ({
				defaults: {
					cardStyle: {
						backgroundImages: [],
						liveCoverImages: [],
						fontAsset: opts.globalFont,
					},
					cardStyleByKind: opts.globalKindFont ? { sc: { fontAsset: opts.globalKindFont } } : {},
				},
			}),
			getSubscriptions: () =>
				(opts.subs ?? []).map((s) => ({
					uid: s.uid,
					overrides: {
						cardStyle: s.font ? { fontAsset: s.font } : undefined,
						cardStyleByKind: s.kindFont ? { guard: { fontAsset: s.kindFont } } : undefined,
					},
				})),
		},
	} as unknown as RouteDeps;
}

function route(deps: RouteDeps) {
	return createCardsRoute({ deps, puppeteer: null, api: null });
}

/** 跑一段用完就删临时目录的用例。 */
async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "bn-font-route-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function upload(app: ReturnType<typeof route>, filename: string, bytes = WOFF2) {
	const form = new FormData();
	form.append("file", new File([bytes], filename));
	return app.request("/font-asset", { method: "POST", body: form });
}

describe("POST /font-asset —— 上传", () => {
	it("传一款 woff2 → 落盘并回资产 id 与文件名", async () => {
		await withDir(async (dir) => {
			const res = await upload(route(makeDeps({ dataDir: dir })), "思源黑体.woff2");
			expect(res.status).toBe(200);
			const json = (await res.json()) as { ok: boolean; id: string; name: string };
			expect(json.ok).toBe(true);
			expect(json.id).toMatch(/^[a-f0-9]{32}\.woff2$/);
			expect(json.name).toBe("思源黑体.woff2");
			expect(await listFontAssets(dir)).toEqual([
				// size 是设置页那句「这款大到会把出图撑爆」的依据,按当前选中那款算。
				{ id: json.id, name: "思源黑体.woff2", size: expect.any(Number) },
			]);
		});
	});

	/**
	 * 超大上传必须**在读进堆之前**就被挡掉。
	 *
	 * `parseBody()` + `arrayBuffer()` 会把整个 multipart body 实体化,而
	 * `saveFontAsset` 的上限是在那之后才校验的 —— 镜像里 V8 老生代只有 512MB,拖一个
	 * 几百兆的 ttf 进来是把进程弄死,而不是收到那句「字体文件过大」。容器被
	 * `restart: unless-stopped` 拉起来,主人看到的是面板断线又重连,永远等不到那句话。
	 */
	it("大到离谱的上传 → 413 当场回绝,不先把它整份读进内存", async () => {
		await withDir(async (dir) => {
			// 比 MAX_FONT_ASSET_BYTES(20MB)大一截,但没大到让测试自己吃不消。
			const huge = new Uint8Array(21 * 1024 * 1024);
			const res = await upload(route(makeDeps({ dataDir: dir })), "巨无霸.ttf", huge);
			expect(res.status).toBe(413);
			const json = (await res.json()) as { ok: boolean; err: string };
			expect(json.ok).toBe(false);
			expect(json.err).toContain("过大");
			expect(await listFontAssets(dir)).toEqual([]);
		});
	});

	it("不是字体的后缀 → 400,错因说得出支持哪几种", async () => {
		await withDir(async (dir) => {
			const res = await upload(route(makeDeps({ dataDir: dir })), "trojan.exe");
			expect(res.status).toBe(400);
			const json = (await res.json()) as { ok: boolean; err: string };
			expect(json.ok).toBe(false);
			expect(json.err).toContain("woff2");
			expect(await listFontAssets(dir)).toEqual([]);
		});
	});

	it("没带文件 → 400", async () => {
		await withDir(async (dir) => {
			const res = await route(makeDeps({ dataDir: dir })).request("/font-asset", {
				method: "POST",
				body: new FormData(),
			});
			expect(res.status).toBe(400);
		});
	});
});

describe("GET /font-assets —— 列表", () => {
	it("列出每一款的 id 与原始文件名", async () => {
		await withDir(async (dir) => {
			const a = await saveFontAsset(dir, WOFF2, "甲.woff2");
			const b = await saveFontAsset(dir, WOFF2, "乙.ttf");
			const res = await route(makeDeps({ dataDir: dir })).request("/font-assets");
			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				ok: boolean;
				fonts: Array<{ id: string; name: string }>;
			};
			expect(json.ok).toBe(true);
			expect(new Set(json.fonts.map((f) => `${f.id}|${f.name}`))).toEqual(
				new Set([`${a}|甲.woff2`, `${b}|乙.ttf`]),
			);
		});
	});

	it("一款都没传过 → 空列表,不是 404", async () => {
		await withDir(async (dir) => {
			const json = (await (
				await route(makeDeps({ dataDir: dir })).request("/font-assets")
			).json()) as {
				fonts: unknown[];
			};
			expect(json.fonts).toEqual([]);
		});
	});
});

describe("GET /font-asset/:id —— 取文件", () => {
	it("回字体字节,content-type 与后缀对得上", async () => {
		await withDir(async (dir) => {
			const id = await saveFontAsset(dir, WOFF2, "x.woff2");
			const res = await route(makeDeps({ dataDir: dir })).request(`/font-asset/${id}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("font/woff2");
			expect(new Uint8Array(await res.arrayBuffer())).toEqual(WOFF2);
		});
	});

	it("穿越 id → 404,绝不把 dataDir 里的东西端出去", async () => {
		await withDir(async (dir) => {
			const res = await route(makeDeps({ dataDir: dir })).request(
				"/font-asset/..%2f..%2fbn.config.yaml",
			);
			expect(res.status).toBe(404);
		});
	});
});

describe("DELETE /font-asset/:id —— 删除", () => {
	it("没人用 → 200,盘上也没了", async () => {
		await withDir(async (dir) => {
			const id = await saveFontAsset(dir, WOFF2, "待删.woff2");
			const res = await route(makeDeps({ dataDir: dir })).request(`/font-asset/${id}`, {
				method: "DELETE",
			});
			expect(res.status).toBe(200);
			expect(await listFontAssets(dir)).toEqual([]);
		});
	});

	it("全局默认还选着它 → 409 拦下,文件仍在", async () => {
		await withDir(async (dir) => {
			const id = await saveFontAsset(dir, WOFF2, "在用.woff2");
			const res = await route(makeDeps({ dataDir: dir, globalFont: id })).request(
				`/font-asset/${id}`,
				{ method: "DELETE" },
			);
			expect(res.status).toBe(409);
			const json = (await res.json()) as { referencedBy: string[] };
			expect(json.referencedBy).toContain("全局默认");
			expect((await listFontAssets(dir)).map((f) => f.id)).toEqual([id]);
		});
	});

	it("某个 per-kind 覆盖选着它 → 同样 409(最容易漏的一层)", async () => {
		await withDir(async (dir) => {
			const id = await saveFontAsset(dir, WOFF2, "sc 在用.woff2");
			const res = await route(makeDeps({ dataDir: dir, globalKindFont: id })).request(
				`/font-asset/${id}`,
				{ method: "DELETE" },
			);
			expect(res.status).toBe(409);
		});
	});

	it("某位 UP 单独选着它 → 409,并指出是哪位", async () => {
		await withDir(async (dir) => {
			const id = await saveFontAsset(dir, WOFF2, "某 UP 在用.woff2");
			const res = await route(
				makeDeps({ dataDir: dir, subs: [{ uid: "12345", font: id }] }),
			).request(`/font-asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			expect(((await res.json()) as { referencedBy: string[] }).referencedBy).toContain("UP 12345");
		});
	});

	it("某位 UP 的 per-kind 覆盖选着它 → 409(第四层,同样别漏)", async () => {
		await withDir(async (dir) => {
			const id = await saveFontAsset(dir, WOFF2, "UP 的 guard 卡在用.woff2");
			const res = await route(
				makeDeps({ dataDir: dir, subs: [{ uid: "999", kindFont: id }] }),
			).request(`/font-asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
		});
	});

	it("非法 id → 400,而且压根不去碰盘", async () => {
		await withDir(async (dir) => {
			const res = await route(makeDeps({ dataDir: dir })).request(
				"/font-asset/..%2f..%2fbn.config.yaml",
				{ method: "DELETE" },
			);
			expect(res.status).toBe(400);
		});
	});
});
