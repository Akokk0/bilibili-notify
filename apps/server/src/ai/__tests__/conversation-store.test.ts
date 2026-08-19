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
		const fresh = createConversationStore({ dataDir: join(dataDir, "never-written"), logger });
		expect(await fresh.list()).toEqual([]);
	});

	it("一条脏 JSON 不该让整个侧栏空掉,只跳过它", async () => {
		const good = await store.create();
		await store.appendMessages(good.id, [{ role: "user", content: "问" }]);
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
		const s = createConversationStore({ dataDir, logger, maxConversations: 2 });
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
		const s = createConversationStore({ dataDir, logger });
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
		await mkdir(join(dataDir, "ai", "chat"), { recursive: true });
		for (const id of [
			"zzzzzzzz-0000-4000-8000-000000000001",
			"zzzzzzzz-0000-4000-8000-000000000002",
		]) {
			await writeFile(
				join(dataDir, "ai", "chat", `${id}.json`),
				JSON.stringify({
					id,
					title: "旧",
					createdAt: now,
					updatedAt: now,
					messages: [{ role: "user", content: "旧问" }],
				}),
				"utf8",
			);
		}
		useClock();
		const s = createConversationStore({ dataDir, logger, maxConversations: 2 });
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
 * 缺省口径是要紧的:功能上线前就存在的会话文件里没有这两个字段,读出来必须是
 * 「日常聊天 + 有人格」—— 也就是它们一直以来的样子。往任何别的方向兜,主人一屋子
 * 老会话会集体变脸。
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

	it("老会话文件没这两个字段 → 按聊天 + 有人格读,别让主人的旧会话集体变脸", async () => {
		const dir = join(dataDir, "ai", "chat");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "legacy.json"),
			JSON.stringify({
				id: "legacy",
				title: "老会话",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				messages: [{ role: "user", content: "老问题" }],
			}),
			"utf8",
		);

		expect((await store.get("legacy"))?.mode).toBe("chat");
		expect((await store.get("legacy"))?.persona).toBe(true);
		const [meta] = await store.list();
		expect(meta?.mode).toBe("chat");
		expect(meta?.persona).toBe(true);
	});

	/**
	 * 上线前的会话文件里没有 mode,一律按「聊天」读 —— 于是主人一屋子做过皮肤的
	 * 老会话在侧栏里一块牌都不挂,看不出哪场是工坊的(真机反馈,2026-08-19)。
	 *
	 * 但工具痕迹是铁证:`create_skin` **只有皮肤工坊挂得出来**(日常聊天那个窗口
	 * 一个写工具都没有)。有它就是工坊,这不是猜。
	 *
	 * 只在**读**的时候认,不回写盘 —— 推断是幂等的,而改主人的存档不是。
	 */
	it("老会话里有 create_skin 痕迹 → 认成工坊", async () => {
		const dir = join(dataDir, "ai", "chat");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "oldskin.json"),
			JSON.stringify({
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
			}),
			"utf8",
		);

		expect((await store.get("oldskin"))?.mode).toBe("skin");
		const [meta] = await store.list();
		expect(meta?.mode).toBe("skin");
	});

	it("只调过只读工具的老会话仍是聊天 —— 别把查订阅认成做皮肤", async () => {
		const dir = join(dataDir, "ai", "chat");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "oldchat.json"),
			JSON.stringify({
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
			}),
			"utf8",
		);

		expect((await store.get("oldchat"))?.mode).toBe("chat");
	});

	it("盘上写着 mode 就照它走,推断不许翻案", async () => {
		const dir = join(dataDir, "ai", "chat");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "explicit.json"),
			JSON.stringify({
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
			}),
			"utf8",
		);

		expect((await store.get("explicit"))?.mode).toBe("chat");
	});

	it("聊过之后模式不变 —— 「锁定」就是这个意思", async () => {
		const conv = await store.create({ mode: "skin", persona: false });
		await store.appendMessages(conv.id, [{ role: "user", content: "做套皮肤" }]);

		const back = await store.get(conv.id);
		expect(back?.mode).toBe("skin");
		expect(back?.persona).toBe(false);
	});
});
