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

import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import {
	CONVERSATIONS_DIR,
	type ConversationStore,
	createConversationStore,
} from "../conversation-store.js";

// 落盘函数前的闸默认敞开;只有「close」那组用例才 hold(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dataDir: string;
let logger: ReturnType<typeof makeLogger>;
let store: ConversationStore;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-aichat-"));
	logger = makeLogger();
	store = createConversationStore({ dataRoot: dataDir, logger });
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

	/**
	 * 工具痕迹跟着回复一起落盘,而不是只活在那次流里。
	 *
	 * 只在流里显示的话,`done` 一到、真身把在途副本换下来的那一刻,几条小条就会
	 * 凭空消失 —— 跟「回复吐完闪一下」是同一类观感事故,而且刷新之后再也看不到
	 * 她当时查过什么。
	 */
	it("助手消息的工具痕迹原样存下来", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [
			{ role: "user", content: "我订了谁" },
			{
				role: "assistant",
				content: "查到 3 位",
				tools: [{ name: "list_subscriptions", args: {}, ok: true }],
			},
		]);
		const got = await store.get(c.id);
		expect(got?.messages[1]?.tools).toEqual([{ name: "list_subscriptions", args: {}, ok: true }]);
	});

	it("痕迹自带的标签(label / argText)随痕迹落盘、原样读回 —— 存下来的字不跟着以后改名", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [
			{ role: "user", content: "查一下" },
			{
				role: "assistant",
				content: "查到了",
				tools: [
					{
						name: "get_user_info",
						args: { uid: "1", name: "咩栗" },
						ok: true,
						label: "查看 UP 主资料",
						argText: "咩栗",
					},
				],
			},
		]);
		expect((await store.get(c.id))?.messages[1]?.tools).toEqual([
			{
				name: "get_user_info",
				args: { uid: "1", name: "咩栗" },
				ok: true,
				label: "查看 UP 主资料",
				argText: "咩栗",
			},
		]);
	});

	it("失败那一次的原因(message)随痕迹落盘、原样读回", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [
			{ role: "user", content: "查一下" },
			{
				role: "assistant",
				content: "没查到",
				tools: [
					{
						name: "get_user_info",
						args: { uid: "1" },
						ok: false,
						message: "获取用户信息失败: 请求被拦截",
					},
				],
			},
		]);
		expect((await store.get(c.id))?.messages[1]?.tools).toEqual([
			{
				name: "get_user_info",
				args: { uid: "1" },
				ok: false,
				message: "获取用户信息失败: 请求被拦截",
			},
		]);
	});

	it("老形状的会话(痕迹里没有 label / argText)照旧读得回,字段保持缺席", async () => {
		const dir = join(dataDir, ...CONVERSATIONS_DIR);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "old-shape.json"),
			JSON.stringify({
				id: "old-shape",
				title: "老会话",
				createdAt: "2026-08-17T00:00:00.000Z",
				updatedAt: "2026-08-17T00:00:00.000Z",
				mode: "chat",
				persona: true,
				skinTarget: "dashboard",
				messages: [
					{
						id: "a",
						role: "assistant",
						content: "好",
						ts: "2026-08-17T00:00:01.000Z",
						tools: [{ name: "get_user_info", args: { uid: "1" }, ok: true }],
					},
				],
			}),
			"utf8",
		);
		const got = await store.get("old-shape");
		expect(got?.messages[0]?.tools).toEqual([
			{ name: "get_user_info", args: { uid: "1" }, ok: true },
		]);
	});

	it("没调工具的消息不留空数组 —— 磁盘上不写没意义的字段", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [{ role: "assistant", content: "在的" }]);
		expect((await store.get(c.id))?.messages[0]?.tools).toBeUndefined();
	});

	it("思考过程跟着助手消息落盘,重开会话还看得到", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [
			{ role: "user", content: "在吗" },
			{ role: "assistant", content: "在的", reasoning: "主人在确认我在不在,直接答" },
		]);
		expect((await store.get(c.id))?.messages[1]?.reasoning).toBe("主人在确认我在不在,直接答");
	});

	it("没思考的消息不留空字段 —— 非思考模型的会话文件不该背这个键", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [{ role: "assistant", content: "在的", reasoning: "" }]);
		expect((await store.get(c.id))?.messages[0]?.reasoning).toBeUndefined();
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

	it("零消息的会话不进列表 —— 那是一轮没发出去的对话留下的空壳", async () => {
		// 会话在**发送之前**就建好了,整轮失败时服务端一个字都不落盘,壳却留着。
		// 主人看到的是侧栏冒出一条点进去空空如也的「对话」。
		const empty = await store.create();
		const real = await store.create();
		await store.appendMessages(real.id, [{ role: "user", content: "问" }]);
		const ids = (await store.list()).map((m) => m.id);
		expect(ids).toEqual([real.id]);
		expect(ids).not.toContain(empty.id);
	});

	it("目录还不存在时 → 空列表,不抛", async () => {
		// 全新安装、一次都没聊过。
		const fresh = createConversationStore({ dataRoot: join(dataDir, "never-written"), logger });
		expect(await fresh.list()).toEqual([]);
	});

	it("一条脏 JSON 不该让整个侧栏空掉,只跳过它", async () => {
		const good = await store.create();
		await store.appendMessages(good.id, [{ role: "user", content: "问" }]);
		await mkdir(join(dataDir, ...CONVERSATIONS_DIR), { recursive: true });
		await writeFile(join(dataDir, ...CONVERSATIONS_DIR, "broken.json"), "{不是 json", "utf8");
		const ids = (await store.list()).map((m) => m.id);
		expect(ids).toEqual([good.id]);
		expect(logger.warn).toHaveBeenCalled();
	});
});

/**
 * 落盘走存储层的原子写:先写同目录临时文件、再改名盖到会话文件上 —— 进程在写的中途被杀,
 * 盘上是旧的整份或新的整份,不会是半截 JSON(半截的会被当脏记录跳过,主人的整场对话就没了)。
 * 判据是 inode:就地截断重写不换 inode,先写临时文件再改名一定换。
 */
describe("ConversationStore — 落盘是原子的", () => {
	const chatDir = () => join(dataDir, ...CONVERSATIONS_DIR);

	it("重写一个会话 → 换了文件(inode 变),不是就地截断重写", async () => {
		const c = await store.create();
		const file = join(chatDir(), `${c.id}.json`);
		const before = (await stat(file)).ino;
		await store.appendMessages(c.id, [{ role: "user", content: "问" }]);
		expect((await stat(file)).ino).not.toBe(before);
		expect((await store.get(c.id))?.messages.map((m) => m.content)).toEqual(["问"]);
	});

	it("写完目录里只有会话文件,读得回来的是合法 JSON", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [{ role: "user", content: "问" }]);
		await store.setTitle(c.id, "新标题");
		await store.recordCardSkin(c.id, { owned: "a1" });
		expect(await readdir(chatDir())).toEqual([`${c.id}.json`]);
		expect(JSON.parse(await readFile(join(chatDir(), `${c.id}.json`), "utf8")).title).toBe(
			"新标题",
		);
	});

	it("写失败(会话目录被一个文件占着)→ 错误抛给调用方,不留临时文件", async () => {
		await mkdir(join(dataDir, CONVERSATIONS_DIR[0]), { recursive: true });
		await writeFile(join(dataDir, ...CONVERSATIONS_DIR), "占着", "utf8");
		await expect(store.create()).rejects.toBeDefined();
		expect(await readdir(join(dataDir, CONVERSATIONS_DIR[0]))).toEqual([CONVERSATIONS_DIR[1]]);
	});
});

describe("ConversationStore — 上限裁剪", () => {
	it("单会话消息数超上限 → 丢最旧的,保留最近的", async () => {
		const s = createConversationStore({ dataRoot: dataDir, logger, maxMessages: 4 });
		const c = await s.create();
		for (const n of [1, 2, 3, 4, 5, 6]) {
			await s.appendMessages(c.id, [{ role: "user", content: `第${n}条` }]);
		}
		const contents = (await s.get(c.id))?.messages.map((m) => m.content);
		expect(contents).toEqual(["第3条", "第4条", "第5条", "第6条"]);
	});

	it("会话总数超上限 → create 时删掉最旧的那个", async () => {
		const tick = useClock();
		const s = createConversationStore({ dataRoot: dataDir, logger, maxConversations: 2 });
		const a = await s.create();
		await s.appendMessages(a.id, [{ role: "user", content: "最旧" }]);
		tick();
		const b = await s.create();
		await s.appendMessages(b.id, [{ role: "user", content: "中间" }]);
		tick();
		const c = await s.create();
		// 空壳不进列表(见上面那条),所以要看得见它就得让它真有一句话。
		await s.appendMessages(c.id, [{ role: "user", content: "最新" }]);

		const ids = (await s.list()).map((m) => m.id);
		expect(ids).toHaveLength(2);
		expect(ids).toContain(c.id);
		expect(ids).not.toContain(a.id);
	});

	it("凉透的空壳会被回收 —— 别让它占着名额把真会话挤下去", async () => {
		// 壳**比真会话新**才是坏情况:按 updatedAt 修剪时它稳稳留下,被挤掉的是
		// 主人真聊过的那条。(壳恰好最旧时数量修剪会顺手带走它,那种排列验不出问题。)
		const tick = useClock();
		const s = createConversationStore({ dataRoot: dataDir, logger, maxConversations: 2 });
		const a = await s.create();
		await s.appendMessages(a.id, [{ role: "user", content: "真的一" }]);
		tick();
		const shell = await s.create(); // 一轮没发出去的对话留下的壳,比 a 新
		vi.advanceTimersByTime(60 * 60 * 1000); // 凉透
		const b = await s.create();
		await s.appendMessages(b.id, [{ role: "user", content: "真的二" }]);

		expect(await s.get(shell.id)).toBeNull();
		expect((await s.list()).map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
	});

	it("刚建、正在发送中的空会话不许动 —— 那一轮还没写完", async () => {
		// 此刻盘上它确实是零消息,但判它是垃圾得等它凉透:皮肤生成一趟就要几分钟,
		// 中途另开一个对话把它清掉,主人回来会发现刚才那轮凭空没了。
		useClock();
		const s = createConversationStore({ dataRoot: dataDir, logger });
		const inflight = await s.create();
		await s.create();
		expect(await s.get(inflight.id)).toBeTruthy();
	});

	it("同一毫秒里连开新对话,也绝不会删掉刚建的那个", async () => {
		// 时钟不推进 → 三个会话的 updatedAt 字节级相同,排序退到 id 兜底。
		// 预置的两个 id 以 'z' 开头,必然排在任何 uuid(只含 0-9a-f)之前,于是
		// 新建的那个稳稳落在「最旧」的位置上 —— 修剪若不把它摘出去,就会出现
		// 「点了新对话,对话没了」。用可控 id 构造,免得靠随机 uuid 的运气。
		const now = new Date(useClockStart).toISOString();
		await mkdir(join(dataDir, ...CONVERSATIONS_DIR), { recursive: true });
		for (const id of [
			"zzzzzzzz-0000-4000-8000-000000000001",
			"zzzzzzzz-0000-4000-8000-000000000002",
		]) {
			await writeFile(
				join(dataDir, ...CONVERSATIONS_DIR, `${id}.json`),
				JSON.stringify({
					id,
					title: "旧",
					createdAt: now,
					updatedAt: now,
					mode: "chat",
					persona: true,
					skinTarget: "dashboard",
					messages: [{ role: "user", content: "旧问" }],
				}),
				"utf8",
			);
		}
		useClock();
		const s = createConversationStore({ dataRoot: dataDir, logger, maxConversations: 2 });
		const newest = await s.create();
		await s.appendMessages(newest.id, [{ role: "user", content: "新问" }]);

		const ids = (await s.list()).map((m) => m.id);
		expect(ids).toHaveLength(2);
		expect(ids).toContain(newest.id);
	});
});

/**
 * 会话的**面孔** —— 模式(日常聊天 / 皮肤工坊)与人格开关。
 *
 * 这两样以前是界面上的会话级临时状态,不落盘、换个会话就归零。主人后来定了要
 * **锁定**:开局选定,整个会话不再改,侧栏那一行还要标出来。于是它们成了会话
 * 自己的属性,得跟着 JSON 一起活。
 *
 * 功能上线前就存在的会话文件里没有这两个字段:那是 0.x 的老形状,0.x 的会话不迁进新代
 * (3b-53)。
 * 会话库自己不推断 —— 盘上缺了面孔的文件当坏文件跳过。
 */
describe("会话的模式与人格", () => {
	it("建的时候定下来,读回来一字不差", async () => {
		const conv = await store.create({ mode: "skin", persona: false });
		expect(conv.mode).toBe("skin");
		expect(conv.persona).toBe(false);

		const back = await store.get(conv.id);
		expect(back?.mode).toBe("skin");
		expect(back?.persona).toBe(false);
	});

	it("不给 = 日常聊天 + 有人格", async () => {
		const conv = await store.create();
		expect(conv.mode).toBe("chat");
		expect(conv.persona).toBe(true);
	});

	it("侧栏列表也带着 —— 那一行的 label 全指着它", async () => {
		const conv = await store.create({ mode: "skin", persona: false });
		await store.appendMessages(conv.id, [{ role: "user", content: "问" }]);
		const [meta] = await store.list();
		expect(meta?.mode).toBe("skin");
		expect(meta?.persona).toBe(false);
	});

	it.each(["mode", "persona", "skinTarget"] as const)(
		"会话库不推断面孔:盘上缺 %s 的文件(哪怕留着 create_skin 的痕迹)当坏文件跳过,不进列表也 get 不到",
		async (missing) => {
			// 0.x 的老会话由迁移器补面孔;库读盘不再替它们认。哪天读时推断回来了,迁移器就成了摆设。
			// 三格各缺一回、另两格都带着:任何一格的检查被拿掉都会有一回红。
			const dir = join(dataDir, ...CONVERSATIONS_DIR);
			await mkdir(dir, { recursive: true });
			const face = { mode: "skin", persona: false, skinTarget: "card" };
			delete (face as Partial<typeof face>)[missing];
			await writeFile(
				join(dir, "faceless.json"),
				JSON.stringify({
					id: "faceless",
					title: "没有面孔",
					createdAt: "2026-08-17T00:00:00.000Z",
					updatedAt: "2026-08-17T00:00:00.000Z",
					...face,
					messages: [
						{
							id: "a",
							role: "assistant",
							content: "好",
							ts: "2026-08-17T00:00:01.000Z",
							tools: [{ name: "create_skin", args: {}, ok: true }],
						},
					],
				}),
				"utf8",
			);
			const real = await store.create();
			await store.appendMessages(real.id, [{ role: "user", content: "问" }]);

			expect(await store.get("faceless")).toBeNull();
			expect((await store.list()).map((c) => c.id)).toEqual([real.id]);
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("faceless.json"));
		},
	);

	it("聊过之后模式不变 —— 「锁定」就是这个意思", async () => {
		const conv = await store.create({ mode: "skin", persona: false });
		await store.appendMessages(conv.id, [{ role: "user", content: "做套皮肤" }]);

		const back = await store.get(conv.id);
		expect(back?.mode).toBe("skin");
		expect(back?.persona).toBe(false);
	});
});

describe("正在进行的那一轮不算空壳", () => {
	/**
	 * 两条既有决定各自都对,合起来有个洞:
	 * - 消息**拿到回复之后才落盘**(routes/ai.ts,2026-07-25):先写用户消息的话,
	 *   AI 一失败盘上就留下一个没人回答的问题。
	 * - 零消息的会话**不进列表**:整轮失败留下的壳会在侧栏冒出来碍眼。
	 *
	 * 于是一轮正在生成的对话(皮肤要三分钟)在盘上也是零消息 —— 被当成壳藏了起来,
	 * 主人正聊着的这一场却不在侧栏里。列表该藏的是**没人用的**壳,不是所有壳。
	 */
	it("在途的空会话照样进列表", async () => {
		const conv = await store.create();
		const done = store.markBusy(conv.id);
		try {
			expect((await store.list()).map((c) => c.id)).toContain(conv.id);
		} finally {
			done();
		}
	});

	it("这一轮结束后又变回壳,藏起来", async () => {
		const conv = await store.create();
		store.markBusy(conv.id)();
		expect((await store.list()).map((c) => c.id)).not.toContain(conv.id);
	});

	it("同一场并发两轮 —— 先收工的那次不该把还在跑的也放出去", async () => {
		const conv = await store.create();
		const first = store.markBusy(conv.id);
		const second = store.markBusy(conv.id);
		first();
		expect((await store.list()).map((c) => c.id)).toContain(conv.id);
		second();
		expect((await store.list()).map((c) => c.id)).not.toContain(conv.id);
	});

	it("在途那一轮跑过了半小时,也不许被回收 —— TTL 不是它的死线", async () => {
		// 「凉透」这把尺子只对**没人用的**壳成立。工坊那种活儿是真能跑过 TTL 的:
		// 一次结构化调用就 300s,还要重试、嵌套生成、最多八轮工具。列表那头早就
		// 认了 busy 这本账,回收这头却只看时间 —— 于是另开一个对话就能把主人正
		// 等着的那一轮连文件一起删掉,几分钟的生成血本无归,回来只见「会话不存在」。
		useClock();
		const s = createConversationStore({ dataRoot: dataDir, logger });
		const inflight = await s.create();
		const done = s.markBusy(inflight.id);
		try {
			vi.advanceTimersByTime(60 * 60 * 1000); // 比 TTL 还久
			await s.create(); // 另一个标签页点了「新对话」
			expect(await s.get(inflight.id)).toBeTruthy();
		} finally {
			done();
		}
	});

	it("数量修剪也绕开在途那一场 —— 换个入口的同一起事故", async () => {
		// 它跑得越久 updatedAt 越沉,主人在别处多开几个对话就把它压成了「最旧」。
		// 回收那道闸放它过去了,数量这道闸照样能删掉它。
		const tick = useClock();
		const s = createConversationStore({ dataRoot: dataDir, logger, maxConversations: 2 });
		const inflight = await s.create();
		const done = s.markBusy(inflight.id);
		try {
			tick();
			const a = await s.create();
			await s.appendMessages(a.id, [{ role: "user", content: "别处聊的一" }]);
			tick();
			const b = await s.create();
			await s.appendMessages(b.id, [{ role: "user", content: "别处聊的二" }]);
			expect(await s.get(inflight.id)).toBeTruthy();
		} finally {
			done();
		}
	});

	it("释放两次不会把别人的账也销掉", async () => {
		const conv = await store.create();
		const done = store.markBusy(conv.id);
		const other = store.markBusy(conv.id);
		done();
		done();
		expect((await store.list()).map((c) => c.id)).toContain(conv.id);
		other();
	});
});

/**
 * 皮肤工坊做哪种皮肤(ADR-0015 决策 11 / 12)与卡片工坊的账本(决策 18 的 🔗)。
 */
describe("卡片皮肤工坊", () => {
	it("建的时候选了推送卡片 → 读回来、列表里都是 card", async () => {
		const conv = await store.create({ mode: "skin", persona: false, skinTarget: "card" });
		expect(conv.skinTarget).toBe("card");
		await store.appendMessages(conv.id, [{ role: "user", content: "做套卡片" }]);
		expect((await store.get(conv.id))?.skinTarget).toBe("card");
		const [meta] = await store.list();
		expect(meta?.skinTarget).toBe("card");
	});

	it("不给 = dashboard 皮肤", async () => {
		const conv = await store.create({ mode: "skin", persona: false });
		expect(conv.skinTarget).toBe("dashboard");
	});

	it("账本当场落盘:建过的、复制过的都记下,不动 updatedAt", async () => {
		const tick = useClock();
		const conv = await store.create({ mode: "skin", persona: false, skinTarget: "card" });
		tick();
		expect(await store.recordCardSkin(conv.id, { owned: "a1" })).toBe(true);
		expect(await store.recordCardSkin(conv.id, { fork: { from: "orig", to: "c1" } })).toBe(true);
		const back = await store.get(conv.id);
		expect(back?.cardSkinLedger).toEqual({ owned: ["a1", "c1"], forks: { orig: "c1" } });
		expect(back?.updatedAt).toBe(conv.updatedAt);
	});

	it("账本:会话不在了 → false,不凭空造一个", async () => {
		expect(await store.recordCardSkin("ghost", { owned: "a1" })).toBe(false);
		expect(await store.get("ghost")).toBeNull();
	});

	it("回复碰过的皮肤跟着那条消息落盘;没碰就不写这个字段", async () => {
		const conv = await store.create({ mode: "skin", persona: false, skinTarget: "card" });
		await store.appendMessages(conv.id, [
			{ role: "user", content: "做一套" },
			{
				role: "assistant",
				content: "好了",
				cardSkins: [{ id: "a1", kinds: ["live", "superchat"] }],
			},
			{ role: "assistant", content: "没动", cardSkins: [] },
		]);
		const [, done, idle] = (await store.get(conv.id))?.messages ?? [];
		expect(done?.cardSkins).toEqual([{ id: "a1", kinds: ["live", "superchat"] }]);
		expect(idle && "cardSkins" in idle).toBe(false);
	});

	/**
	 * ㉔e:会话文件里 `cardSkins[].kinds` 读出来要过卡种表 —— 开发期落盘的旧键(`dynamic` / `sc` / `guard`)、
	 * 认不出的字符串、不是字符串的值都丢掉(不写迁移,这些只是会话里「改过哪几种卡」的标注),认得的新键原样、原序留着。
	 * 验红:把读路径上的 `dropUnknownCardKinds` 去掉,旧键又原样读出来,这条红。
	 */
	it("读盘上的 kinds:旧键、认不出的键被丢掉,认得的新键留下", async () => {
		const id = "11111111-1111-4111-8111-111111111111";
		const now = new Date(useClockStart).toISOString();
		await mkdir(join(dataDir, ...CONVERSATIONS_DIR), { recursive: true });
		await writeFile(
			join(dataDir, ...CONVERSATIONS_DIR, `${id}.json`),
			JSON.stringify({
				id,
				title: "老会话",
				createdAt: now,
				updatedAt: now,
				mode: "skin",
				persona: false,
				skinTarget: "card",
				messages: [
					{
						id: "m1",
						role: "assistant",
						content: "好了",
						ts: now,
						cardSkins: [
							{
								id: "a1",
								kinds: ["live", "dynamic", "post", "sc", "superchat", "guard", "nope", 7],
							},
						],
					},
				],
			}),
			"utf8",
		);
		const conv = await store.get(id);
		expect(conv?.messages[0]?.cardSkins).toEqual([
			{ id: "a1", kinds: ["live", "post", "superchat"] },
		]);
	});
});

describe("ConversationStore.listImageRefs — 图库引用方交出的名单", () => {
	const A = `${"a".repeat(64)}.png`;
	const B = `${"b".repeat(64)}.jpg`;
	const C = `${"c".repeat(64)}.webp`;

	it("盘上所有会话所有消息带的图,同一张只出现一次", async () => {
		const one = await store.create();
		const two = await store.create();
		await store.appendMessages(one.id, [
			{ role: "user", content: "看", images: [A, B] },
			{ role: "assistant", content: "好" },
			{ role: "user", content: "再看", images: [A] },
		]);
		await store.appendMessages(two.id, [{ role: "user", content: "这个", images: [C, A] }]);

		expect([...(await store.listImageRefs())].sort()).toEqual([A, B, C]);
	});

	it("一个会话都没有(目录还没建)→ 空", async () => {
		expect([...(await store.listImageRefs())]).toEqual([]);
	});

	it("零消息的会话、没带图的消息不贡献引用", async () => {
		const empty = await store.create();
		const plain = await store.create();
		await store.appendMessages(plain.id, [{ role: "user", content: "只有字" }]);

		expect(empty.messages).toEqual([]);
		expect([...(await store.listImageRefs())]).toEqual([]);
	});

	it("读不懂的会话文件跳过(与列表一致,主人眼里它本来就没了);认得出消息的文件哪怕少了别的格也照样交出它的图", async () => {
		const good = await store.create();
		await store.appendMessages(good.id, [{ role: "user", content: "看", images: [A] }]);
		const dir = join(dataDir, ...CONVERSATIONS_DIR);
		await writeFile(join(dir, "broken.json"), "{ not json");
		// 缺面孔那三格:会话库会把它当坏文件跳过,可文件里的图不能因此被清扫当垃圾。
		await writeFile(
			join(dir, "faceless.json"),
			JSON.stringify({ id: "faceless", messages: [{ role: "user", images: [B, 42, null] }] }),
		);

		expect([...(await store.listImageRefs())].sort()).toEqual([A, B]);
	});

	it("目录读不了(不是「没有」)就抛,宁可这一轮一张不删", async () => {
		const aiDir = join(dataDir, "ai");
		await mkdir(aiDir, { recursive: true });
		// `ai/conversations` 是个文件:readdir 报 ENOTDIR,不是 ENOENT。
		await writeFile(join(aiDir, "conversations"), "x");

		await expect(store.listImageRefs()).rejects.toThrow();
	});
});

describe("ConversationStore.close", () => {
	beforeEach(() => storageWriteGate.reset());
	afterEach(() => storageWriteGate.reset());

	const chatFiles = async (): Promise<string[]> =>
		(await readdir(join(dataDir, ...CONVERSATIONS_DIR))).sort();

	it("close 等在途的写落盘", async () => {
		storageWriteGate.hold();
		const creating = store.create();
		await storageWriteGate.arrived();

		let closed = false;
		const closing = store.close().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(closed).toBe(false);

		storageWriteGate.release();
		await closing;
		const created = await creating;
		expect(await chatFiles()).toEqual([`${created.id}.json`]);
	});

	it("close 之后的写被拒且不碰盘", async () => {
		const c = await store.create();
		await store.appendMessages(c.id, [{ role: "user", content: "问1" }]);
		const file = join(dataDir, ...CONVERSATIONS_DIR, `${c.id}.json`);
		const before = await readFile(file, "utf8");
		await store.close();
		const writesAtClose = storageWriteGate.writes;

		const closed = { code: "queue_closed" };
		await expect(store.create()).rejects.toMatchObject(closed);
		await expect(
			store.appendMessages(c.id, [{ role: "user", content: "问2" }]),
		).rejects.toMatchObject(closed);
		await expect(store.setTitle(c.id, "改名")).rejects.toMatchObject(closed);
		await expect(store.recordCardSkin(c.id, { owned: "skin-1" })).rejects.toMatchObject(closed);
		await expect(store.remove(c.id)).rejects.toMatchObject(closed);

		expect(storageWriteGate.writes).toBe(writesAtClose);
		expect(await readFile(file, "utf8")).toBe(before);
		expect(await chatFiles()).toEqual([`${c.id}.json`]);
	});
});
