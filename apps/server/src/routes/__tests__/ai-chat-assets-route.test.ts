/**
 * 女仆 AI 聊天 —— 附件的上传(`POST /api/ai/assets`)。
 *
 * 字节交给聊天这家引用方的图库口(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗),回的 `id` 就是图库引用;
 * 读回走图库的同源读口 `GET /api/images/<ref>`,旧的 `GET /api/ai/assets/:id` 已经没了(接线守卫钉着)。
 * 上传层自己的两条规矩留在这里:5MB 上限、不收 gif;格式一律按嗅探,不信客户端声明的 `file.type`。
 *
 * 守的是失败怎么答(ADR-0026):
 * - 主人递进来的东西不合规矩(没带文件、格式不认、太大)→ `invalid` + 给人看的中文原因;
 * - 磁盘写失败这类环境的事(图库回 `unavailable`)→ 与全局出错处理同一个口径:原话(带路径)进日志,
 *   客户端只拿一句固定的话。从前这里 `String(err.message)` 原样回给客户端,路径也在里头。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型

import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import { distinctPng, makeChatImages, putImage } from "../../__tests__/support/chat-images.js";
import { createConversationStore } from "../../ai/conversation-store.js";
import { IMAGE_GRACE_MS } from "../../images/image-store.js";
import { createAiRoute } from "../ai.js";
import { requestErrorHandler, UNHANDLED_ERROR_MESSAGE } from "../respond-failure.js";
import type { RouteDeps } from "../types.js";

const MB5 = 5 * 1024 * 1024;
/** GIF89a 打头的最小字节:图库收,聊天附件不收。 */
const GIF_BYTES = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");

function mount(dataDir: string) {
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const conversationStore = createConversationStore({ dataRoot: dataDir, logger });
	const { imageStore, chatImages } = makeChatImages(dataDir, conversationStore);
	const deps = {
		store: {},
		runtime: {
			dataRoot: dataDir,
			serviceCtx: { logger },
			conversationStore,
			imageStore,
			chatImages,
		},
	} as unknown as RouteDeps;
	// 与 app.ts 一样:路由挂在带全局出错处理的父实例下,抛出来的错才会被接住。
	const app = new Hono();
	app.onError(requestErrorHandler(logger));
	app.route("/api/ai", createAiRoute(deps));
	return { app, logger, imageStore, chatImages, conversationStore };
}

const newDir = () => mkdtemp(join(tmpdir(), "bn-chatassets-"));

function upload(app: Hono, file: File | null) {
	const form = new FormData();
	if (file) form.append("file", file);
	return app.request("/api/ai/assets", { method: "POST", body: form });
}

const png = (type = "image/png") => new File([distinctPng(1)], "a.png", { type });

describe("POST /api/ai/assets", () => {
	it("合规的图 → 200 + { ok: true, id },id 是图库引用,从图库读得回同样的字节", async () => {
		const { app, imageStore } = mount(await newDir());

		const res = await upload(app, png());

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.ok).toBe(true);
		expect(body.id).toMatch(/^[0-9a-f]{64}\.png$/);
		const read = await imageStore.read(body.id);
		expect(read?.mime).toBe("image/png");
		expect(new Uint8Array(read?.bytes ?? [])).toEqual(new Uint8Array(distinctPng(1)));
	});

	it("同一张图传两次 → 同一个引用,盘上只有一份", async () => {
		const dataDir = await newDir();
		const { app } = mount(dataDir);

		const first = (await (await upload(app, png())).json()) as any;
		const second = (await (await upload(app, png())).json()) as any;

		expect(second.id).toBe(first.id);
		expect(await readdir(join(dataDir, "images"))).toEqual([first.id]);
	});

	it("格式按字节嗅探,不信客户端声明的 file.type:PNG 字节报成别的类型照收", async () => {
		const { app } = mount(await newDir());

		const res = await upload(app, png("application/octet-stream"));

		expect(res.status).toBe(200);
		expect(((await res.json()) as any).id).toMatch(/\.png$/);
	});

	it("声明成 image/png 的 SVG 也进不来 —— SVG 能带脚本", async () => {
		const { app } = mount(await newDir());

		const res = await upload(app, new File(["<svg/>"], "a.png", { type: "image/png" }));

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("不支持的图片类型");
		expect(body.message).toContain("PNG");
	});

	it("聊天附件不收 gif(图库本身收,这是上传层更紧的规矩),声明成什么都一样", async () => {
		const dataDir = await newDir();
		const { app } = mount(dataDir);

		const res = await upload(app, new File([GIF_BYTES], "a.png", { type: "image/png" }));

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("GIF");
		expect(await readdir(dataDir)).not.toContain("images");
	});

	it("没带文件 → 400 invalid + 「缺少图片文件」", async () => {
		const { app } = mount(await newDir());

		const res = await upload(app, null);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "缺少图片文件" });
	});

	it("上限 5MB:正好 5MB 收,多一个字节 → 400 invalid + 「图片过大」(图库自己的 8MB 不是这一层的线)", async () => {
		const { app } = mount(await newDir());
		const exact = new Uint8Array(MB5);
		exact.set(distinctPng(2));
		const over = new Uint8Array(MB5 + 1);
		over.set(distinctPng(3));

		expect((await upload(app, new File([exact], "a.png", { type: "image/png" }))).status).toBe(200);
		const res = await upload(app, new File([over], "b.png", { type: "image/png" }));

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "图片过大（上限 5MB）" });
	});

	it("磁盘写失败是环境的事 → 503 + 固定一句话;带路径的原话进日志,不回给客户端", async () => {
		// dataRoot 指到一个普通文件上:`<file>/images` 建不出来,抛的是带路径的 ENOTDIR。
		const dir = await newDir();
		const notADir = join(dir, "i-am-a-file");
		await writeFile(notADir, "x");
		const { app, logger } = mount(notADir);

		const res = await upload(app, png());

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ code: "unavailable", message: UNHANDLED_ERROR_MESSAGE });
		expect(logger.error).toHaveBeenCalledTimes(1);
		const logged = logger.error.mock.calls[0]?.[1] as Error;
		expect(logged.message).toContain("i-am-a-file");
	});
});

describe("传了没发的图", () => {
	// 现存的泄漏之一:上传就落盘,主人没点发送。图不再有人记着它 —— 靠图库清扫在宽限期过后收走。
	it("上传后一直没发出去:宽限期内留着,过了宽限期被清扫收走", async () => {
		const { app, imageStore } = mount(await newDir());
		const { id } = (await (await upload(app, png())).json()) as any;

		const early = await imageStore.sweep({ now: new Date(Date.now() + 60_000) });
		expect(early).toMatchObject({ removed: [], inGrace: 1 });

		const late = await imageStore.sweep({ now: new Date(Date.now() + IMAGE_GRACE_MS + 60_000) });
		expect(late.removed).toEqual([id]);
		expect(await imageStore.read(id)).toBeUndefined();
	});

	it("别的会话还引用着同一张图 → 没发出去的那份不连累它", async () => {
		const { app, imageStore, chatImages, conversationStore } = mount(await newDir());
		// 「另一个会话」里已经发出去的消息引用着这张图。
		const ref = await putImage(chatImages, distinctPng(1));
		const conv = await conversationStore.create();
		await conversationStore.appendMessages(conv.id, [
			{ role: "user", content: "看", images: [ref] },
		]);
		// 主人又传了一遍同一张(拿到同一个引用),这次没发。
		const { id } = (await (await upload(app, png())).json()) as any;
		expect(id).toBe(ref);

		const late = await imageStore.sweep({ now: new Date(Date.now() + IMAGE_GRACE_MS + 60_000) });

		expect(late).toMatchObject({ removed: [], referenced: 1 });
	});
});
