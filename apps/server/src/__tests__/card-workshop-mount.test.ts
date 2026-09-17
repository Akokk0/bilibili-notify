/**
 * 接线守卫:卡片皮肤工坊在 app 里真的接上了吗(ADR-0015 决策 11 / 19)。
 *
 * 🔴 聊天路由自己的测试是直接喂皮肤库与截图口的,证明不了 `app.ts` 那几行真的接上了。
 * 少了皮肤库,工坊一开口就 400;少了截图口,`look_card` 永远说「截不了」,而装着 Chrome
 * 的主人只会觉得女仆看不见图 —— 两样都不报错。另一条要钉的是**同一家店**:工坊做出来的
 * 皮肤得立刻出现在 `/api/card-skins` 里,各 new 一家的话要等重启才看得见。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtraTool, ExtraToolResult } from "@bilibili-notify/ai";
import { AI_CARD_WORKSHOP_TOOLS as T } from "@bilibili-notify/contract";
import { DEFAULT_CARD_SKIN_ID } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../app.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";
import type { EnginesRuntime } from "../runtime/engines.js";
import type { StandalonePuppeteer } from "../runtime/puppeteer.js";

/** 假 Chrome:截图吐一段固定字节。 */
function fakePuppeteer(): StandalonePuppeteer {
	const page = {
		setContent: vi.fn(async () => {}),
		$: vi.fn(async () => ({
			boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
			dispose: async () => {},
		})),
		screenshot: vi.fn(async () => Buffer.from("shot")),
		close: vi.fn(async () => {}),
	};
	return { page: vi.fn(async () => page) } as unknown as StandalonePuppeteer;
}

describe("卡片皮肤工坊的装配接线", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-card-workshop-mount-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("工坊拿得到皮肤库与截图口,做出来的皮肤就在皮肤页那家店里", async () => {
		const bootstrap: BootstrapConfig = {
			server: { host: "127.0.0.1", port: 8787 },
			dataDir,
			logLevel: "silent",
		};
		const runtime = createAppRuntime(bootstrap);
		await runtime.configStore.load();
		await runtime.configStore.patchGlobals({ defaults: { ai: { enabled: true } } });
		const app = createApp(runtime, { puppeteer: fakePuppeteer() });

		const seen: { look?: string | ExtraToolResult; made?: string } = {};
		const chatStatelessStream = vi.fn(
			async (
				_messages: unknown,
				opts: { extraTools?: ExtraTool[]; onDelta: (t: string) => void },
			) => {
				const tool = (name: string) =>
					opts.extraTools?.find((t) => t.definition.function.name === name);
				seen.look = await tool(T.lookCard)?.execute({ skin: DEFAULT_CARD_SKIN_ID, kind: "live" });
				const made = await tool(T.setSkinMeta)?.execute({ name: "接线测试" });
				seen.made = typeof made === "string" ? made : made?.text;
				opts.onDelta("好");
				return "好";
			},
		);
		runtime.attachEngines({ commentary: { chatStatelessStream } } as unknown as EnginesRuntime);

		const created = await app.request("/api/ai/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "skin", skinTarget: "card" }),
		});
		const { conversation } = (await created.json()) as { conversation: { id: string } };
		const res = await app.request(`/api/ai/conversations/${conversation.id}/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "做一套" }),
		});
		expect(res.status).toBe(200);
		await res.text();

		expect(chatStatelessStream).toHaveBeenCalledOnce();
		expect(typeof seen.look).toBe("object");
		expect((seen.look as ExtraToolResult).images?.[0]).toMatch(/^data:image\/jpeg;base64,/);

		const list = (await (await app.request("/api/card-skins")).json()) as {
			skins: Array<{ name: string }>;
		};
		expect(list.skins.map((s) => s.name)).toContain("接线测试");
		await runtime.dispose();
	});
});
