/**
 * 0.x 的女仆对话经迁移器进新代(`migration/conversations.ts`,⑥c)。0.x 早期的会话文件里没有「面孔」那三格
 * (`mode` / `persona` / `skinTarget`),由迁移器按工具痕迹补齐:用过 `create_skin` 或卡片工坊的工具 → 工坊;
 * 用过卡片工坊的工具 → 卡片,否则 dashboard;人格缺省带着;写着的值永远优先。会话库开机只认带齐三格的文件、
 * 读时不推断。
 *
 * 前两组用例原先钉在会话库的读时推断上(`ai/__tests__/conversation-store.test.ts` 的「会话的模式与人格」与「卡片
 * 皮肤工坊」里那几条老会话),读时推断删掉时抄到这里,**期望值一个没改**:只是摆数据的位置从「代目录里直接写一份
 * 老会话」换成「第 0 代(`ai/chat/<id>.json`)→ 迁移器 → 在新代上开真的会话库读回来」。原件里「只在读的时候认,
 * 不回写盘」那半句的前提被推翻了(现在迁移器就是那个回写的人),抄过来时没带。
 *
 * 末一组是迁移器自己的钉:新代里不留老形状(直接读新代的文件,不经会话库);迁两遍和迁一遍一样;消息坏了的
 * 文件原样留着、会话库照旧跳过它。
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	CONVERSATIONS_DIR,
	type ConversationStore,
	createConversationStore,
} from "../../ai/conversation-store.js";
import { createChatAttachmentMigrator } from "../chat-attachments.js";
import { migrateConversationFiles } from "../conversations.js";
import { useZeroSandbox } from "./support.js";

const sandbox = useZeroSandbox("bn-zero-conversations-");

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** 在新代上开一次真的会话库。 */
function openStore(logger = makeLogger()): ConversationStore {
	return createConversationStore({ dataRoot: sandbox.target, logger });
}

/** 迁一代,再在新代上开会话库。 */
async function migrateAndOpen(): Promise<ConversationStore> {
	await sandbox.migrate();
	return openStore();
}

/** 往第 0 代摆一份老会话(`ai/chat/<id>.json`)。 */
const placeChat = (id: string, body: unknown) => sandbox.placeZero(`ai/chat/${id}.json`, body);

describe("会话的模式与人格", () => {
	it("老会话文件没这两个字段 → 按聊天 + 有人格读,别让主人的旧会话集体变脸", async () => {
		await placeChat("legacy", {
			id: "legacy",
			title: "老会话",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			messages: [{ role: "user", content: "老问题" }],
		});

		const store = await migrateAndOpen();
		expect((await store.get("legacy"))?.mode).toBe("chat");
		expect((await store.get("legacy"))?.persona).toBe(true);
		const [meta] = await store.list();
		expect(meta?.mode).toBe("chat");
		expect(meta?.persona).toBe(true);
	});

	/**
	 * 上线前的会话文件里没有 mode,一律按「聊天」读 —— 于是主人一屋子做过皮肤的老会话在侧栏里一块牌都不挂,
	 * 看不出哪场是工坊的(真机反馈,2026-08-19)。
	 *
	 * 但工具痕迹是铁证:`create_skin` **只有皮肤工坊挂得出来**(日常聊天那个窗口一个写工具都没有)。有它就是工坊,
	 * 这不是猜。
	 */
	it("老会话里有 create_skin 痕迹 → 认成工坊", async () => {
		await placeChat("oldskin", {
			id: "oldskin",
			title: "雷姆主题皮肤设计",
			createdAt: "2026-08-17T00:00:00.000Z",
			updatedAt: "2026-08-17T00:00:00.000Z",
			messages: [
				{ id: "u", role: "user", content: "做套皮肤", ts: "2026-08-17T00:00:00.000Z" },
				{
					id: "a",
					role: "assistant",
					content: "好",
					ts: "2026-08-17T00:00:01.000Z",
					tools: [{ name: "create_skin", args: {}, ok: true }],
				},
			],
		});

		const store = await migrateAndOpen();
		expect((await store.get("oldskin"))?.mode).toBe("skin");
		const [meta] = await store.list();
		expect(meta?.mode).toBe("skin");
	});

	it("只调过只读工具的老会话仍是聊天 —— 别把查订阅认成做皮肤", async () => {
		await placeChat("oldchat", {
			id: "oldchat",
			title: "查看订阅的 UP 主",
			createdAt: "2026-08-17T00:00:00.000Z",
			updatedAt: "2026-08-17T00:00:00.000Z",
			messages: [
				{
					id: "a",
					role: "assistant",
					content: "好",
					ts: "2026-08-17T00:00:01.000Z",
					tools: [{ name: "list_subscriptions", args: {}, ok: true }],
				},
			],
		});

		const store = await migrateAndOpen();
		expect((await store.get("oldchat"))?.mode).toBe("chat");
	});

	it("盘上写着 mode 就照它走,推断不许翻案", async () => {
		await placeChat("explicit", {
			id: "explicit",
			title: "明写着是聊天",
			createdAt: "2026-08-17T00:00:00.000Z",
			updatedAt: "2026-08-17T00:00:00.000Z",
			mode: "chat",
			persona: true,
			// 现实里凑不出这种文件,但「显式值优先」这条得钉死:哪天推断改宽了,
			// 主人明确建成聊天的会话不该被它改判。
			messages: [
				{
					id: "a",
					role: "assistant",
					content: "好",
					ts: "2026-08-17T00:00:01.000Z",
					tools: [{ name: "create_skin", args: {}, ok: true }],
				},
			],
		});

		const store = await migrateAndOpen();
		expect((await store.get("explicit"))?.mode).toBe("chat");
	});
});

describe("卡片皮肤工坊", () => {
	async function legacy(id: string, toolName: string): Promise<void> {
		await placeChat(id, {
			id,
			title: "老工坊",
			createdAt: "2026-08-17T00:00:00.000Z",
			updatedAt: "2026-08-17T00:00:00.000Z",
			mode: "skin",
			persona: false,
			messages: [
				{
					id: "a",
					role: "assistant",
					content: "好",
					ts: "2026-08-17T00:00:01.000Z",
					tools: [{ name: toolName, args: {}, ok: true }],
				},
			],
		});
	}

	it("文件里缺这一格 → 按工具痕迹认:有卡片工坊的工具就是 card,否则 dashboard", async () => {
		await legacy("cardish", "write_card");
		await legacy("dashish", "create_skin");

		const store = await migrateAndOpen();
		expect((await store.get("cardish"))?.skinTarget).toBe("card");
		expect((await store.get("dashish"))?.skinTarget).toBe("dashboard");
	});

	it("连 mode 都没有的老文件,有卡片工坊的痕迹也认成工坊", async () => {
		await placeChat("nomode", {
			id: "nomode",
			title: "x",
			createdAt: "2026-08-17T00:00:00.000Z",
			updatedAt: "2026-08-17T00:00:00.000Z",
			messages: [
				{
					id: "a",
					role: "assistant",
					content: "好",
					ts: "2026-08-17T00:00:01.000Z",
					tools: [{ name: "set_block", args: {}, ok: true }],
				},
			],
		});

		const store = await migrateAndOpen();
		const conv = await store.get("nomode");
		expect(conv?.mode).toBe("skin");
		expect(conv?.skinTarget).toBe("card");
	});
});

describe("迁移器自己的钉", () => {
	const TARGET_CHATS = () => join(sandbox.target, ...CONVERSATIONS_DIR);
	const BASE = {
		title: "老会话",
		createdAt: "2026-08-17T00:00:00.000Z",
		updatedAt: "2026-08-17T00:00:00.000Z",
	} as const;
	const tool = (name: string) => ({
		id: "a",
		role: "assistant",
		content: "好",
		ts: "2026-08-17T00:00:01.000Z",
		tools: [{ name, args: {}, ok: true }],
	});

	/** 摆一批缺法各异的老会话:全缺(聊天)、做过界面皮肤、做过卡片、只缺 skinTarget、已经齐全的。 */
	async function placeLegacyChats(): Promise<void> {
		await placeChat("plain", { id: "plain", ...BASE, messages: [{ role: "user", content: "问" }] });
		await placeChat("dash", { id: "dash", ...BASE, messages: [tool("create_skin")] });
		await placeChat("card", { id: "card", ...BASE, messages: [tool("write_card")] });
		await placeChat("half", {
			id: "half",
			...BASE,
			mode: "skin",
			persona: false,
			messages: [tool("set_block")],
		});
		await placeChat("full", {
			id: "full",
			...BASE,
			mode: "chat",
			persona: true,
			skinTarget: "dashboard",
			messages: [{ role: "user", content: "问" }],
		});
	}

	/** 新代会话目录里的每个文件(文件名 → 原文),按名排好。 */
	async function snapshot(): Promise<[string, string][]> {
		return Promise.all(
			(await readdir(TARGET_CHATS()))
				.sort()
				.map(
					async (name) =>
						[name, await readFile(join(TARGET_CHATS(), name), "utf8")] as [string, string],
				),
		);
	}

	it("新代里不留老形状:每份会话文件 mode / persona / skinTarget 三格齐全", async () => {
		await placeLegacyChats();
		const report = await sandbox.migrate();
		// 已经齐全的那份不动,别的四份被改写。
		expect(report.rewritten.sort()).toEqual([
			"ai/conversations/card.json",
			"ai/conversations/dash.json",
			"ai/conversations/half.json",
			"ai/conversations/plain.json",
		]);

		const files = await snapshot();
		expect(files.map(([name]) => name)).toEqual([
			"card.json",
			"dash.json",
			"full.json",
			"half.json",
			"plain.json",
		]);
		const faces = Object.fromEntries(
			files.map(([name, text]) => {
				const conv = JSON.parse(text) as Record<string, unknown>;
				expect(conv.mode).toBeDefined();
				expect(conv.mode).not.toBeNull();
				expect(conv.persona).toBeDefined();
				expect(conv.persona).not.toBeNull();
				expect(conv.skinTarget).toBeDefined();
				expect(conv.skinTarget).not.toBeNull();
				return [name, [conv.mode, conv.persona, conv.skinTarget]];
			}),
		);
		expect(faces).toEqual({
			"plain.json": ["chat", true, "dashboard"],
			"dash.json": ["skin", true, "dashboard"],
			"card.json": ["skin", true, "card"],
			"half.json": ["skin", false, "card"],
			"full.json": ["chat", true, "dashboard"],
		});
	});

	it("迁两遍和迁一遍一样:对新代再迁一次回 [],文件字节不变", async () => {
		await placeLegacyChats();
		const report = await sandbox.migrate();
		expect(report.rewritten).toContain("ai/conversations/plain.json");

		const before = await snapshot();
		expect(before).toHaveLength(5);

		const attachments = createChatAttachmentMigrator({
			zeroDir: join(sandbox.zero, "assets", "chat"),
			imagesDir: join(sandbox.target, "images"),
		});
		expect(await migrateConversationFiles(sandbox.target, attachments)).toEqual([]);
		expect(await snapshot()).toEqual(before);
	});

	it("消息坏了又缺 mode 的文件:迁移器原样留着,会话库照旧跳过它(别的会话照常列出来)", async () => {
		const broken = JSON.stringify({ id: "broken", ...BASE, messages: [null] });
		await sandbox.placeZeroText("ai/chat/broken.json", broken);
		await placeChat("fine", { id: "fine", ...BASE, messages: [{ role: "user", content: "问" }] });

		const report = await sandbox.migrate();
		expect(report.rewritten).toEqual(["ai/conversations/fine.json"]);
		expect(await readFile(join(TARGET_CHATS(), "broken.json"), "utf8")).toBe(broken);

		const logger = makeLogger();
		const store = openStore(logger);
		expect(await store.get("broken")).toBeNull();
		expect((await store.list()).map((c) => c.id)).toEqual(["fine"]);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("broken.json"));
	});
});

describe("卡片皮肤不迁,会话里对它们的引用剥掉、文字保留(ADR-0022 决策 4)", () => {
	it("账本与每条回复碰过的皮肤都剥掉;正文、工具痕迹、面孔原样", async () => {
		const tools = [{ name: "write_card", summary: "写进了 skin-9" }];
		await sandbox.placeZero("ai/chat/workshop.json", {
			id: "workshop",
			title: "做张卡",
			mode: "skin",
			persona: false,
			skinTarget: "card",
			cardSkinLedger: { owned: ["skin-9"], forks: { "skin-1": "skin-9" } },
			messages: [
				{ role: "user", content: "做一张粉色的" },
				{
					role: "assistant",
					content: "做好啦,叫「樱花」",
					tools,
					cardSkins: [{ id: "skin-9", kinds: ["dynamic"] }],
				},
			],
		});

		await sandbox.migrate();

		const file = JSON.parse(
			await readFile(join(sandbox.target, ...CONVERSATIONS_DIR, "workshop.json"), "utf8"),
		);
		expect(file.cardSkinLedger).toBeUndefined();
		expect(file.messages.map((m: { cardSkins?: unknown }) => m.cardSkins)).toEqual([
			undefined,
			undefined,
		]);
		expect(file).toMatchObject({
			mode: "skin",
			persona: false,
			skinTarget: "card",
			messages: [
				{ role: "user", content: "做一张粉色的" },
				{ role: "assistant", content: "做好啦,叫「樱花」", tools },
			],
		});
	});
});
