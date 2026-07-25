/**
 * 女仆 AI 聊天 —— `/api/ai/conversations` 一族。
 *
 * 与 `/api/ai/test-push`(拿页面草稿试一句人格)是两码事:这里用**已保存**的配置、
 * 常驻的 commentary 实例,会话落磁盘,重启后接着聊。
 *
 * 最要紧的一条契约是**整轮成败一致**:AI 那一跳失败时,磁盘上不留半轮 —— 不留
 * 一个没人回答的问题挂在记录里,主人重试或改口都干净。所以落盘发生在拿到回复
 * 之后,一次把问和答一起写进去。
 *
 * OpenAI 那一跳是外部边界,mock 掉。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createConversationStore } from "../../ai/conversation-store.js";
import { createAiRoute } from "../ai.js";
import type { RouteDeps } from "../types.js";

const H = vi.hoisted(() => ({
	reply: "主人晚上好呀~(*´∀`)~♡",
	/** 置上就按这些分片逐段回调 onDelta;null = 不分片,一次性回 `reply`。 */
	chunks: null as string[] | null,
	/** 置上就让这一轮在吐完分片之后抛 —— 模拟 401 / 模型不存在 / 网络断。 */
	error: null as Error | null,
	/** 最后一次收到的历史,用来验「上文有没有真的带过去」。 */
	lastHistory: null as Array<{ role: string; content: string }> | null,
	/** AI 起的标题;置 Error 就模拟起名失败(余额不足 / 模型抽风)。 */
	title: "本周勤奋榜" as string | Error,
	/** 最后一次交给起名的那段对话。 */
	titleInput: null as Array<{ role: string; content: string }> | null,
	/** 置上就在吐正文**之前**按这个剧本回调 onToolEvent —— 真实顺序就是这样。 */
	toolEvents: null as ToolEv[] | null,
}));

/** {@link ToolTraceEvent} 的测试侧影本 —— 这个包在测试里是 mock 掉的。 */
type ToolEv =
	| { phase: "start"; id: string; name: string; args: Record<string, string> }
	| { phase: "end"; id: string; ok: boolean };

/**
 * 流式版:按 `H.chunks` 逐段回调 onDelta,再返回拼起来的整段。`H.error` 置上就
 * 在**吐完这些分片之后**抛 —— 用来验「已经吐了半句再断」的路径。
 */
const chatStatelessStream = vi.fn(
	async (
		messages: Array<{ role: string; content: string }>,
		opts: { onDelta: (t: string) => void; onToolEvent?: (ev: ToolEv) => void },
	) => {
		H.lastHistory = messages;
		for (const ev of H.toolEvents ?? []) opts.onToolEvent?.(ev);
		for (const c of H.chunks ?? []) opts.onDelta(c);
		if (H.error) throw H.error;
		const result = H.chunks ? H.chunks.join("") : H.reply;
		return { result, pendingActions: [] };
	},
);

const summarizeTitle = vi.fn(async (exchange: Array<{ role: string; content: string }>) => {
	H.titleInput = exchange;
	if (H.title instanceof Error) throw H.title;
	return H.title;
});

vi.mock("@bilibili-notify/ai", () => ({
	CommentaryGenerator: class {
		chat = vi.fn();
		chatStateless = vi.fn();
		chatStatelessStream = chatStatelessStream;
		summarizeTitle = summarizeTitle;
		stop = vi.fn();
	},
}));

let dataDir: string;

interface StubOpts {
	/** engines 尚未 attach(启动早期)。 */
	noEngines?: boolean;
	/** 全局 AI 总开关。 */
	aiEnabled?: boolean;
	/** baseUrl / apiKey 没填齐时 engines.commentary 就是 null。 */
	noCommentary?: boolean;
}

async function makeDeps(opts: StubOpts = {}) {
	dataDir = await mkdtemp(join(tmpdir(), "bn-airoute-"));
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const conversationStore = createConversationStore({ dataDir, logger });
	const deps = {
		store: {
			getGlobals: () => ({ defaults: { ai: { enabled: opts.aiEnabled ?? true } } }),
			getTargets: () => [],
			getSubscriptions: () => [],
		},
		runtime: {
			serviceCtx: { logger },
			conversationStore,
			engines: opts.noEngines
				? null
				: {
						api: {},
						commentary: opts.noCommentary
							? null
							: new (class {
									chatStatelessStream = chatStatelessStream;
									summarizeTitle = summarizeTitle;
								})(),
					},
		},
	} as unknown as RouteDeps;
	return { deps, conversationStore };
}

beforeEach(() => {
	H.error = null;
	H.chunks = null;
	H.reply = "主人晚上好呀~(*´∀`)~♡";
	H.lastHistory = null;
	H.title = "本周勤奋榜";
	H.titleInput = null;
	H.toolEvents = null;
	chatStatelessStream.mockClear();
	summarizeTitle.mockClear();
});

/** 一条 SSE 事件。 */
interface SseEvent {
	event: string;
	data: any;
}

/**
 * 把 SSE 响应体读成事件数组。
 *
 * 手写而不是找个库:线格式就是「空行分帧、`event:` / `data:` 两个字段」,
 * 而测试要的恰恰是**盯住这个线格式** —— 换个库来解析,等于把被测的东西
 * 交给别人去解释。
 */
async function readSse(res: Response): Promise<SseEvent[]> {
	const text = await res.text();
	const out: SseEvent[] = [];
	for (const frame of text.split("\n\n")) {
		if (!frame.trim()) continue;
		let event = "message";
		const dataLines: string[] = [];
		for (const line of frame.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
		}
		if (dataLines.length === 0) continue;
		out.push({ event, data: JSON.parse(dataLines.join("\n")) });
	}
	return out;
}

/** SSE 里的 `done` 载荷 —— 相当于旧版一次性 JSON 的那个响应体。 */
async function readDone(res: Response): Promise<any> {
	return (await readSse(res)).find((e) => e.event === "done")?.data;
}

/**
 * 发一句并**把流读完**。
 *
 * `app.request()` 在响应对象一就绪时就 resolve 了,而 SSE 的 handler 还在后面
 * 慢慢跑 —— 落盘发生在流的末尾。凡是「发完之后要去查磁盘 / 查列表」的测试都
 * 必须先把流抽干,否则查到的是上一刻的状态,而且时快时慢地随机通过。
 */
async function chatDrained(app: App, id: string, body: unknown): Promise<SseEvent[]> {
	return readSse(await chat(app, id, body));
}

type App = ReturnType<typeof createAiRoute>;

/** `Response.json()` 回的是 unknown;测试里只想直接点字段。 */
const readJson = async (res: Response): Promise<any> => res.json();

const listConvs = (app: App) => app.request("/conversations");
const createConv = (app: App) => app.request("/conversations", { method: "POST" });
const getConv = (app: App, id: string) => app.request(`/conversations/${id}`);
const delConv = (app: App, id: string) => app.request(`/conversations/${id}`, { method: "DELETE" });
const retitle = (app: App, id: string) =>
	app.request(`/conversations/${id}/title`, { method: "POST" });
const chat = (app: App, id: string, body: unknown) =>
	app.request(`/conversations/${id}/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

describe("会话增删查", () => {
	it("新装状态下列表是空的,不是 500", async () => {
		const { deps } = await makeDeps();
		const res = await listConvs(createAiRoute(deps));
		expect(res.status).toBe(200);
		expect((await readJson(res)).conversations).toEqual([]);
	});

	it("POST 建会话 → 能在列表里看到", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const created = (await readJson(await createConv(app))).conversation;
		expect(created.id).toBeTruthy();
		expect(created.messages).toEqual([]);

		const list = (await readJson(await listConvs(app))).conversations;
		expect(list.map((c: any) => c.id)).toEqual([created.id]);
	});

	it("GET 不存在的会话 → 404 带一句人话", async () => {
		const { deps } = await makeDeps();
		const res = await getConv(createAiRoute(deps), "11111111-1111-4111-8111-111111111111");
		expect(res.status).toBe(404);
		expect((await readJson(res)).err).toBeTruthy();
	});

	it("DELETE 删掉后就查不到了;再删一次 404", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;
		expect((await delConv(app, id)).status).toBe(200);
		expect((await getConv(app, id)).status).toBe(404);
		expect((await delConv(app, id)).status).toBe(404);
	});
});

describe("POST /conversations/:id/chat — 聊天", () => {
	it("问一句 → 回一句,问和答都落盘", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;

		const res = await chat(app, id, { message: "本周谁最勤奋" });
		expect(res.status).toBe(200);
		const got = await readDone(res);
		expect(got.user.content).toBe("本周谁最勤奋");
		expect(got.reply.content).toBe(H.reply);
		expect(got.conversation.title).toBe("本周谁最勤奋");

		const stored = (await readJson(await getConv(app, id))).conversation;
		expect(stored.messages.map((m: any) => [m.role, m.content])).toEqual([
			["user", "本周谁最勤奋"],
			["assistant", H.reply],
		]);
	});

	it("第二轮把上文一起带给女仆 —— 会话是持久的,记忆不能只活在内存里", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;

		H.reply = "答1";
		await chatDrained(app, id, { message: "问1" });
		H.reply = "答2";
		await chatDrained(app, id, { message: "问2" });

		expect(H.lastHistory?.map((m) => m.content)).toEqual(["问1", "答1", "问2"]);
	});

	it("正文是**边生成边发**的 —— 一段一个 delta 事件,不是攒完一次性给", async () => {
		// 攒到最后一起给的话,那十几秒里页面上只有三个跳动的点,读起来像卡住了。
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;

		H.chunks = ["主人", "晚上好", "呀~"];
		const events = await readSse(await chat(app, id, { message: "在吗" }));

		expect(events.filter((e) => e.event === "delta").map((e) => e.data.text)).toEqual([
			"主人",
			"晚上好",
			"呀~",
		]);
	});

	it("delta 在 done 之前 —— 顺序反了前端就得等到最后才开始画", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;

		H.chunks = ["前", "后"];
		const events = await readSse(await chat(app, id, { message: "在吗" }));
		const kinds = events.map((e) => e.event);
		expect(kinds).toEqual(["delta", "delta", "done"]);
	});

	it("done 带回落盘后的两条消息,分片拼起来正是那句回复", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;

		H.chunks = ["查", "到", "了"];
		const done = await readDone(await chat(app, id, { message: "帮我查" }));
		expect(done.user.content).toBe("帮我查");
		expect(done.reply.content).toBe("查到了");

		const stored = (await readJson(await getConv(app, id))).conversation;
		expect(stored.messages.map((m: any) => m.content)).toEqual(["帮我查", "查到了"]);
	});

	it("已经吐出半句再断 → 补一个 error 事件,且不发 done", async () => {
		// 没有 done 前端就不会去刷新会话;那半句留在屏幕上,旁边挂着报错,
		// 与「磁盘上什么都没落」是一致的。
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;

		H.chunks = ["前半句"];
		H.error = new Error("connection reset");
		const events = await readSse(await chat(app, id, { message: "在吗" }));

		expect(events.map((e) => e.event)).toEqual(["delta", "error"]);
		expect(events[1]?.data.err).toContain("connection reset");
		const stored = (await readJson(await getConv(app, id))).conversation;
		expect(stored.messages).toEqual([]);
	});

	it("前置条件失败仍是普通 JSON + 非 200,不是一个说「其实不行」的 200 流", async () => {
		// 「还没配 key」跟「聊到一半断了」是两回事,不该逼调用方分两处处理。
		const { deps } = await makeDeps({ aiEnabled: false });
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;
		const res = await chat(app, id, { message: "在吗" });
		expect(res.status).toBe(400);
		expect(res.headers.get("content-type")).toContain("application/json");
	});

	it("AI 那一跳失败 → error 事件,且磁盘上不留半轮", async () => {
		// 留下一个没人回答的问题,主人重开会话只会看到自己在自言自语。
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;

		H.error = new Error("401 Unauthorized");
		const res = await chat(app, id, { message: "在吗" });
		const events = await readSse(res);
		expect(events.find((e) => e.event === "error")?.data.err).toContain("401");
		expect(events.some((e) => e.event === "done")).toBe(false);

		const stored = (await readJson(await getConv(app, id))).conversation;
		expect(stored.messages).toEqual([]);
	});

	it("聊完之后会话排到列表最前 —— 侧栏「最近」得是真的最近", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const first = (await readJson(await createConv(app))).conversation.id;
		const second = (await readJson(await createConv(app))).conversation.id;
		await chatDrained(app, first, { message: "把它顶上去" });

		const list = (await readJson(await listConvs(app))).conversations;
		expect(list[0].id).toBe(first);
		expect(list[1].id).toBe(second);
	});

	it("往不存在的会话里发消息 → 404,不凭空造一个", async () => {
		const { deps } = await makeDeps();
		const res = await chat(createAiRoute(deps), "11111111-1111-4111-8111-111111111111", {
			message: "喂",
		});
		expect(res.status).toBe(404);
		expect(chatStatelessStream).not.toHaveBeenCalled();
	});

	it("空消息 → 400,不浪费一次模型调用", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;
		const res = await chat(app, id, { message: "   " });
		expect(res.status).toBe(400);
		expect(chatStatelessStream).not.toHaveBeenCalled();
	});
});

/**
 * 工具轮不产生正文,所以那几秒在界面上跟「模型卡住了」长得一模一样。把它讲出来
 * 需要两件事:流里实时报一声,以及跟着回复一起落盘 —— 只报不存的话,`done` 一到、
 * 真身把在途副本换下来的那一刻,几条小条就凭空消失了。
 */
describe("POST /conversations/:id/chat — 工具调用痕迹", () => {
	const listSubs: ToolEv[] = [
		{ phase: "start", id: "0-0", name: "list_subscriptions", args: {} },
		{ phase: "end", id: "0-0", ok: true },
	];

	it("工具调用实时变成 tool 事件 —— 查东西那几秒不能是一片死寂", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;
		H.toolEvents = listSubs;

		const events = await chatDrained(app, id, { message: "我订了谁" });
		const tools = events.filter((e) => e.event === "tool");
		expect(tools.map((e) => e.data.phase)).toEqual(["start", "end"]);
		expect(tools[0]?.data).toMatchObject({ name: "list_subscriptions", args: {} });
		expect(tools[1]?.data).toMatchObject({ ok: true });
	});

	it("tool 事件排在 done 之前 —— 顺序反了就等于没实时报", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;
		H.toolEvents = listSubs;

		const kinds = (await chatDrained(app, id, { message: "x" })).map((e) => e.event);
		// 先钉住「有」。只比下标的话,一条 tool 都没发时 indexOf 是 -1,照样小于
		// done 的下标 —— 这个断言会在功能整个缺席时假绿。
		expect(kinds).toContain("tool");
		expect(kinds.lastIndexOf("tool")).toBeLessThan(kinds.indexOf("done"));
	});

	it("痕迹随回复一起落盘 —— 刷新之后还看得到她查过什么", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;
		H.toolEvents = [
			{ phase: "start", id: "0-0", name: "get_user_info", args: { uid: "12345" } },
			{ phase: "end", id: "0-0", ok: true },
		];

		await chatDrained(app, id, { message: "查一下" });
		const conv = (await readJson(await getConv(app, id))).conversation;
		expect(conv.messages[1].tools).toEqual([
			{ name: "get_user_info", args: { uid: "12345" }, ok: true },
		]);
		// 主人那条不该沾上工具 —— 工具是女仆调的。
		expect(conv.messages[0].tools).toBeUndefined();
	});

	it("done 里的回复也带着痕迹 —— 前端交接那一帧要拿它顶上", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;
		H.toolEvents = listSubs;

		const done = await readDone(await chat(app, id, { message: "x" }));
		expect(done.reply.tools).toEqual([{ name: "list_subscriptions", args: {}, ok: true }]);
	});

	it("失败的那次也留着 —— 「查了但没查到」和「压根没查」不是一回事", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;
		H.toolEvents = [
			{ phase: "start", id: "0-0", name: "get_live_status", args: {} },
			{ phase: "end", id: "0-0", ok: false },
		];

		const done = await readDone(await chat(app, id, { message: "x" }));
		expect(done.reply.tools).toEqual([{ name: "get_live_status", args: {}, ok: false }]);
	});

	it("同一轮多个工具按开始顺序落盘,不串台", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;
		// 真实世界里是顺序执行的,但 end 认的是 id 而不是「上一条」—— 这里故意
		// 让两个 start 挨在一起、end 倒序回来,盯住配对靠的确实是 id。
		H.toolEvents = [
			{ phase: "start", id: "0-0", name: "search_user", args: { keyword: "咩栗" } },
			{ phase: "start", id: "0-1", name: "get_user_info", args: { uid: "1" } },
			{ phase: "end", id: "0-1", ok: false },
			{ phase: "end", id: "0-0", ok: true },
		];

		const done = await readDone(await chat(app, id, { message: "x" }));
		expect(done.reply.tools).toEqual([
			{ name: "search_user", args: { keyword: "咩栗" }, ok: true },
			{ name: "get_user_info", args: { uid: "1" }, ok: false },
		]);
	});

	it("只开了头没收尾的那条不落盘 —— 状态不明的痕迹会在界面上永远转圈", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;
		H.toolEvents = [{ phase: "start", id: "0-0", name: "list_subscriptions", args: {} }];

		const done = await readDone(await chat(app, id, { message: "x" }));
		expect(done.reply.tools).toBeUndefined();
	});

	it("没调工具就不写这个字段 —— 绝大多数消息都没调", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;

		const events = await chatDrained(app, id, { message: "在吗" });
		expect(events.some((e) => e.event === "tool")).toBe(false);
		expect(events.find((e) => e.event === "done")?.data.reply.tools).toBeUndefined();
	});
});

describe("POST /conversations/:id/title — AI 起标题", () => {
	/**
	 * 首问截断只是兜底。主人每次都以「你好」开场,那一列就全叫「你好」,等于没有
	 * 标题 —— 所以聊完第一轮再让女仆看一眼,起个概括主题的短名字。
	 */
	async function firstRound(app: App, ask: string) {
		const id = (await readJson(await createConv(app))).conversation.id as string;
		await chatDrained(app, id, { message: ask });
		return id;
	}

	it("聊完第一轮 → 标题换成 AI 起的那个", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = await firstRound(app, "你好");

		const res = await retitle(app, id);
		expect(res.status).toBe(200);
		expect((await readJson(res)).conversation.title).toBe("本周勤奋榜");
		// 真的落盘了,不只是回给前端看看。
		expect((await readJson(await getConv(app, id))).conversation.title).toBe("本周勤奋榜");
	});

	it("交给女仆的是首轮问答本身,不是整段历史", async () => {
		// 聊到第十轮再起名的话,给全量历史既贵又跑题 —— 标题说的是这个会话
		// **从哪儿开始**的。
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = await firstRound(app, "你好");
		await chatDrained(app, id, { message: "第二个问题" });

		await retitle(app, id);
		expect(H.titleInput?.map((m) => m.content)).toEqual(["你好", H.reply]);
	});

	it("起名失败会在日志里留下原因 —— 界面上是静默的,不留就无从下手", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = await firstRound(app, "你好");

		H.title = new Error("402 余额不足");
		await retitle(app, id);
		const warn = (deps.runtime.serviceCtx.logger as unknown as { warn: ReturnType<typeof vi.fn> })
			.warn;
		expect(warn.mock.calls.some((c) => String(c[0]).includes("402"))).toBe(true);
	});

	it("起名失败 → 标题原样留着,不清空也不报错给主人看", async () => {
		// 起不出名字是小事,不该连累已经聊完的那一轮。余额不足时尤其 —— 那会儿
		// 主人已经在为聊天本身发愁了。
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = await firstRound(app, "你好");

		H.title = new Error("402 余额不足");
		const res = await retitle(app, id);
		expect(res.status).toBe(200);
		expect((await readJson(res)).conversation.title).toBe("你好");
	});

	it("一轮都没聊完 → 不去撞模型", async () => {
		// 空会话没什么可总结的,那一次调用纯属白花。
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id as string;

		expect((await retitle(app, id)).status).toBe(200);
		expect(summarizeTitle).not.toHaveBeenCalled();
	});

	it("聊过好几轮的老会话照样能起名 —— 判据是「起过没」,不是「第几轮」", async () => {
		// 主人报的正是这个:一屋子叫「你好」的会话都是功能上线前建的,里面早有
		// 好几条消息。拿轮次当判据的话,它们一个都轮不上,标题永远是「你好」。
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = await firstRound(app, "你好");
		await chatDrained(app, id, { message: "第二问" });
		await chatDrained(app, id, { message: "第三问" });

		const res = await retitle(app, id);
		expect((await readJson(res)).conversation.title).toBe("本周勤奋榜");
	});

	it("起过一次就不再起 —— 路标不该被反复挪", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = await firstRound(app, "你好");

		await retitle(app, id);
		summarizeTitle.mockClear();
		const res = await retitle(app, id);

		expect(summarizeTitle).not.toHaveBeenCalled();
		expect((await readJson(res)).conversation.title).toBe("本周勤奋榜");
	});

	it("起名成功后 autoTitled 传给前端 —— 它靠这个决定还要不要来要", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = await firstRound(app, "你好");
		expect((await readJson(await retitle(app, id))).conversation.autoTitled).toBe(true);
	});

	it("起名失败 → autoTitled 仍是假,余额补上之后还能自动补起来", async () => {
		const { deps } = await makeDeps();
		const app = createAiRoute(deps);
		const id = await firstRound(app, "你好");

		H.title = new Error("402 余额不足");
		expect((await readJson(await retitle(app, id))).conversation.autoTitled).toBeFalsy();
	});

	it("会话不存在 → 404", async () => {
		const { deps } = await makeDeps();
		expect((await retitle(createAiRoute(deps), "没这个人")).status).toBe(404);
	});

	it("没配 key → 400,跟聊天那条一个说法", async () => {
		const { deps } = await makeDeps({ noCommentary: true });
		const app = createAiRoute(deps);
		expect((await retitle(app, "任意 id")).status).toBe(400);
	});
});

describe("POST /conversations/:id/chat — 前置条件", () => {
	it("engines 还没起来 → 503,让人知道是「等一下」而不是「坏了」", async () => {
		const { deps } = await makeDeps({ noEngines: true });
		const app = createAiRoute(deps);
		// 会话存储不依赖 engines,建会话仍然应该成功。
		const id = (await readJson(await createConv(app))).conversation.id;
		expect((await chat(app, id, { message: "在吗" })).status).toBe(503);
	});

	it("智能女仆总开关关着 → 400,说清是没启用", async () => {
		const { deps } = await makeDeps({ aiEnabled: false });
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;
		const res = await chat(app, id, { message: "在吗" });
		expect(res.status).toBe(400);
		expect((await readJson(res)).err).toContain("启用");
	});

	it("开着但 baseUrl/apiKey 没填齐 → 400,指向该去填什么", async () => {
		// 光说「未启用」会把人支去翻开关,而开关明明是开的。
		const { deps } = await makeDeps({ noCommentary: true });
		const app = createAiRoute(deps);
		const id = (await readJson(await createConv(app))).conversation.id;
		const res = await chat(app, id, { message: "在吗" });
		expect(res.status).toBe(400);
		expect((await readJson(res)).err).toMatch(/baseUrl|apiKey/i);
	});
});
