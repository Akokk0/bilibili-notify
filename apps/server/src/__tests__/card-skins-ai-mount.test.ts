/**
 * 接线守卫:卡片皮肤那口 AI 真的拿得到引擎吗。
 *
 * 🔴 路由自己的测试是直接喂 `commentary` 的,证明不了 app 里那一行真的接上了。少这一行
 * 的症状是**配好了模型也永远 503**,而两边都不报错。引擎是后挂的,所以也钉住「热读」:
 * app 装配完才挂上的引擎照样用得上。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import { CARD_SKIN_MANIFEST_FILE } from "../card-skins/package.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";
import type { EnginesRuntime } from "../runtime/engines.js";

const MANIFEST = {
	schemaVersion: 1,
	dataVersion: 1,
	name: "接线测试",
	cards: {
		live: {
			width: 600,
			blocks: [
				{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
			],
		},
	},
};

describe("/api/card-skins/:id/ai-css 的引擎接线", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-card-ai-mount-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("引擎没挂 → 503;app 装配完再挂上 → 用的就是它", async () => {
		const bootstrap: BootstrapConfig = {
			server: { host: "127.0.0.1", port: 8787 },
			dataDir,
			logLevel: "silent",
		};
		const runtime = createAppRuntime(bootstrap);
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.bootstrap.dataDir) },
		});

		const form = new FormData();
		const zip = zipSync({ [CARD_SKIN_MANIFEST_FILE]: strToU8(JSON.stringify(MANIFEST)) });
		form.append("file", new File([zip], "skin.zip", { type: "application/zip" }));
		const installed = await app.request("/api/card-skins", { method: "POST", body: form });
		expect(installed.status).toBe(201);
		const { id } = (await installed.json()) as { id: string };

		const ask = () =>
			app.request(`/api/card-skins/${id}/ai-css`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					kind: "live",
					blockId: "cover",
					instruction: "圆角大一点",
					manifest: MANIFEST,
				}),
			});

		expect((await ask()).status).toBe(503);

		const generateRaw = vi.fn(async () => '[data-bn="self"]{border-radius:16px}');
		runtime.attachEngines({ commentary: { generateRaw } } as unknown as EnginesRuntime);
		const res = await ask();
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("event: done");
		expect(generateRaw).toHaveBeenCalledOnce();
		await runtime.dispose();
	});
});

/**
 * **`createApp` 用的必须是传进去的那一家店**(2026-09-20 主人拍板把 `cardSkins` 改必填)。
 *
 * 从前这个选项是可选的,缺省时 `createApp` 会自建一家**读同一个目录**的店。那样面板装得进、
 * 列得出,而出图那头拿的仍是宿主传给引擎的那一家 —— 「装了新皮肤、推送不变」,**症状完全
 * 静默**(装包 201、出图一个像素不变)。必填只挡住「忘了传」,挡不住「传了却不用」,所以这条
 * 钉的是后半句。
 *
 * 判据照 `wiring-needs-its-own-guard`:把 `app.ts` 里那句 `options.cardSkins.store` 换回
 * `?? new CardSkinStore({...})`,这条必须红。
 */
describe("createApp 的卡片皮肤店", () => {
	it("经 HTTP 装进去的皮肤，调用方手里那家店立刻看得见", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-cardskin-wiring-"));
		try {
			const runtime = createAppRuntime({
				server: { host: "127.0.0.1", port: 8787 },
				dataDir: dir,
				logLevel: "silent",
			});
			await runtime.configStore.load();
			// 宿主手里的那一家 —— 出图那头问的就是它。
			const mine = createCardSkinStore(runtime.bootstrap.dataDir);
			const app = createApp(runtime, { cardSkins: { store: mine } });

			const form = new FormData();
			form.append(
				"file",
				new File(
					[zipSync({ [CARD_SKIN_MANIFEST_FILE]: strToU8(JSON.stringify(MANIFEST)) })],
					"skin.zip",
					{ type: "application/zip" },
				),
			);
			const installed = await app.request("/api/card-skins", { method: "POST", body: form });
			expect(installed.status).toBe(201);
			const { id } = (await installed.json()) as { id: string };

			// 各建一家的话这里就是 false —— 盘上有、我手里这家的索引里没有。
			expect(mine.has(id)).toBe(true);
			await runtime.dispose();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
