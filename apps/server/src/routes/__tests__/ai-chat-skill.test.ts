/**
 * 聊天路由 × 女仆技能。
 *
 * 两条路都要能走通(ADR-0001 决策 7):
 * - **模型自选** —— `load_skill` 挂进日常聊天的工具表,女仆读 description 自己挑;
 * - **主人打斜杠** —— 请求带上 `skill`,正文当场追加进 system、工具面当场收窄,
 *   **不白烧一轮**让模型再去调一次工具。
 *
 * 还有两条边界:
 * ① **皮肤工坊里没有技能。** 那个窗口连人格都不带(专职模式),技能正文串进去
 *    只会跟工坊的 system 打架。
 * ② **不论哪条路,消息流里都要留一枚痕迹**(决策 9)。模型自选时尤其要紧 ——
 *    否则女仆莫名换了套说法,主人不知为何。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 wire 载荷,不为测试再造一遍类型

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createConversationStore } from "../../ai/conversation-store.js";
import { MaidSkillStore } from "../../maid-skills/store.js";
import { SkinStore } from "../../skins/store.js";
import { createAiRoute } from "../ai.js";
import type { RouteDeps } from "../types.js";

const H = vi.hoisted(() => ({
	lastOpts: null as any,
}));

const chatStatelessStream = vi.fn(async (_messages: unknown, opts: any) => {
	H.lastOpts = opts;
	opts.onDelta("好的主人~");
	return "好的主人~";
});

vi.mock("@bilibili-notify/ai", () => ({
	CommentaryGenerator: class {
		chat = vi.fn();
		chatStateless = vi.fn();
		chatStatelessStream = chatStatelessStream;
		generateRaw = vi.fn();
		stop = vi.fn();
	},
}));

const toolNames = (): string[] =>
	((H.lastOpts?.extraTools ?? []) as Array<{ definition: { function: { name: string } } }>).map(
		(t) => t.definition.function.name,
	);

async function makeDeps() {
	const dataDir = await mkdtemp(join(tmpdir(), "bn-skillchat-"));
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const deps = {
		store: {
			getGlobals: () => ({
				defaults: {
					ai: { enabled: true, activeProfile: "p", providers: { p: { vision: { model: "vm" } } } },
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
	const skillStore = new MaidSkillStore({ dir: join(dataDir, "maid-skills") });
	await skillStore.ensureReady();
	const app = createAiRoute(deps, { skinStore, skillStore });
	return { app, skillStore };
}

/** 说一句话,把 SSE 抽干(落盘在流的末尾)并把原文交出来。 */
async function say(
	app: ReturnType<typeof createAiRoute>,
	body: Record<string, unknown> = {},
	init: Record<string, unknown> = {},
): Promise<{ status: number; text: string; convId: string }> {
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
		body: JSON.stringify({ message: "本周谁最勤奋", ...body }),
	});
	return { status: res.status, text: await res.text(), convId: conv.conversation.id };
}

const MINE = {
	name: "my-skill",
	description: "主人自己写的一条",
	disableModelInvocation: false,
	allowedTools: ["list_subscriptions"],
	body: "先列订阅,别的什么都不查。",
};

beforeEach(() => {
	H.lastOpts = null;
	chatStatelessStream.mockClear();
});

describe("模型自选", () => {
	it("日常聊天 → load_skill 挂在工具表上", async () => {
		const { app } = await makeDeps();
		await say(app);
		expect(toolNames()).toContain("load_skill");
	});

	it("工坊里硬塞一个 skill → 400,不静默吞掉", async () => {
		// 静默忽略的话,主人看着自己打的 `/weekly-report` 发了出去、女仆却当普通话
		// 回了一句,消息流里连一枚痕迹都没有 —— 他没法看出技能压根没生效。
		const { app, skillStore } = await makeDeps();
		await skillStore.create(MINE);
		const res = await say(app, { skill: "my-skill" }, { mode: "skin" });
		expect(res.status).toBe(400);
		expect(chatStatelessStream).not.toHaveBeenCalled();
	});

	it("皮肤工坊 → 一把技能工具都没有,只剩 create_skin", async () => {
		// 工坊是专职窗口:人格不带、B 站只读工具不带。技能正文串进去只会跟
		// 工坊自己的 system 打架。
		const { app } = await makeDeps();
		await say(app, { message: "做套皮肤" }, { mode: "skin" });
		expect(toolNames()).toEqual(["create_skin"]);
	});
});

describe("主人打斜杠", () => {
	it("带 skill → 正文当场进 system,工具面当场收窄", async () => {
		const { app, skillStore } = await makeDeps();
		await skillStore.create(MINE);
		await say(app, { skill: "my-skill" });

		expect(H.lastOpts.systemSuffix).toContain("先列订阅,别的什么都不查。");
		expect(H.lastOpts.restrictTools).toContain("list_subscriptions");
		// 主人已经点名了,不必再留一把「读技能」让模型自己去调 —— 那是白烧一轮。
		expect(H.lastOpts.restrictTools).not.toContain("load_skill");
	});

	it("技能没声明 allowed-tools → 不收窄,工具面照旧", async () => {
		const { app, skillStore } = await makeDeps();
		await skillStore.create({ ...MINE, allowedTools: undefined });
		await say(app, { skill: "my-skill" });
		expect(H.lastOpts.systemSuffix).toContain("先列订阅");
		expect(H.lastOpts.restrictTools).toBeUndefined();
	});

	it("退出了模型自选的那些,斜杠照样打得动 —— 那是它唯一的路", async () => {
		const { app, skillStore } = await makeDeps();
		await skillStore.create({ ...MINE, disableModelInvocation: true });
		await say(app, { skill: "my-skill" });
		expect(H.lastOpts.systemSuffix).toContain("先列订阅");
	});

	it("带一个不存在的技能名 → 400,不静默当普通聊天发出去", async () => {
		// 静默发出去的话,主人以为在用技能、其实在跟模型说一句它不认识的暗号 ——
		// 老 `/锐评 只看这三个人` 栽的正是这个坑。
		const { app } = await makeDeps();
		const res = await say(app, { skill: "nope" });
		expect(res.status).toBe(400);
		expect(chatStatelessStream).not.toHaveBeenCalled();
	});

	it("留下一枚调用痕迹 —— SSE 里有、落盘也有", async () => {
		const { app, skillStore } = await makeDeps();
		await skillStore.create(MINE);
		const { text, convId } = await say(app, { skill: "my-skill" });

		expect(text).toContain("load_skill");
		const conv = (await (await app.request(`/conversations/${convId}`)).json()) as any;
		const assistant = conv.conversation.messages.at(-1);
		expect(assistant.tools).toEqual([
			expect.objectContaining({ name: "load_skill", args: { name: "my-skill" }, ok: true }),
		]);
	});
});
