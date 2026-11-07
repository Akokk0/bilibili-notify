/**
 * 字体图廊的四个端点 —— 上传 / 列表 / 取文件 / 删除。
 *
 * 与背景图那四个同形,纪律也照搬:
 * - id 正则是防穿越的**唯一**闸门(dataDir 里躺着 `bn.config.yaml`,带 apiKey 与 cookie)。
 * - **还被引用着就不许删**,并指出是谁在用 —— 直接删掉的话那一处配置立刻变成悬空引用,
 *   出图静静回落到兜底字体,而设置页上还显示着这款字体的名字,查都没法查。
 *   「被引用」**只算皮肤的字体旋钮**(2026-09-20 起;`cardStyle.fontAsset` 那条老路没有读者,
 *   ㉔e 起设置里连那个字段都没了)。
 *
 * 字体特有的那条:列表要带**原始文件名**。背景图有缩略图可看,字体只有一串 hex ——
 * 名字丢了主人根本认不出哪个是哪个。
 *
 * 失败只有一种形状(ADR-0026):`{ code, message }`。删除撞上「还被选着」是 `conflict`(409),
 * 用家并进 `message`,不再另占一格 `referencedBy`。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_SKIN_UPLOAD_PREFIX, fail } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import { FONT_DIR, listFontAssets, saveFontAsset } from "../../runtime/font-assets.js";
import { bilibiliLikeSources } from "../../subscriptions/__tests__/fixtures.js";
import { createLibraryRoute } from "../library.js";
import { respondFailure, unhandledErrorMessage } from "../respond-failure.js";
import type { RouteDeps } from "../types.js";

const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]);

it("字体下载保留原始字节与安全编码的原名，可再次导入且不覆盖原件", async () => {
	await withDir(async (dir) => {
		const app = route(makeDeps({ dataDir: dir }));
		const name = '验收 字体".woff2';
		const { id } = (await (await upload(app, name)).json()) as { id: string };
		const response = await app.request(`/fonts/${id}?download=1`);
		expect(response.headers.get("content-disposition")).toBe(
			`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
		);
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(bytes).toEqual(WOFF2);
		const imported = await upload(app, name, bytes);
		expect(imported.status).toBe(200);
		expect(((await imported.json()) as { id: string }).id).not.toBe(id);
		expect(await listFontAssets(dir)).toHaveLength(2);
	});
});

it("字体预览报告同名副本且不写盘，不合法后缀在预览和正式上传都拒绝", async () => {
	await withDir(async (dir) => {
		const app = route(makeDeps({ dataDir: dir }));
		await upload(app, "sample.woff2");
		const form = (name: string) => {
			const data = new FormData();
			data.set("file", new File([WOFF2], name));
			return data;
		};
		const response = await app.request("/fonts/import-preview", {
			method: "POST",
			body: form("sample.woff2"),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, name: "sample.woff2", conflict: true });
		expect(await listFontAssets(dir)).toHaveLength(1);
		expect(
			(await app.request("/fonts/import-preview", { method: "POST", body: form("bad.exe") }))
				.status,
		).toBe(400);
		expect((await upload(app, "bad.exe")).status).toBe(400);
	});
});

it("字体预览与正式上传都拒绝超过原文件上限，不改变原件", async () => {
	await withDir(async (dir) => {
		const app = route(makeDeps({ dataDir: dir }));
		await upload(app, "original.woff2");
		for (const path of ["/fonts/import-preview", "/fonts"]) {
			const data = new FormData();
			data.set("file", new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.woff2"));
			expect((await app.request(path, { method: "POST", body: data })).status).toBe(400);
		}
		expect(await listFontAssets(dir)).toHaveLength(1);
	});
});

/**
 * 造一份 deps。
 *
 * `knobFont` 摆的是**唯一算数**的那条引用:某套皮肤的字体旋钮选着它。
 */
function makeDeps(opts: {
	dataDir: string;
	/** 某套皮肤(`my-skin`)的字体旋钮选着这款字体。 */
	knobFont?: string;
	subs?: Array<{ uid: string; knobFont?: string }>;
}): RouteDeps {
	return {
		runtime: {
			// 删前查引用按在册来源给订阅起称呼(身份标签)。
			sourceRegistry: bilibiliLikeSources(),
			dataRoot: opts.dataDir,
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
		},
		store: {
			getGlobals: () => ({
				defaults: {
					cards: { enabled: true, liveCoverImageIds: [] },
					cardSkinKnobs: opts.knobFont
						? { "my-skin": { titleFont: `${CARD_SKIN_UPLOAD_PREFIX}${opts.knobFont}` } }
						: {},
				},
			}),
			getSubscriptions: () =>
				(opts.subs ?? []).map((s) => ({
					identity: { sourceKey: "bilibili", externalId: s.uid },
					overrides: {
						// 这位 UP 自己那层旋钮(ADR-0014 决策 17 的 🔗)—— 算数的那条 per-UP 引用。
						cardSkinKnobs: s.knobFont
							? { "my-skin": { titleFont: `${CARD_SKIN_UPLOAD_PREFIX}${s.knobFont}` } }
							: undefined,
					},
				})),
		},
	} as unknown as RouteDeps;
}

function route(deps: RouteDeps) {
	return createLibraryRoute(deps);
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

function upload(app: Pick<Hono, "request">, filename: string, bytes = WOFF2) {
	const form = new FormData();
	form.append("file", new File([bytes], filename));
	return app.request("/fonts", { method: "POST", body: form });
}

describe("POST /fonts —— 上传", () => {
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
			const json = (await res.json()) as { code: string; message: string };
			expect(json.code).toBe("invalid");
			expect(json.message).toContain("过大");
			expect(await listFontAssets(dir)).toEqual([]);
		});
	});

	it("不是字体的后缀 → invalid(400),错因说得出支持哪几种", async () => {
		await withDir(async (dir) => {
			const res = await upload(route(makeDeps({ dataDir: dir })), "trojan.exe");
			expect(res.status).toBe(400);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json.code).toBe("invalid");
			expect(json.message).toContain("woff2");
			expect(json).not.toHaveProperty("ok");
			expect(json).not.toHaveProperty("err");
			expect(await listFontAssets(dir)).toEqual([]);
		});
	});

	it("没带文件 → invalid(400)", async () => {
		await withDir(async (dir) => {
			const res = await route(makeDeps({ dataDir: dir })).request("/fonts", {
				method: "POST",
				body: new FormData(),
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as { code: string }).code).toBe("invalid");
		});
	});

	/**
	 * 只有「上传的东西不合规矩」(后缀不认、超上限)才是主人的 400;磁盘写不进去是环境的事,
	 * 往上抛给全局出错处理 —— 原话(里头带着数据目录的路径)进日志,客户端只拿固定一句。
	 * 从前路由把一切抛错都当 400 原样甩出去。验红:把路由里 `instanceof AssetRejectedError` 那句
	 * 改成无条件回 400,这条红。
	 */
	it("磁盘写失败 → 不当成 400 把原话甩出去:走全局出错处理,只回固定一句", async () => {
		await withDir(async (dir) => {
			// `library` 是个文件而不是目录 —— 建字体目录必然失败。
			await writeFile(join(dir, FONT_DIR[0]), "占位");
			const app = new Hono()
				.onError((_err, c) => respondFailure(c, fail("unavailable", unhandledErrorMessage())))
				.route("/", route(makeDeps({ dataDir: dir })));
			const res = await upload(app, "好字体.woff2");
			expect(res.status).toBe(503);
			const json = (await res.json()) as { code: string; message: string };
			expect(json).toEqual({ code: "unavailable", message: unhandledErrorMessage() });
			expect(JSON.stringify(json)).not.toContain(dir);
		});
	});
});

describe("GET /fonts —— 列表", () => {
	it("列出每一款的 id 与原始文件名", async () => {
		await withDir(async (dir) => {
			const a = await saveFontAsset(dir, WOFF2, "甲.woff2");
			const b = await saveFontAsset(dir, WOFF2, "乙.ttf");
			const res = await route(makeDeps({ dataDir: dir })).request("/fonts");
			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				ok: boolean;
				fonts: Array<{ id: string; name: string; size: number }>;
			};
			expect(json.ok).toBe(true);
			expect(json.fonts.map((font) => font.size)).toEqual([6, 6]);
			expect(new Set(json.fonts.map((f) => `${f.id}|${f.name}`))).toEqual(
				new Set([`${a}|甲.woff2`, `${b}|乙.ttf`]),
			);
		});
	});

	it("一款都没传过 → 空列表,不是 404", async () => {
		await withDir(async (dir) => {
			const json = (await (await route(makeDeps({ dataDir: dir })).request("/fonts")).json()) as {
				fonts: unknown[];
			};
			expect(json.fonts).toEqual([]);
		});
	});
});

describe("GET /fonts/:id —— 取文件", () => {
	it("回字体字节,content-type 与后缀对得上", async () => {
		await withDir(async (dir) => {
			const id = await saveFontAsset(dir, WOFF2, "x.woff2");
			const res = await route(makeDeps({ dataDir: dir })).request(`/fonts/${id}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("font/woff2");
			expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
			expect(new Uint8Array(await res.arrayBuffer())).toEqual(WOFF2);
		});
	});

	it("穿越 id → 404,绝不把 dataDir 里的东西端出去", async () => {
		await withDir(async (dir) => {
			const res = await route(makeDeps({ dataDir: dir })).request(
				"/fonts/..%2f..%2fbn.config.yaml",
			);
			expect(res.status).toBe(404);
		});
	});
});

describe("DELETE /fonts/:id —— 删除", () => {
	it("没人用 → 200,盘上也没了", async () => {
		await withDir(async (dir) => {
			const id = await saveFontAsset(dir, WOFF2, "待删.woff2");
			const res = await route(makeDeps({ dataDir: dir })).request(`/fonts/${id}`, {
				method: "DELETE",
			});
			expect(res.status).toBe(200);
			expect(await listFontAssets(dir)).toEqual([]);
		});
	});

	it("某套皮肤的字体旋钮选着它 → conflict(409) 拦下并在 message 里点名是哪套,文件仍在", async () => {
		await withDir(async (dir) => {
			const id = await saveFontAsset(dir, WOFF2, "在用.woff2");
			const res = await route(makeDeps({ dataDir: dir, knobFont: id })).request(`/fonts/${id}`, {
				method: "DELETE",
			});
			expect(res.status).toBe(409);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json.code).toBe("conflict");
			expect(json.message).toContain("还有 1 处在用：皮肤「my-skin」");
			// 用家并进了 message,不再另占一格。
			expect(json).not.toHaveProperty("referencedBy");
			expect((await listFontAssets(dir)).map((f) => f.id)).toEqual([id]);
		});
	});

	/**
	 * per-UP 那层旋钮(ADR-0014 决策 17 的 🔗)选着它也得拦 —— 出图真读它,
	 * 删了这位 UP 的卡就静静回落兜底字体。
	 * 验红:把 `fontAssetReferences` 里扫订阅旋钮那一段删掉,这条红。
	 */
	it("某位 UP 单独拧的字体旋钮选着它 → conflict(409) 拦下并点名是谁、哪套,文件仍在", async () => {
		await withDir(async (dir) => {
			const id = await saveFontAsset(dir, WOFF2, "UP 在用.woff2");
			const res = await route(
				makeDeps({ dataDir: dir, subs: [{ uid: "12345", knobFont: id }] }),
			).request(`/fonts/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { code: string; message: string };
			expect(json.code).toBe("conflict");
			expect(json.message).toContain("B 站 · 12345 · 皮肤「my-skin」");
			expect((await listFontAssets(dir)).map((f) => f.id)).toEqual([id]);
		});
	});

	it("非法 id → invalid(400),而且压根不去碰盘", async () => {
		await withDir(async (dir) => {
			const res = await route(makeDeps({ dataDir: dir })).request(
				"/fonts/..%2f..%2fbn.config.yaml",
				{ method: "DELETE" },
			);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { code: string }).code).toBe("invalid");
		});
	});

	it("删一款本来就不在的 → 200(幂等):面板拿到 200 照常刷新字体库", async () => {
		await withDir(async (dir) => {
			const gone = `${"a".repeat(32)}.woff2`;
			const res = await route(makeDeps({ dataDir: dir })).request(`/fonts/${gone}`, {
				method: "DELETE",
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		});
	});
});
