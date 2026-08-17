/**
 * 聊天路由 × 皮肤工坊模式。
 *
 * 写能力**只在皮肤模式里存在**(主人拍板的隔离):日常聊天那个窗口的上下文里有
 * B 站动态正文、图片里的字这些外部可控文本,写工具挂在那儿就是给注入面开口。
 * 切到皮肤工坊之后反过来:人格不带、B 站只读工具不带,模型手上只有 `create_skin`
 * 一把。联网搜索是后来放行的那个例外(做「某部作品风格」的皮肤得先查得到配色),
 * 按主人那颗胶囊走。
 *
 * 另一条要紧的契约是**预算跟着请求走**:一轮最多两套,而「一轮」= 一次聊天请求。
 * 工具要是建在路由装配时,那把计数器会跨请求累加 —— 聊到第三句就再也做不了皮肤,
 * 而且得重启才恢复。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 wire 载荷,不为测试再造一遍类型

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createConversationStore } from "../../ai/conversation-store.js";
import { SkinStore } from "../../skins/store.js";
import { createAiRoute } from "../ai.js";
import type { RouteDeps } from "../types.js";

const DARK_SKIN = {
	schemaVersion: 1,
	name: "夜航灯",
	modes: { dark: { colors: { accent: "#00e5ff" } } },
};

const H = vi.hoisted(() => ({
	/** 最后一次聊天调用收到的整份 opts —— 工具、system、开关都在里面。 */
	lastOpts: null as any,
}));

const chatStatelessStream = vi.fn(async (_messages: unknown, opts: any) => {
	H.lastOpts = opts;
	opts.onDelta("好的主人~");
	return "好的主人~";
});

const lastTools = (): any[] | null => H.lastOpts?.extraTools ?? null;

/** 皮肤设计师那一跳(嵌套调用)—— 直接回一份合法 manifest。 */
const generateRaw = vi.fn(async (_s: string, _u: string) => JSON.stringify(DARK_SKIN));

vi.mock("@bilibili-notify/ai", () => ({
	CommentaryGenerator: class {
		chat = vi.fn();
		chatStateless = vi.fn();
		chatStatelessStream = chatStatelessStream;
		generateRaw = generateRaw;
		stop = vi.fn();
	},
}));

async function makeDeps(opts: { skins?: boolean } = {}) {
	const dataDir = await mkdtemp(join(tmpdir(), "bn-skinchat-"));
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const deps = {
		store: {
			// 桶里的 vision.model 填着,附件才过得了「女仆看不见图」那道闸。
			getGlobals: () => ({
				defaults: {
					ai: {
						enabled: true,
						activeProfile: "p",
						providers: { p: { vision: { model: "vm" } } },
					},
				},
			}),
			getTargets: () => [],
			bootstrap: { dataDir },
		},
		runtime: {
			serviceCtx: { logger },
			conversationStore: createConversationStore({ dataDir, logger }),
			engines: { api: {}, commentary: { chatStatelessStream, generateRaw } },
		},
	} as unknown as RouteDeps;
	const skinStore = new SkinStore({ skinsDir: join(dataDir, "skins") });
	await skinStore.init();
	const app = createAiRoute(deps, opts.skins === false ? undefined : { skinStore });
	return { app, skinStore, dataDir };
}

async function say(
	app: ReturnType<typeof createAiRoute>,
	body: Record<string, unknown> = {},
): Promise<Response> {
	const conv = (await (await app.request("/conversations", { method: "POST" })).json()) as any;
	const res = await app.request(`/conversations/${conv.conversation.id}/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "给我做套皮肤", ...body }),
	});
	// 流抽干,handler 才算跑完(落盘在流的末尾)。
	await res.text();
	return res;
}

const inSkinMode = (app: ReturnType<typeof createAiRoute>, body: Record<string, unknown> = {}) =>
	say(app, { mode: "skin", ...body });

beforeEach(() => {
	H.lastOpts = null;
	chatStatelessStream.mockClear();
	generateRaw.mockClear();
});

describe("日常聊天模式(缺省)", () => {
	it("一个写工具都不挂 —— 这个窗口只读", async () => {
		const { app } = await makeDeps();
		await say(app);

		expect(lastTools()).toBeNull();
	});

	it("人格与内置只读工具照旧 —— 不碰这条路的现状", async () => {
		const { app } = await makeDeps();
		await say(app);

		expect(H.lastOpts.systemPrompt).toBeUndefined();
		expect(H.lastOpts.builtinTools).toBeUndefined();
	});
});

describe("皮肤工坊模式", () => {
	it("工具表只有 create_skin", async () => {
		const { app } = await makeDeps();
		await inSkinMode(app);

		expect(lastTools()?.map((t: any) => t.definition.function.name)).toEqual(["create_skin"]);
	});

	it("人格不带、内置只读工具不带 —— 隔离的全部意义在这两条", async () => {
		const { app } = await makeDeps();
		await inSkinMode(app);

		expect(H.lastOpts.builtinTools).toBe(false);
		expect(String(H.lastOpts.systemPrompt)).toContain("皮肤");
	});

	it("搜索开关照样透传 —— 做「某部作品风格」的皮肤得先查得到那部作品的配色", async () => {
		const { app } = await makeDeps();
		await inSkinMode(app, { search: true });

		expect(H.lastOpts.webSearch).toBe(true);
	});

	it("没开搜索就还是不开 —— 这个模式不偷偷替主人打开联网", async () => {
		const { app } = await makeDeps();
		await inSkinMode(app);

		expect(H.lastOpts.webSearch).toBe(false);
	});

	it("主人贴的图接到了工具上 —— 壁纸的唯一来源就是它", async () => {
		const { app, skinStore, dataDir } = await makeDeps();
		const id = `${"a".repeat(32)}.png`;
		await mkdir(join(dataDir, "assets", "chat"), { recursive: true });
		await writeFile(join(dataDir, "assets", "chat", id), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		generateRaw.mockResolvedValueOnce(
			JSON.stringify({
				schemaVersion: 1,
				name: "夜航灯",
				modes: { dark: { wallpaper: { image: "assets/wallpaper.png" } } },
			}),
		);

		await inSkinMode(app, { images: [id] });
		await lastTools()?.[0].execute({ brief: "配这张图", wallpaper: "true" });

		const [skin] = await skinStore.list();
		expect(await skinStore.listAssets(skin?.id ?? "")).toEqual(["assets/wallpaper.png"]);
	});

	it("没装皮肤库却点了皮肤模式 → 400,不静默退回普通聊天", async () => {
		// 静默降级的话,主人会在一个根本做不了皮肤的窗口里一直说「做套皮肤」,
		// 而女仆一本正经地打太极。
		const { app } = await makeDeps({ skins: false });
		const res = await inSkinMode(app);

		expect(res.status).toBe(400);
	});

	it("工具真能落盘:执行一次,皮肤进了库", async () => {
		const { app, skinStore } = await makeDeps();
		await inSkinMode(app);
		await lastTools()?.[0].execute({ brief: "赛博朋克,暗色" });

		expect((await skinStore.list()).map((s) => s.name)).toEqual(["夜航灯"]);
	});

	it("预算按请求重置 —— 上一轮做满两套,下一轮照样能做", async () => {
		const { app } = await makeDeps();
		await inSkinMode(app);
		const first = lastTools()?.[0];
		await first.execute({ brief: "一套" });
		await first.execute({ brief: "两套" });
		await expect(first.execute({ brief: "三套" })).rejects.toThrow();

		await inSkinMode(app);
		await expect(lastTools()?.[0].execute({ brief: "新一轮" })).resolves.toContain("夜航灯");
	});
});
