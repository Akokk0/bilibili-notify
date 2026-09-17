/**
 * 聊天路由 × 卡片皮肤工坊(ADR-0015 决策 11–23 与它们的 🔗)。
 *
 * 钉的是装配这一层:
 * - 建会话时选的「推送卡片」开局即锁,之后每条消息都挂卡片工坊那一套:八把工具、它自己的
 *   system、不带内置只读工具、不带人格、轮数上限单独放宽;dashboard 工坊原样不动;
 * - 账本经会话存储**当场落盘** —— 跨两次请求、甚至中途失败的那一轮之后,改别人的皮肤
 *   都只复制一份(决策 18 的 🔗);
 * - 回复消息带着这一轮碰过的皮肤(预览块照它画),写工具的痕迹不落整份 blocks。
 *
 * 引擎是替身,但它**真的去调注入进来的工具** —— 皮肤库与会话存储都是真的。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 wire 载荷与替身入参,不为测试再造一遍类型

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_CARD_WORKSHOP_TOOLS as T } from "@bilibili-notify/contract";
import { DEFAULT_CARD_SKIN_ID } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createConversationStore } from "../../ai/conversation-store.js";
import { CARD_WORKSHOP_MAX_TOOL_ROUNDS } from "../../card-skins/chat-tools.js";
import { CardSkinStore } from "../../card-skins/store.js";
import { SkinStore } from "../../skins/store.js";
import { createAiRoute } from "../ai.js";
import type { RouteDeps } from "../types.js";

type Call = { name: string; args: Record<string, unknown> };

const H = vi.hoisted(() => ({
	lastOpts: null as any,
	/** 这一轮「模型」要调的工具,按先后。 */
	calls: [] as Call[],
	/** 调完工具之后是否让这一轮失败。 */
	failAfterTools: false,
}));

/** 照 generator 的归一规矩:标量成字符串、对象 / 数组成 JSON。 */
function flat(args: Record<string, unknown>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(args).map(([k, v]) => [
			k,
			typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v),
		]),
	);
}

const chatStatelessStream = vi.fn(async (_messages: unknown, opts: any) => {
	H.lastOpts = opts;
	const byName = new Map((opts.extraTools ?? []).map((t: any) => [t.definition.function.name, t]));
	for (const [i, call] of H.calls.entries()) {
		const tool: any = byName.get(call.name);
		const args = flat(call.args);
		opts.onToolEvent?.({ phase: "start", id: `0-${i}`, name: call.name, args });
		let ok = true;
		try {
			await tool.execute(args);
		} catch {
			ok = false;
		}
		opts.onToolEvent?.({ phase: "end", id: `0-${i}`, ok });
	}
	if (H.failAfterTools) throw new Error("上游断了");
	opts.onDelta("好的");
	return "好的";
});

vi.mock("@bilibili-notify/ai", () => ({
	CommentaryGenerator: class {
		chatStatelessStream = chatStatelessStream;
	},
}));

async function makeDeps(opts: { cards?: boolean } = {}) {
	const dataDir = await mkdtemp(join(tmpdir(), "bn-cardchat-"));
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const deps = {
		store: {
			getGlobals: () => ({
				defaults: {
					ai: { enabled: true, activeProfile: "p", providers: { p: { vision: { model: "" } } } },
					cardSkin: DEFAULT_CARD_SKIN_ID,
				},
			}),
			getTargets: () => [],
			bootstrap: { dataDir },
		},
		runtime: {
			serviceCtx: { logger },
			conversationStore: createConversationStore({ dataDir, logger }),
			engines: { api: {}, commentary: { chatStatelessStream } },
		},
	} as unknown as RouteDeps;
	const skinStore = new SkinStore({ skinsDir: join(dataDir, "skins") });
	await skinStore.init();
	const cardSkinStore = new CardSkinStore({ dir: join(dataDir, "card-skins") });
	await cardSkinStore.init();
	const shot = vi.fn(async () => null);
	const app = createAiRoute(deps, {
		skinStore,
		...(opts.cards === false ? {} : { cardSkinStore, cardSkinShot: shot }),
	});
	return { app, cardSkinStore, dataDir, shot };
}

async function open(app: ReturnType<typeof createAiRoute>, init: object): Promise<any> {
	const res = await app.request("/conversations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(init),
	});
	return ((await res.json()) as any).conversation;
}

const CARD = { mode: "skin", skinTarget: "card" };

/** 说一句,抽干流,回 SSE 事件。 */
async function say(
	app: ReturnType<typeof createAiRoute>,
	id: string,
	body: Record<string, unknown> = {},
): Promise<{ status: number; events: Array<{ event: string; data: any }> }> {
	const res = await app.request(`/conversations/${id}/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "做一套", ...body }),
	});
	const text = await res.text();
	const events = text
		.split("\n\n")
		.map((frame) => {
			const event = frame.match(/^event: (.*)$/m)?.[1];
			const data = frame.match(/^data: (.*)$/m)?.[1];
			return event && data ? { event, data: JSON.parse(data) } : null;
		})
		.filter((e): e is { event: string; data: any } => e !== null);
	return { status: res.status, events };
}

const COVER = {
	id: "cover",
	kind: "builtin",
	builtin: "cover",
	grid: { row: 1, column: 1, span: 12 },
};
const TOUCH_DEFAULT: Call = {
	name: T.setBlock,
	args: {
		skin: DEFAULT_CARD_SKIN_ID,
		kind: "live",
		block: "cover",
		css: '[data-bn="self"]{opacity:.9}',
	},
};

beforeEach(() => {
	H.lastOpts = null;
	H.calls = [];
	H.failAfterTools = false;
	chatStatelessStream.mockClear();
});

describe("建会话", () => {
	it("收下「推送卡片」并回在响应里", async () => {
		const { app } = await makeDeps();
		expect((await open(app, CARD)).skinTarget).toBe("card");
		expect((await open(app, { mode: "skin" })).skinTarget).toBe("dashboard");
	});
});

describe("卡片工坊的装配", () => {
	// 人格不在场靠的是整段 system 被顶掉(与 dashboard 工坊同一条路),不是 persona 那一格。
	it("八把工具、自己的 system、不带内置工具、轮数上限放宽", async () => {
		const { app } = await makeDeps();
		const conv = await open(app, CARD);
		await say(app, conv.id);
		const names = H.lastOpts.extraTools.map((t: any) => t.definition.function.name).sort();
		expect(names).toEqual(Object.values(T).sort());
		expect(H.lastOpts.systemPrompt).toMatch(/卡片皮肤工坊/);
		expect(H.lastOpts.builtinTools).toBe(false);
		expect(H.lastOpts.maxToolRounds).toBe(CARD_WORKSHOP_MAX_TOOL_ROUNDS);
	});

	it("dashboard 工坊原样:只有 create_skin、老 system、不放宽轮数", async () => {
		const { app } = await makeDeps();
		const conv = await open(app, { mode: "skin" });
		await say(app, conv.id);
		const names = H.lastOpts.extraTools.map((t: any) => t.definition.function.name);
		expect(names).toEqual(["create_skin"]);
		expect(H.lastOpts.systemPrompt).not.toMatch(/卡片皮肤工坊/);
		expect(H.lastOpts.maxToolRounds).toBeUndefined();
	});

	it("没装卡片皮肤库 → 400,不静默退回别的工坊", async () => {
		const { app } = await makeDeps({ cards: false });
		const conv = await open(app, CARD);
		const { status } = await say(app, conv.id);
		expect(status).toBe(400);
		expect(chatStatelessStream).not.toHaveBeenCalled();
	});

	it("工坊里点名技能照旧拒绝", async () => {
		const { app } = await makeDeps();
		const conv = await open(app, CARD);
		const { status } = await say(app, conv.id, { skill: "weekly" });
		expect(status).toBe(400);
	});

	it("截图口接到了 look_card 上", async () => {
		const { app, shot } = await makeDeps();
		const conv = await open(app, CARD);
		H.calls = [{ name: T.lookCard, args: { skin: DEFAULT_CARD_SKIN_ID, kind: "sc" } }];
		await say(app, conv.id);
		expect(shot).toHaveBeenCalledWith(DEFAULT_CARD_SKIN_ID, "sc");
	});
});

describe("改别人的皮肤只复制一份", () => {
	it("跨两次请求:第二句再改默认皮肤,落到第一句复制出的那份上", async () => {
		const { app, cardSkinStore } = await makeDeps();
		const conv = await open(app, CARD);
		H.calls = [TOUCH_DEFAULT];
		await say(app, conv.id);
		const after1 = cardSkinStore.list().length;
		expect(after1).toBe(2);

		H.calls = [
			{ ...TOUCH_DEFAULT, args: { ...TOUCH_DEFAULT.args, css: '[data-bn="self"]{opacity:.5}' } },
		];
		await say(app, conv.id);
		expect(cardSkinStore.list()).toHaveLength(after1);
		const copy = cardSkinStore.list().find((s) => !s.builtin);
		const cover = cardSkinStore
			.get(copy?.id ?? "")
			?.cards.live?.blocks.find((b) => b.id === "cover");
		expect(cover?.css).toContain(".5");
	});

	it("中途失败的那一轮之后,下一句也不再复制", async () => {
		const { app, cardSkinStore } = await makeDeps();
		const conv = await open(app, CARD);
		H.calls = [TOUCH_DEFAULT];
		H.failAfterTools = true;
		const first = await say(app, conv.id);
		expect(first.events.at(-1)?.event).toBe("error");
		expect(cardSkinStore.list()).toHaveLength(2);

		H.failAfterTools = false;
		await say(app, conv.id);
		expect(cardSkinStore.list()).toHaveLength(2);
	});
});

describe("落盘", () => {
	it("回复带着这一轮碰过的皮肤与卡种", async () => {
		const { app } = await makeDeps();
		const conv = await open(app, CARD);
		H.calls = [{ name: T.setSkinMeta, args: { name: "樱花粉" } }];
		const first = await say(app, conv.id);
		const created = first.events.find((e) => e.event === "done")?.data.reply.cardSkins;
		expect(created).toHaveLength(1);
		const id = created[0].id;

		H.calls = [
			{ name: T.writeCard, args: { skin: id, kind: "sc", width: 400, blocks: [] } },
			{ name: T.writeCard, args: { skin: id, kind: "live", width: 600, blocks: [COVER] } },
		];
		const second = await say(app, conv.id);
		const reply = second.events.find((e) => e.event === "done")?.data.reply;
		expect(reply.cardSkins).toEqual([{ id, kinds: ["sc", "live"] }]);
	});

	it("没碰皮肤的回复不带这个字段", async () => {
		const { app } = await makeDeps();
		const conv = await open(app, CARD);
		H.calls = [{ name: T.listSkins, args: {} }];
		const { events } = await say(app, conv.id);
		expect(events.find((e) => e.event === "done")?.data.reply.cardSkins).toBeUndefined();
	});

	it("写工具的痕迹只留认得出是哪块的那几项,整份 blocks / CSS 不进会话文件,也不上流", async () => {
		const { app, dataDir } = await makeDeps();
		const conv = await open(app, CARD);
		H.calls = [{ name: T.setSkinMeta, args: { name: "樱花粉" } }];
		const first = await say(app, conv.id);
		const id = first.events.find((e) => e.event === "done")?.data.reply.cardSkins[0].id;

		const marker = "#abcdef";
		H.calls = [
			{
				name: T.writeCard,
				args: {
					skin: id,
					kind: "live",
					width: 600,
					css: `[data-bn="glass"]{color:${marker}}`,
					blocks: [{ ...COVER, css: `[data-bn="self"]{color:${marker}}` }],
				},
			},
		];
		const { events } = await say(app, conv.id);
		const start = events.find((e) => e.event === "tool" && e.data.phase === "start");
		expect(start?.data.args).toEqual({ skin: id, kind: "live" });

		const file = await readFile(join(dataDir, "ai", "chat", `${conv.id}.json`), "utf8");
		expect(file).not.toContain(marker);
		const trace = JSON.parse(file).messages.at(-1).tools[0];
		expect(trace).toMatchObject({ name: T.writeCard, args: { skin: id, kind: "live" }, ok: true });
	});
});
