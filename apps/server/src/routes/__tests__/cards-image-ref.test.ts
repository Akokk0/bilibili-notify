import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import type { PuppeteerAdapter } from "../../runtime/puppeteer.js";
import { createCardsRoute } from "../cards.js";
import type { RouteDeps } from "../types.js";

/**
 * 预览路由的出卡器要接得上图库解析口(3a-05;生产那条在 `runtime/engines.ts`)。
 *
 * 今天预览造出来的输入都是远端 `url`,没有哪个请求能让它带上引用 —— 所以这里把档位表换成一份「徽章是图库引用」的,
 * 走的仍是 `POST /preview` 这扇公开的门、真的路由造的真出卡器,只是让档位那一格先变成 3a 之后的样子。
 * 接线剪断(路由造出卡器时不传 `resolveImageRef`)的话,引用解析不出来,徽章块收起,断言里的 data URL 就不在了。
 */
const BADGE_REF = "badge-in-gallery.png";

vi.mock("@bilibili-notify/internal", async (importOriginal) => {
	const original = await importOriginal<typeof import("@bilibili-notify/internal")>();
	return {
		...original,
		guardTierByKey: (key: string) => {
			const tier = original.guardTierByKey(key);
			return tier && { ...tier, icon: { ref: "badge-in-gallery.png" } };
		},
	};
});

const BADGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BADGE_DATA_URL = `data:image/png;base64,${BADGE_BYTES.toString("base64")}`;

const capturedHtml: string[] = [];

function makeFakePuppeteer(): PuppeteerAdapter {
	const fakePage = {
		setContent: vi.fn(async (html: string) => {
			capturedHtml.push(html);
		}),
		$: vi.fn(async () => ({
			boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
			dispose: async () => {},
		})),
		screenshot: vi.fn(async () => Buffer.from("fake-png-bytes")),
		close: vi.fn(async () => {}),
	};
	return { page: vi.fn(async () => fakePage) } as unknown as PuppeteerAdapter;
}

function makeDeps(dataRoot: string): RouteDeps {
	return {
		runtime: {
			dataRoot,
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
			// 图库里放着一张图;别的引用一概没有。
			imageStore: {
				read: async (ref: string) =>
					ref === BADGE_REF ? { bytes: BADGE_BYTES, mime: "image/png" } : undefined,
			},
		},
		store: { getGlobals: () => ({ defaults: { cardSkin: "default", cardSkinKnobs: {} } }) },
	} as unknown as RouteDeps;
}

describe("cards route — 预览出卡器的图库解析口", () => {
	it("上舰预览:档位徽章是图库引用时,出卡器把它解析成图库里那张图", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-cards-image-ref-"));
		try {
			capturedHtml.length = 0;
			const app = createCardsRoute({
				deps: makeDeps(dir),
				puppeteer: makeFakePuppeteer(),
				api: null,
			});
			const res = await app.request("/preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					kind: "membership",
					style: {},
					content: { tierKey: "captain" },
					fallback: true,
				}),
			});
			expect(res.status).toBe(200);
			expect(capturedHtml.join("\n")).toContain(BADGE_DATA_URL);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
