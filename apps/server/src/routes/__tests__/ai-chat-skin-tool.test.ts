/**
 * 聊天路由 × `create_skin` —— 「做一套皮肤」这条写能力挂进聊天的接线。
 *
 * 两条要紧的契约:
 * - **挂载是有条件的**:装配时给了皮肤库才挂。没给(老装配 / 只测聊天的用例)
 *   照旧一个工具都不多,写能力不会凭空出现。
 * - **预算跟着请求走**:一轮对话最多两套,而「一轮」= 一次聊天请求。工具要是
 *   建在路由装配时,那把计数器会跨请求累加 —— 聊到第三句就再也做不了皮肤,
 *   而且重启才恢复。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 wire 载荷,不为测试再造一遍类型

import { mkdtemp } from "node:fs/promises";
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
	/** 最后一次聊天调用收到的注入工具。 */
	lastExtraTools: null as any,
}));

const chatStatelessStream = vi.fn(async (_messages: unknown, opts: any) => {
	H.lastExtraTools = opts.extraTools ?? null;
	opts.onDelta("好的主人~");
	return "好的主人~";
});

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
		store: { getGlobals: () => ({ defaults: { ai: { enabled: true } } }), getTargets: () => [] },
		runtime: {
			serviceCtx: { logger },
			conversationStore: createConversationStore({ dataDir, logger }),
			engines: { api: {}, commentary: { chatStatelessStream, generateRaw } },
		},
	} as unknown as RouteDeps;
	const skinStore = new SkinStore({ skinsDir: join(dataDir, "skins") });
	await skinStore.init();
	const app = createAiRoute(deps, opts.skins === false ? undefined : { skinStore });
	return { app, skinStore };
}

async function say(app: ReturnType<typeof createAiRoute>): Promise<void> {
	const conv = (await (await app.request("/conversations", { method: "POST" })).json()) as any;
	const res = await app.request(`/conversations/${conv.conversation.id}/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "给我做套皮肤" }),
	});
	// 流抽干,handler 才算跑完(落盘在流的末尾)。
	await res.text();
}

beforeEach(() => {
	H.lastExtraTools = null;
	chatStatelessStream.mockClear();
	generateRaw.mockClear();
});

describe("聊天 × create_skin 接线", () => {
	it("装配时给了皮肤库 → 聊天带上 create_skin", async () => {
		const { app } = await makeDeps();
		await say(app);

		expect(H.lastExtraTools?.map((t: any) => t.definition.function.name)).toEqual(["create_skin"]);
	});

	it("没给皮肤库 → 一个注入工具都不挂", async () => {
		const { app } = await makeDeps({ skins: false });
		await say(app);

		expect(H.lastExtraTools).toBeNull();
	});

	it("工具真能落盘:执行一次,皮肤进了库", async () => {
		const { app, skinStore } = await makeDeps();
		await say(app);
		await H.lastExtraTools[0].execute({ brief: "赛博朋克,暗色" });

		expect((await skinStore.list()).map((s) => s.name)).toEqual(["夜航灯"]);
	});

	it("预算按请求重置 —— 上一轮做满两套,下一轮照样能做", async () => {
		const { app } = await makeDeps();
		await say(app);
		const first = H.lastExtraTools[0];
		await first.execute({ brief: "一套" });
		await first.execute({ brief: "两套" });
		await expect(first.execute({ brief: "三套" })).rejects.toThrow();

		await say(app);
		await expect(H.lastExtraTools[0].execute({ brief: "新一轮" })).resolves.toContain("夜航灯");
	});
});
