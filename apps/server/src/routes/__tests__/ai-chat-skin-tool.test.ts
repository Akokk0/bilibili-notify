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
	/** 建会话时定下的面孔 —— 模式与人格开局锁定,不再随每条消息走。 */
	init: Record<string, unknown> = {},
): Promise<Response> {
	const conv = (await (
		await app.request("/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(init),
		})
	).json()) as any;
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
	say(app, body, { mode: "skin" });

/** 开一场工坊会话,把 id 留在手上 —— 要连说两句时得是同一场。 */
async function openSkinConv(app: ReturnType<typeof createAiRoute>): Promise<string> {
	const res = await app.request("/conversations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mode: "skin" }),
	});
	return ((await res.json()) as any).conversation.id as string;
}

/** 往已有的那场里再说一句。流抽干才算跑完(落盘在流的末尾)。 */
async function sayIn(
	app: ReturnType<typeof createAiRoute>,
	id: string,
	body: Record<string, unknown>,
): Promise<void> {
	const res = await app.request(`/conversations/${id}/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "…", ...body }),
	});
	await res.text();
}

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

	it("这一问空手 → 拿得到上一问那张图,而不是回一句「你没贴图」", async () => {
		// 装配处这一问空手时会捎上最近一次的图喂给视觉模型 —— 她**看得见**那张。
		// 做壁纸那把工具若只认这一问的附件,主人贴完图聊两句再说「用刚才那张当背景」,
		// 撞上的就是「她描述得出那张图、一动手却说你没贴图」。
		const { app, skinStore, dataDir } = await makeDeps();
		const id = `${"b".repeat(32)}.png`;
		await mkdir(join(dataDir, "assets", "chat"), { recursive: true });
		await writeFile(join(dataDir, "assets", "chat", id), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

		const conv = await openSkinConv(app);
		await sayIn(app, conv, { message: "看看这张图", images: [id] });
		generateRaw.mockResolvedValueOnce(
			JSON.stringify({
				schemaVersion: 1,
				name: "夜航灯",
				modes: { dark: { wallpaper: { image: "assets/wallpaper.png" } } },
			}),
		);
		await sayIn(app, conv, { message: "用刚才那张当背景" });
		await lastTools()?.[0].execute({ brief: "配那张图", wallpaper: "true" });

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

/**
 * 面孔归**会话**所有,不归每条消息所有。
 *
 * 主人拍板的「锁定」:开局选定,整场对话不再改。落到服务端就是一句话 —— 皮肤模式
 * 与人格开关一律从会话记录里读,请求体说什么都不算数。这不只是界面上少个 picker:
 * 写能力(create_skin)只在皮肤模式里存在,让请求体决定模式,等于把开那道口子的
 * 钥匙交给了每一条消息。
 */
describe("面孔从会话读,不从请求体读", () => {
	it("会话建成皮肤工坊 → 这条消息不说模式也照样是工坊", async () => {
		const { app } = await makeDeps();
		await say(app, {}, { mode: "skin" });

		expect(lastTools()?.map((t: any) => t.definition.function.name)).toEqual(["create_skin"]);
	});

	it("聊天会话里塞一句 mode:skin → 不作数,写工具一个都不给", async () => {
		const { app } = await makeDeps();
		await say(app, { mode: "skin" });

		expect(lastTools()).toBeNull();
		expect(H.lastOpts.systemPrompt).toBeUndefined();
	});

	it("会话选了无人格 → 那一档传给引擎", async () => {
		const { app } = await makeDeps();
		await say(app, {}, { persona: false });

		expect(H.lastOpts.persona).toBe(false);
	});

	it("缺省会话是有人格的 —— 老会话与没选过的都落在这一侧", async () => {
		const { app } = await makeDeps();
		await say(app);

		expect(H.lastOpts.persona ?? true).toBe(true);
	});

	it("建会话时的面孔回在响应里 —— 侧栏那一行的 label 指着它", async () => {
		const { app } = await makeDeps();
		const res = await app.request("/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "skin", persona: false }),
		});
		const body = (await res.json()) as any;

		expect(body.conversation.mode).toBe("skin");
		expect(body.conversation.persona).toBe(false);
	});
});
