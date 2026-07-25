/**
 * 单元测试 — `createConversationStore`(真实 tmpdir FS)。
 *
 * 守护契约:
 *   - 一会话一个 JSON,create / get / list / appendMessages / remove 往返
 *   - list 只回元信息(不驮消息体),按 updatedAt 倒序 —— 侧栏「最近」就靠这个序
 *   - 标题由**首条用户消息**推导并只定一次,之后再聊不会把标题改掉
 *   - 上限裁剪:单会话消息数、会话总数,超了删最旧的
 *   - 坏文件 / 缺文件不炸整个列表 —— 一条脏 JSON 不该让侧栏整个空掉
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ConversationStore, createConversationStore } from "../conversation-store.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dataDir: string;
let logger: ReturnType<typeof makeLogger>;
let store: ConversationStore;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-aichat-"));
	logger = makeLogger();
	store = createConversationStore({ dataDir, logger });
});
afterEach(() => {
	vi.useRealTimers();
});

/**
 * 凡是断言「谁更近」的测试都得用假时钟推着走。
 *
 * 落盘的时间戳只到毫秒,而三次 create/append 在真实时钟下往往落在同一毫秒里 ——
 * 那时排序是并列的,断言通过与否全看运气。推进时间把「更近」变成真的更近。
 */
const useClockStart = Date.parse("2026-07-24T12:00:00.000Z");
function useClock(startMs = useClockStart) {
	vi.useFakeTimers();
	vi.setSystemTime(startMs);
	return () => {
		vi.advanceTimersByTime(1000);
	};
}

describe("ConversationStore — 往返", () => {
	it("create 出来的空会话能被 get 回来", async () => {
		const created = await store.create();
		const got = await store.get(created.id);
		expect(got).toEqual(created);
		expect(got?.messages).toEqual([]);
	});

	it("新会话有占位标题,不是空串 —— 侧栏得有东西可显示", async () => {
		const created = await store.create();
		expect(created.title.length).toBeGreaterThan(0);
	});

	it("appendMessages 追加后按序读回", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [
			{ role: "user", content: "问1" },
			{ role: "assistant", content: "答1" },
		]);
		const got = await store.get(c.id);
		expect(got?.messages.map((m) => [m.role, m.content])).toEqual([
			["user", "问1"],
			["assistant", "答1"],
		]);
	});

	it("每条消息带 id 与时间戳 —— 前端要拿 id 当 key", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [{ role: "user", content: "问" }]);
		const m = (await store.get(c.id))?.messages[0];
		expect(m?.id).toBeTruthy();
		expect(m?.ts).toBeTruthy();
	});

	it("get 不存在的会话 → null,不抛", async () => {
		expect(await store.get("没这个会话")).toBeNull();
	});

	it("remove 删掉后就 get 不到了;重复删返回 false", async () => {
		const c = await store.create();
		expect(await store.remove(c.id)).toBe(true);
		expect(await store.get(c.id)).toBeNull();
		expect(await store.remove(c.id)).toBe(false);
	});

	it("appendMessages 到不存在的会话 → null,不凭空造一个", async () => {
		expect(await store.appendMessages("没这个会话", [{ role: "user", content: "x" }])).toBeNull();
	});
});

describe("ConversationStore — 标题", () => {
	it("首条用户消息决定标题", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [{ role: "user", content: "本周谁最勤奋" }]);
		expect((await store.get(c.id))?.title).toBe("本周谁最勤奋");
	});

	it("标题只定一次 —— 第二轮提问不会把侧栏那条改掉", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [{ role: "user", content: "第一个问题" }]);
		await store.appendMessages(c.id, [{ role: "user", content: "完全不同的第二个问题" }]);
		expect((await store.get(c.id))?.title).toBe("第一个问题");
	});

	it("过长的首问被截断,不让侧栏被一整段话撑爆", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [{ role: "user", content: "啊".repeat(200) }]);
		const title = (await store.get(c.id))?.title ?? "";
		expect(title.length).toBeLessThanOrEqual(30);
	});

	it("助手先说话不算数 —— 标题只认用户那句", async () => {
		const c = await store.create();
		const placeholder = c.title;
		await store.appendMessages(c.id, [{ role: "assistant", content: "主人好呀" }]);
		expect((await store.get(c.id))?.title).toBe(placeholder);
	});

	it("首问只有空白 → 保持占位标题,不落一个看不见的标题", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [{ role: "user", content: "   \n  " }]);
		expect((await store.get(c.id))?.title).toBe(c.title);
	});
});

describe("ConversationStore — setTitle", () => {
	/**
	 * AI 起完标题后回写。首问截断只是**兜底**:主人每次都以「你好」开场,那
	 * 一列就全叫「你好」,等于没有标题。
	 */
	it("改掉标题,消息一条不动", async () => {
		const conv = await store.create();
		await store.appendMessages(conv.id, [
			{ role: "user", content: "你好" },
			{ role: "assistant", content: "在的" },
		]);

		const updated = await store.setTitle(conv.id, "打招呼");
		expect(updated?.title).toBe("打招呼");
		expect(updated?.messages.map((m) => m.content)).toEqual(["你好", "在的"]);
	});

	it("不碰 updatedAt —— 起个标题不算「聊过」,不该把它顶到侧栏最前", async () => {
		// 顶上去的话,主人明明在聊别的会话,列表却因为一次后台改名重新排了序。
		//
		// **必须推假时钟**:时间戳只到毫秒,真实时钟下 append 与 setTitle 通常落在
		// 同一毫秒,那时「没动」和「动了」写出来一模一样,断言恒真 —— 假绿。
		const tick = useClock();
		const conv = await store.create();
		await store.appendMessages(conv.id, [{ role: "user", content: "问" }]);
		const before = (await store.get(conv.id))?.updatedAt;

		tick();
		await store.setTitle(conv.id, "新标题");
		expect((await store.get(conv.id))?.updatedAt).toBe(before);
	});

	it("空白标题不落 —— 侧栏那行会变成一片空白", async () => {
		const conv = await store.create();
		await store.appendMessages(conv.id, [{ role: "user", content: "本周谁最勤奋" }]);

		expect(await store.setTitle(conv.id, "   ")).toBeNull();
		expect((await store.get(conv.id))?.title).toBe("本周谁最勤奋");
	});

	it("会话不存在 → null,不凭空造一个", async () => {
		expect(await store.setTitle("没这个人", "标题")).toBeNull();
	});

	it("落一次就打上 autoTitled —— 起名只做一次的判据靠它,不靠「是不是第一轮」", async () => {
		// 早先用「刚聊完第一轮」当判据,结果是:功能上线前就存在的那些会话,
		// 里面早有好几条消息,永远不满足条件,标题永远停在「你好」。
		const conv = await store.create();
		await store.appendMessages(conv.id, [{ role: "user", content: "你好" }]);
		expect((await store.get(conv.id))?.autoTitled).toBeFalsy();

		await store.setTitle(conv.id, "打招呼");
		expect((await store.get(conv.id))?.autoTitled).toBe(true);
	});

	it("旧会话文件没这个字段 → 当作还没起过,不是当作已起过", async () => {
		// 反过来的话,主人现有的会话一个都轮不上,新功能对他毫无作用。
		const conv = await store.create();
		expect(conv.autoTitled).toBeFalsy();
	});
});

describe("ConversationStore — list", () => {
	it("按 updatedAt 倒序,最近聊过的排最前", async () => {
		const tick = useClock();
		const a = await store.create();
		tick();
		const b = await store.create();
		// 先动 a,再动 b → b 应排前面。注意 a 是**先创建**的,若排序错用了
		// createdAt,这里就会把 a 顶到前面 —— 这一条同时钉住「按聊天时间排,
		// 不是按创建时间排」。
		tick();
		await store.appendMessages(a.id, [{ role: "user", content: "旧" }]);
		tick();
		await store.appendMessages(b.id, [{ role: "user", content: "新" }]);
		const ids = (await store.list()).map((m) => m.id);
		expect(ids[0]).toBe(b.id);
		expect(ids[1]).toBe(a.id);
	});

	it("只回元信息,不驮消息体 —— 侧栏不需要整段对话", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [{ role: "user", content: "问" }]);
		const meta = (await store.list())[0];
		expect(meta).toBeTruthy();
		expect(meta).not.toHaveProperty("messages");
		expect(meta?.messageCount).toBe(1);
	});

	it("目录还不存在时 → 空列表,不抛", async () => {
		// 全新安装、一次都没聊过。
		const fresh = createConversationStore({ dataDir: join(dataDir, "never-written"), logger });
		expect(await fresh.list()).toEqual([]);
	});

	it("一条脏 JSON 不该让整个侧栏空掉,只跳过它", async () => {
		const good = await store.create();
		await mkdir(join(dataDir, "ai", "chat"), { recursive: true });
		await writeFile(join(dataDir, "ai", "chat", "broken.json"), "{不是 json", "utf8");
		const ids = (await store.list()).map((m) => m.id);
		expect(ids).toEqual([good.id]);
		expect(logger.warn).toHaveBeenCalled();
	});
});

describe("ConversationStore — 上限裁剪", () => {
	it("单会话消息数超上限 → 丢最旧的,保留最近的", async () => {
		const s = createConversationStore({ dataDir, logger, maxMessages: 4 });
		const c = await s.create();
		for (const n of [1, 2, 3, 4, 5, 6]) {
			await s.appendMessages(c.id, [{ role: "user", content: `第${n}条` }]);
		}
		const contents = (await s.get(c.id))?.messages.map((m) => m.content);
		expect(contents).toEqual(["第3条", "第4条", "第5条", "第6条"]);
	});

	it("会话总数超上限 → create 时删掉最旧的那个", async () => {
		const tick = useClock();
		const s = createConversationStore({ dataDir, logger, maxConversations: 2 });
		const a = await s.create();
		await s.appendMessages(a.id, [{ role: "user", content: "最旧" }]);
		tick();
		const b = await s.create();
		await s.appendMessages(b.id, [{ role: "user", content: "中间" }]);
		tick();
		const c = await s.create();

		const ids = (await s.list()).map((m) => m.id);
		expect(ids).toHaveLength(2);
		expect(ids).toContain(c.id);
		expect(ids).not.toContain(a.id);
	});

	it("同一毫秒里连开新对话,也绝不会删掉刚建的那个", async () => {
		// 时钟不推进 → 三个会话的 updatedAt 字节级相同,排序退到 id 兜底。
		// 预置的两个 id 以 'z' 开头,必然排在任何 uuid(只含 0-9a-f)之前,于是
		// 新建的那个稳稳落在「最旧」的位置上 —— 修剪若不把它摘出去,就会出现
		// 「点了新对话,对话没了」。用可控 id 构造,免得靠随机 uuid 的运气。
		const now = new Date(useClockStart).toISOString();
		await mkdir(join(dataDir, "ai", "chat"), { recursive: true });
		for (const id of [
			"zzzzzzzz-0000-4000-8000-000000000001",
			"zzzzzzzz-0000-4000-8000-000000000002",
		]) {
			await writeFile(
				join(dataDir, "ai", "chat", `${id}.json`),
				JSON.stringify({ id, title: "旧", createdAt: now, updatedAt: now, messages: [] }),
				"utf8",
			);
		}
		useClock();
		const s = createConversationStore({ dataDir, logger, maxConversations: 2 });
		const newest = await s.create();

		const ids = (await s.list()).map((m) => m.id);
		expect(ids).toHaveLength(2);
		expect(ids).toContain(newest.id);
	});
});
