/**
 * 女仆 AI 聊天 —— 图片附件那一路。
 *
 * 三条契约,按要紧程度排:
 *
 * ① **没配视觉模型就发图 → 明确拒绝。** 独立端没有「图直接下挂给主模型」那条路
 *    (`enableVision` 在这一端恒为 false),所以视觉模型没配时图片是彻底没人看的。
 *    静默吞掉的话,主人会看着女仆一本正经地聊天却对图只字不提,以为是模型笨 ——
 *    而真正的原因在另一个页面的一个空输入框里。
 *
 * ② **交给模型的是 data URL,不是链接。** 视觉服务商在公网,拉不到主人本地的
 *    `http://localhost:9000/api/ai/assets/xxx`。这跟 B 站动态里的图完全不同,
 *    那些本来就是公网可达的,所以那条路直接传 URL。
 *
 * ③ **删会话把它自己的图一并带走。** 不然磁盘只增不减,而这种泄漏要很久之后
 *    才会被发现。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createConversationStore } from "../../ai/conversation-store.js";
import { chatImageDir, saveChatImage } from "../../runtime/chat-assets.js";
import { createAiRoute } from "../ai.js";
import type { RouteDeps } from "../types.js";

const H = vi.hoisted(() => ({
	reply: "看到啦~",
	/** 最后一次收到的 imageUrls,用来验「到底交了什么给模型」。 */
	lastImageUrls: null as string[] | undefined | null,
}));

const chatStatelessStream = vi.fn(
	async (
		_messages: Array<{ role: string; content: string }>,
		opts: { onDelta: (t: string) => void; imageUrls?: string[] },
	) => {
		H.lastImageUrls = opts.imageUrls;
		opts.onDelta(H.reply);
		return H.reply;
	},
);

let dataDir: string;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function makeDeps(
	opts: { visionModel?: string; enableVision?: boolean; provider?: string } = {},
) {
	dataDir = await mkdtemp(join(tmpdir(), "bn-chatimg-"));
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const conversationStore = createConversationStore({ dataDir, logger });
	const deps = {
		store: {
			bootstrap: { dataDir },
			getGlobals: () => ({
				defaults: {
					ai: {
						enabled: true,
						activeProfile: opts.provider ?? "custom",
						// 看图那两条路现在也在服务商桶里 —— 它们描述的是「这家的主模型
						// 看不看得见图」,本来就该跟着服务商走。
						providers: {
							[opts.provider ?? "custom"]: {
								provider: opts.provider ?? "custom",
								label: "",
								apiKey: "sk-x",
								baseUrl: "https://api.example.com/v1",
								model: "m",
								temperature: 0.7,
								enableThinking: false,
								thinkingLevel: "medium",
								extraParams: "",
								enableVision: opts.enableVision ?? false,
								vision: { baseUrl: "", apiKey: "", model: opts.visionModel ?? "" },
							},
						},
					},
				},
			}),
			getTargets: () => [],
			getSubscriptions: () => [],
		},
		runtime: {
			serviceCtx: { logger },
			conversationStore,
			engines: {
				api: {},
				commentary: new (class {
					chatStatelessStream = chatStatelessStream;
					summarizeTitle = vi.fn(async () => "标题");
				})(),
			},
		},
	} as unknown as RouteDeps;
	return { deps, app: createAiRoute(deps) };
}

async function newConv(app: ReturnType<typeof createAiRoute>): Promise<string> {
	const res = await app.request("/conversations", { method: "POST" });
	return ((await res.json()) as any).conversation.id;
}

/**
 * 发一句。**必须把 body 读干**:成功那条是 SSE,`app.request` 一返回时流还在跑,
 * 落盘发生在流的末尾 —— 不读干就去断言磁盘,永远看不到消息。
 */
async function chat(
	app: ReturnType<typeof createAiRoute>,
	id: string,
	body: Record<string, unknown>,
): Promise<Response> {
	const res = await app.request(`/conversations/${id}/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (res.headers.get("content-type")?.includes("text/event-stream")) await res.text();
	return res;
}

beforeEach(() => {
	H.reply = "看到啦~";
	H.lastImageUrls = null;
	chatStatelessStream.mockClear();
});

describe("发图 — 主模型自己就支持多模态", () => {
	it("开了「主模型支持看图」→ 放行,不再要求先配副模型", async () => {
		// gpt-4o 这类主模型本来就看得见图。逼着主人再去「看图专用模型」那格
		// 抄一遍自己的模型名,既多余又违反那格字段的字面意思(它写着「主模型
		// 不支持时才填」)。
		const { app, deps } = await makeDeps({ enableVision: true, visionModel: "" });
		const id = await newConv(app);
		const img = await saveChatImage(deps.store.bootstrap.dataDir, PNG, "image/png");

		const res = await chat(app, id, { message: "这是什么", images: [img] });

		expect(res.status).toBe(200);
		expect(H.lastImageUrls).toHaveLength(1);
		expect(H.lastImageUrls?.[0]?.startsWith("data:image/png;base64,")).toBe(true);
	});

	it("服务商压根没有视觉模型时,开着这个开关也不放行", async () => {
		// DeepSeek 官方接口一个视觉模型都没有。只看 enableVision 就放行的话,
		// 图会一路带到模型那儿才被拒 —— 白烧一次请求,报错还来自上游、看不懂。
		// 这个开关对 DeepSeek 本来就该是不可选的,守卫这里是最后一道。
		const { app, deps } = await makeDeps({
			provider: "deepseek",
			enableVision: true,
			visionModel: "",
		});
		const id = await newConv(app);
		const img = await saveChatImage(deps.store.bootstrap.dataDir, PNG, "image/png");

		const res = await chat(app, id, { message: "这是什么", images: [img] });

		expect(res.status).toBe(400);
		expect(chatStatelessStream).not.toHaveBeenCalled();
	});

	it("但配了视觉副模型就照常放行 —— 副模型正是给 DeepSeek 这种主力准备的", async () => {
		const { app, deps } = await makeDeps({ provider: "deepseek", visionModel: "qwen-vl" });
		const id = await newConv(app);
		const img = await saveChatImage(deps.store.bootstrap.dataDir, PNG, "image/png");

		const res = await chat(app, id, { message: "这是什么", images: [img] });

		expect(res.status).toBe(200);
		expect(H.lastImageUrls).toHaveLength(1);
	});
});

describe("发图 — 两条路都没开", () => {
	it("明确拒绝并指向那两个设置,绝不静默吞掉", async () => {
		const { app, deps } = await makeDeps({ visionModel: "" });
		const id = await newConv(app);
		const img = await saveChatImage(deps.store.bootstrap.dataDir, PNG, "image/png");

		const res = await chat(app, id, { message: "这是什么", images: [img] });

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.err).toMatch(/视觉模型|看图/);
		// 没配就一次都不该往模型那儿跳 —— 跳了也是白烧钱,图根本带不过去。
		expect(chatStatelessStream).not.toHaveBeenCalled();
	});

	it("不带图时照常聊 —— 这个限制只管附件", async () => {
		const { app } = await makeDeps({ visionModel: "" });
		const id = await newConv(app);

		const res = await chat(app, id, { message: "在吗" });

		expect(res.status).toBe(200);
		expect(chatStatelessStream).toHaveBeenCalledTimes(1);
	});
});

describe("发图 — 配了视觉模型", () => {
	it("交给模型的是 base64 data URL,不是本地链接", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const img = await saveChatImage(deps.store.bootstrap.dataDir, PNG, "image/png");

		await chat(app, id, { message: "这是什么", images: [img] });

		expect(H.lastImageUrls).toHaveLength(1);
		expect(H.lastImageUrls?.[0]?.startsWith("data:image/png;base64,")).toBe(true);
		// 视觉服务商在公网,给它一个 localhost 链接等于什么都没给。
		expect(H.lastImageUrls?.[0]).not.toContain("http");
	});

	it("非法 id 与盘上不存在的 id 都不混进去", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const real = await saveChatImage(deps.store.bootstrap.dataDir, PNG, "image/png");

		await chat(app, id, {
			message: "看看",
			images: ["../../bn.config.yaml", "0123456789abcdef0123456789abcdef.png", real],
		});

		expect(H.lastImageUrls).toHaveLength(1);
	});

	it("超过 4 张直接拒 —— 与动态点评那条路同口径", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const imgs: string[] = [];
		for (let i = 0; i < 5; i++) {
			imgs.push(await saveChatImage(deps.store.bootstrap.dataDir, PNG, "image/png"));
		}

		const res = await chat(app, id, { message: "看看", images: imgs });

		expect(res.status).toBe(400);
		expect(chatStatelessStream).not.toHaveBeenCalled();
	});

	it("图 id 落进消息,重开会话还看得见", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const img = await saveChatImage(deps.store.bootstrap.dataDir, PNG, "image/png");

		await chat(app, id, { message: "这是什么", images: [img] });

		const conv = (await (await app.request(`/conversations/${id}`)).json()) as any;
		const userMsg = conv.conversation.messages.find((m: any) => m.role === "user");
		expect(userMsg.images).toEqual([img]);
	});
});

describe("删会话 — 图跟着走", () => {
	it("删掉带图的会话,它的图从磁盘上消失", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const img = await saveChatImage(deps.store.bootstrap.dataDir, PNG, "image/png");
		await chat(app, id, { message: "这是什么", images: [img] });

		await app.request(`/conversations/${id}`, { method: "DELETE" });

		expect(await readdir(chatImageDir(deps.store.bootstrap.dataDir))).toEqual([]);
	});

	it("删别的会话不误伤本会话的图", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const keep = await newConv(app);
		const drop = await newConv(app);
		const keepImg = await saveChatImage(deps.store.bootstrap.dataDir, PNG, "image/png");
		const dropImg = await saveChatImage(deps.store.bootstrap.dataDir, PNG, "image/png");
		await chat(app, keep, { message: "留着", images: [keepImg] });
		await chat(app, drop, { message: "删掉", images: [dropImg] });

		await app.request(`/conversations/${drop}`, { method: "DELETE" });

		expect(await readdir(chatImageDir(deps.store.bootstrap.dataDir))).toEqual([keepImg]);
	});
});
