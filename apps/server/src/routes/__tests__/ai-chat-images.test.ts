/**
 * 女仆 AI 聊天 —— 图片附件那一路。
 *
 * 附件存在图库里,会话的 `images` 装图库引用(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗)。四条契约,按要紧程度排:
 *
 * ① **没配视觉模型就发图 → 明确拒绝。** 独立端没有「图直接下挂给主模型」那条路
 *    (`enableVision` 在这一端恒为 false),所以视觉模型没配时图片是彻底没人看的。
 *    静默吞掉的话,主人会看着女仆一本正经地聊天却对图只字不提,以为是模型笨 ——
 *    而真正的原因在另一个页面的一个空输入框里。
 *
 * ② **交给模型的是 data URL,不是链接。** 视觉服务商在公网,拉不到主人本地的
 *    `http://localhost:9000/api/images/xxx`。这跟 B 站动态里的图完全不同,
 *    那些本来就是公网可达的,所以那条路直接传 URL。
 *
 * ③ **发出去的图要续期。** 图按内容起名、有一天的新图宽限期;这一问要用它、会话要引用它,
 *    所以发送时让它回到宽限期里(`keep`),形状不对的、图库里已经没了的静默跳过。
 *
 * ④ **图的生灭归图库。** 删会话不再直接删图;会话被修剪、老消息被截掉、传了没发 —— 这几处
 *    今天都会漏图,现在由图库清扫收走:没有任何会话再引用的图,过了宽限期被删,别的会话
 *    还引用着的同一张图不删。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型

import { mkdtemp, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { distinctPng, makeChatImages, putImage } from "../../__tests__/support/chat-images.js";
import { createConversationStore } from "../../ai/conversation-store.js";
import { IMAGE_GRACE_MS } from "../../images/image-store.js";
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

async function makeDeps(
	opts: {
		visionModel?: string;
		enableVision?: boolean;
		provider?: string;
		maxConversations?: number;
		maxMessages?: number;
	} = {},
) {
	dataDir = await mkdtemp(join(tmpdir(), "bn-chatimg-"));
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const conversationStore = createConversationStore({
		dataRoot: dataDir,
		logger,
		...(opts.maxConversations ? { maxConversations: opts.maxConversations } : {}),
		...(opts.maxMessages ? { maxMessages: opts.maxMessages } : {}),
	});
	const { imageStore, chatImages } = makeChatImages(dataDir, conversationStore);
	const deps = {
		store: {
			getGlobals: () => ({
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
							enableThinking: false,
							thinkingLevel: "medium",
							extraParams: "",
							enableVision: opts.enableVision ?? false,
							vision: { baseUrl: "", apiKey: "", model: opts.visionModel ?? "" },
						},
					},
				},
			}),
			getTargets: () => [],
			getSubscriptions: () => [],
		},
		runtime: {
			dataRoot: dataDir,
			serviceCtx: { logger },
			conversationStore,
			imageStore,
			chatImages,
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

/** 存第 `n` 张图进图库,回引用。不同的 `n` 是不同的图(图库按内容起名)。 */
const saveImage = (deps: RouteDeps, n = 1) => putImage(deps.runtime.chatImages, distinctPng(n));

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
		const img = await saveImage(deps);

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
		const img = await saveImage(deps);

		const res = await chat(app, id, { message: "这是什么", images: [img] });

		// 叫主人去配置(打开看图 / 填视觉模型),等是等不好的:409 not_configured。
		expect(res.status).toBe(409);
		expect(((await res.json()) as any).code).toBe("not_configured");
		expect(chatStatelessStream).not.toHaveBeenCalled();
	});

	it("但配了视觉副模型就照常放行 —— 副模型正是给 DeepSeek 这种主力准备的", async () => {
		const { app, deps } = await makeDeps({ provider: "deepseek", visionModel: "qwen-vl" });
		const id = await newConv(app);
		const img = await saveImage(deps);

		const res = await chat(app, id, { message: "这是什么", images: [img] });

		expect(res.status).toBe(200);
		expect(H.lastImageUrls).toHaveLength(1);
	});
});

describe("发图 — 两条路都没开", () => {
	it("明确拒绝并指向那两个设置,绝不静默吞掉", async () => {
		const { app, deps } = await makeDeps({ visionModel: "" });
		const id = await newConv(app);
		const img = await saveImage(deps);

		const res = await chat(app, id, { message: "这是什么", images: [img] });

		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.code).toBe("not_configured");
		expect(body.message).toMatch(/视觉模型|看图/);
		// 这句是按设置页控件名指路的,两个引号里的名字不许被润色 —— 与 FIELD_LABELS 一字不差。
		expect(body.message).toContain("「图片理解」");
		expect(body.message).toContain("「主模型支持看图」");
		expect(body.message).toContain("「视觉模型 ID」");
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
		const img = await saveImage(deps);

		await chat(app, id, { message: "这是什么", images: [img] });

		expect(H.lastImageUrls).toHaveLength(1);
		expect(H.lastImageUrls?.[0]?.startsWith("data:image/png;base64,")).toBe(true);
		// 视觉服务商在公网,给它一个 localhost 链接等于什么都没给。
		expect(H.lastImageUrls?.[0]).not.toContain("http");
	});

	it("形状不对(穿越尝试、老格式的 id)与图库里没有的引用都不混进去,不连累请求本身", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const real = await saveImage(deps);

		const res = await chat(app, id, {
			message: "看看",
			images: [
				"../../bn.config.yaml",
				"0123456789abcdef0123456789abcdef.png",
				`${"0".repeat(64)}.png`,
				real,
			],
		});

		expect(res.status).toBe(200);
		expect(H.lastImageUrls).toHaveLength(1);
		const conv = (await (await app.request(`/conversations/${id}`)).json()) as any;
		expect(conv.conversation.messages[0].images).toEqual([real]);
	});

	it("同一张图报了两遍只算一张", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const img = await saveImage(deps);

		await chat(app, id, { message: "看看", images: [img, img] });

		expect(H.lastImageUrls).toHaveLength(1);
		const conv = (await (await app.request(`/conversations/${id}`)).json()) as any;
		expect(conv.conversation.messages[0].images).toEqual([img]);
	});

	it("mime 随引用的扩展名走,不是别的:jpg 的引用交给模型的是 image/jpeg", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const jpg = await putImage(deps.runtime.chatImages, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]));

		await chat(app, id, { message: "看看", images: [jpg] });

		expect(jpg).toMatch(/\.jpg$/);
		expect(H.lastImageUrls?.[0]?.startsWith("data:image/jpeg;base64,")).toBe(true);
	});

	it("超过 4 张直接拒 —— 与动态点评那条路同口径", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const imgs: string[] = [];
		for (let i = 0; i < 5; i++) {
			imgs.push(await saveImage(deps, i));
		}

		const res = await chat(app, id, { message: "看看", images: imgs });

		expect(res.status).toBe(400);
		expect(((await res.json()) as any).code).toBe("invalid");
		expect(chatStatelessStream).not.toHaveBeenCalled();
	});

	it("图 id 落进消息,重开会话还看得见", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const img = await saveImage(deps);

		await chat(app, id, { message: "这是什么", images: [img] });

		const conv = (await (await app.request(`/conversations/${id}`)).json()) as any;
		const userMsg = conv.conversation.messages.find((m: any) => m.role === "user");
		expect(userMsg.images).toEqual([img]);
	});
});

/**
 * 历史里的图。
 *
 * 拼历史时只带 content,`m.images` 整个被丢掉 —— 女仆不是「忘了」那张图,是**从来
 * 没看见过**,于是下一句就请主人再传一遍。主人自己传的那张往往正是整段对话的题眼
 * (做皮肤的参考图、要认的截图),让他一遍遍重传是把最不该重复的一步重复。
 */
describe("接着聊 — 上一次的图捎上", () => {
	it("这一问没带图、历史里有 → 把最近那次的图捎上", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const img = await saveImage(deps);
		await chat(app, id, { message: "这是什么", images: [img] });

		H.lastImageUrls = null;
		await chat(app, id, { message: "那按这个配色做一套" });

		expect(H.lastImageUrls).toHaveLength(1);
		expect(`${H.lastImageUrls?.[0]}`.startsWith("data:image/png;base64,")).toBe(true);
	});

	it("捎上的图**不**落进这一问的 images —— 那一问并没有真的带图", async () => {
		// 落盘要如实:记成带了图,删会话时的图片回收、以及重开会话的缩略图都会跟着错。
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const img = await saveImage(deps);
		await chat(app, id, { message: "这是什么", images: [img] });
		await chat(app, id, { message: "接着说" });

		const conv = (await (await app.request(`/conversations/${id}`)).json()) as any;
		const asks = conv.conversation.messages.filter((m: any) => m.role === "user");
		expect(asks[0].images).toEqual([img]);
		expect(asks[1].images ?? []).toEqual([]);
	});

	it("这一问自己带了图 → 就用新的,不翻旧账", async () => {
		// 主人重新挑了图,说明他要问的就是这张;把旧图一并端上去只会分散注意力,
		// 还要多付一份钱。
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const older = await saveImage(deps, 1);
		await chat(app, id, { message: "这是什么", images: [older] });
		const newer = await saveImage(deps, 2);
		await chat(app, id, { message: "那这张呢", images: [newer] });

		expect(H.lastImageUrls).toHaveLength(1);
	});

	it("只捎**最近**那一次 —— 不是把整段对话的图全端上来", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const a = await saveImage(deps, 1);
		const b = await saveImage(deps, 2);
		await chat(app, id, { message: "第一张", images: [a] });
		await chat(app, id, { message: "第二张", images: [b] });

		H.lastImageUrls = null;
		await chat(app, id, { message: "接着说" });
		expect(H.lastImageUrls).toHaveLength(1);
	});

	it("一张图都没聊过 → 什么都不捎,别凭空造一个 imageUrls", async () => {
		const { app } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		await chat(app, id, { message: "在吗" });
		await chat(app, id, { message: "还在吗" });
		expect(H.lastImageUrls ?? []).toEqual([]);
	});
});

/**
 * 发出去的图续期:图在上传时进了新图宽限期(一天),这一问用它、会话要引用它,所以发送时刷新修改时间。
 * 不续的话,上传到发送隔得久的图(宽限期早过、又没有会话引用它)会在发送与落盘之间被清扫收走。
 */
describe("发送时续期", () => {
	it("老图被这一问用到 → 修改时间刷新,回到宽限期里", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const img = await saveImage(deps);
		const path = join(dataDir, "images", img);
		const old = new Date(Date.now() - 10 * IMAGE_GRACE_MS);
		await utimes(path, old, old);

		await chat(app, id, { message: "这是什么", images: [img] });

		expect((await stat(path)).mtimeMs).toBeGreaterThan(Date.now() - IMAGE_GRACE_MS);
	});
});

/**
 * 图的生灭归图库:会话不直接删图,图没人引用了才由清扫收走。下面三处是今天就会漏图的地方,
 * 各钉一条;再各钉一条「别的会话仍引用着同一张图就不删」。
 */
describe("图的清理 — 交给图库清扫", () => {
	/** 清扫在宽限期之后:一天多以后。 */
	const afterGrace = () => new Date(Date.now() + IMAGE_GRACE_MS + 60 * 60 * 1000);
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	it("删会话不再直接删图:图还在,清扫要等宽限期过了、又没人引用才收走", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const id = await newConv(app);
		const img = await saveImage(deps);
		await chat(app, id, { message: "这是什么", images: [img] });

		await app.request(`/conversations/${id}`, { method: "DELETE" });

		const imageStore = deps.runtime.imageStore;
		expect(await imageStore.read(img)).toBeDefined();
		expect((await imageStore.sweep({ now: new Date(Date.now() + 60_000) })).removed).toEqual([]);
		expect((await imageStore.sweep({ now: afterGrace() })).removed).toEqual([img]);
	});

	it("删掉一个会话,别的会话仍引用着的同一张图不删", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl" });
		const keep = await newConv(app);
		const drop = await newConv(app);
		const shared = await saveImage(deps, 1);
		const onlyDropped = await saveImage(deps, 2);
		await chat(app, keep, { message: "留着", images: [shared] });
		await chat(app, drop, { message: "删掉", images: [shared, onlyDropped] });

		await app.request(`/conversations/${drop}`, { method: "DELETE" });
		const report = await deps.runtime.imageStore.sweep({ now: afterGrace() });

		expect(report.removed).toEqual([onlyDropped]);
		expect(await deps.runtime.imageStore.read(shared)).toBeDefined();
	});

	it("泄漏① 建会话时修剪掉旧会话:它的图没人引用了,被清扫收走;被留下的会话引用的同一张不删", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl", maxConversations: 2 });
		const oldest = await newConv(app);
		const shared = await saveImage(deps, 1);
		const onlyOldest = await saveImage(deps, 2);
		await chat(app, oldest, { message: "最老的", images: [shared, onlyOldest] });
		await sleep(5);
		const newer = await newConv(app);
		await chat(app, newer, { message: "留下的", images: [shared] });
		await sleep(5);

		await newConv(app); // 上限 2:最老的那个被修剪
		const report = await deps.runtime.imageStore.sweep({ now: afterGrace() });

		expect(await deps.runtime.conversationStore.get(oldest)).toBeNull();
		expect(report.removed).toEqual([onlyOldest]);
		expect(await deps.runtime.imageStore.read(shared)).toBeDefined();
	});

	it("泄漏② 单会话超过上限,最老的消息被截掉:只在被截消息里出现的图被收走,新消息还引用的不删", async () => {
		const { app, deps } = await makeDeps({ visionModel: "qwen-vl", maxMessages: 2 });
		const id = await newConv(app);
		const shared = await saveImage(deps, 1);
		const onlyOld = await saveImage(deps, 2);
		await chat(app, id, { message: "第一问", images: [shared, onlyOld] });

		await chat(app, id, { message: "第二问", images: [shared] }); // 一问一答两条:第一问连同它的图被截掉
		const kept = (await deps.runtime.conversationStore.get(id))?.messages ?? [];
		const report = await deps.runtime.imageStore.sweep({ now: afterGrace() });

		expect(kept.map((m) => m.content)).toContain("第二问");
		expect(kept.map((m) => m.content)).not.toContain("第一问");
		expect(report.removed).toEqual([onlyOld]);
		expect(await deps.runtime.imageStore.read(shared)).toBeDefined();
	});
});
