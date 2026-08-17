/**
 * 单元测试 — 聊天侧栏「最近」的分组。
 *
 * 分组是纯派生,但它依赖**本地日界**而不是 24 小时窗口:凌晨 1 点聊的那句,
 * 到了当天下午仍该是「今天」,而不是因为过了 24 小时就掉进「昨天」。
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createSseParser, groupConversations, groupLabel, sendChatMessage } from "../aiChat";

describe("createSseParser — 分片边界不认帧边界", () => {
	/**
	 * 这是整条流式链上最容易写错的一环:网络给什么就是什么。一条 `data:` 完全
	 * 可能被劈成两块到达,两条事件也可能挤在同一块里。不跨块粘合的话,表现是
	 * 回复里随机漏字 / 冒出 JSON 解析错误,而且只在网速差时复现。
	 */
	it("一块里有完整的一帧", () => {
		const parse = createSseParser();
		expect(parse('event: delta\ndata: {"text":"好"}\n\n')).toEqual([
			{ event: "delta", data: '{"text":"好"}' },
		]);
	});

	it("一帧被劈成两块 → 粘起来再交付,不吐半截", () => {
		const parse = createSseParser();
		expect(parse('event: delta\ndata: {"tex')).toEqual([]);
		expect(parse('t":"好"}\n\n')).toEqual([{ event: "delta", data: '{"text":"好"}' }]);
	});

	it("一块里挤了两帧 → 一次全交付", () => {
		const parse = createSseParser();
		const got = parse('event: delta\ndata: "a"\n\nevent: delta\ndata: "b"\n\n');
		expect(got.map((f) => f.data)).toEqual(['"a"', '"b"']);
	});

	it("最后一帧还没收完就先留着,不当成完整帧", () => {
		const parse = createSseParser();
		const got = parse('event: delta\ndata: "a"\n\nevent: done\ndata: {"partial"');
		expect(got).toHaveLength(1);
		expect(got[0]?.event).toBe("delta");
	});

	it("只裁掉冒号后那一个空格 —— 正文里的空格是内容", () => {
		// 整体 trim 的话,「 world」会被裁成「world」,拼出来就是「helloworld」。
		const parse = createSseParser();
		expect(parse("event: delta\ndata:  hello \n\n")[0]?.data).toBe(" hello ");
	});

	it("没有 event 字段 → 落到默认的 message", () => {
		expect(createSseParser()("data: 1\n\n")).toEqual([{ event: "message", data: "1" }]);
	});

	it("空帧 / 心跳注释被跳过", () => {
		expect(createSseParser()("\n\n:heartbeat\n\n")).toEqual([]);
	});

	it("多行 data 按换行拼回去", () => {
		expect(createSseParser()("event: x\ndata: 一\ndata: 二\n\n")[0]?.data).toBe("一\n二");
	});
});

const NOW = new Date(2026, 6, 24, 15, 0, 0); // 2026-07-24 15:00 本地
const at = (d: number, h: number) => new Date(2026, 6, d, h, 0, 0).toISOString();

/**
 * 事件分派 —— 解析器把帧切出来之后,`sendChatMessage` 按 event 名派活。
 *
 * 这一层单独盯住是因为「多认一种事件」的改动最容易漏在这儿:解析器照常把帧
 * 交出来,派活的地方却没有对应分支,于是事件被静静吃掉,一路查到最后才发现
 * 后端其实一直在发。
 */
describe("sendChatMessage — 事件分派", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** 把几段文本包成一个 SSE 响应,喂给被 stub 的 fetch。 */
	function stubStream(...frames: string[]) {
		const body = new ReadableStream<Uint8Array>({
			start(ctrl) {
				const enc = new TextEncoder();
				for (const f of frames) ctrl.enqueue(enc.encode(f));
				ctrl.close();
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);
	}

	const doneFrame = (reply: object = {}) =>
		`event: done\ndata: ${JSON.stringify({
			user: { id: "u1", role: "user", content: "问", ts: "t" },
			reply: { id: "a1", role: "assistant", content: "答", ts: "t", ...reply },
			conversation: { id: "c1", title: "t", createdAt: "t", updatedAt: "t", messageCount: 2 },
		})}\n\n`;

	it("tool 帧派给 onTool,两拍都到", async () => {
		stubStream(
			`event: tool\ndata: {"phase":"start","id":"0-0","name":"list_subscriptions","args":{}}\n\n`,
			`event: tool\ndata: {"phase":"end","id":"0-0","ok":true}\n\n`,
			doneFrame(),
		);
		const seen: unknown[] = [];
		await sendChatMessage("c1", "问", { onDelta: () => {}, onTool: (e) => seen.push(e) });

		expect(seen).toEqual([
			{ phase: "start", id: "0-0", name: "list_subscriptions", args: {} },
			{ phase: "end", id: "0-0", ok: true },
		]);
	});

	it("tool 帧不会被当成正文塞进回复里", async () => {
		stubStream(
			`event: delta\ndata: {"text":"查到"}\n\n`,
			`event: tool\ndata: {"phase":"start","id":"0-0","name":"x","args":{}}\n\n`,
			`event: delta\ndata: {"text":"了"}\n\n`,
			doneFrame(),
		);
		const text: string[] = [];
		await sendChatMessage("c1", "问", { onDelta: (t) => text.push(t), onTool: () => {} });
		expect(text.join("")).toBe("查到了");
	});

	it("不关心工具时不传 onTool 也不炸", async () => {
		stubStream(
			`event: tool\ndata: {"phase":"start","id":"0-0","name":"x","args":{}}\n\n`,
			doneFrame(),
		);
		await expect(sendChatMessage("c1", "问", { onDelta: () => {} })).resolves.toMatchObject({
			reply: { content: "答" },
		});
	});

	it("done 里回复带的工具痕迹原样交出去 —— 交接那一帧要拿它顶上", async () => {
		stubStream(doneFrame({ tools: [{ name: "get_user_info", args: { uid: "1" }, ok: true }] }));
		const res = await sendChatMessage("c1", "问", { onDelta: () => {} });
		expect(res.reply.tools).toEqual([{ name: "get_user_info", args: { uid: "1" }, ok: true }]);
	});

	it("reasoning 帧派给 onReasoning,不混进正文", async () => {
		stubStream(
			`event: reasoning\ndata: {"text":"主人问的是"}\n\n`,
			`event: reasoning\ndata: {"text":"订阅"}\n\n`,
			`event: delta\ndata: {"text":"晚上好"}\n\n`,
			doneFrame(),
		);
		const think: string[] = [];
		const text: string[] = [];
		await sendChatMessage("c1", "问", {
			onDelta: (t) => text.push(t),
			onReasoning: (t) => think.push(t),
		});
		expect(think).toEqual(["主人问的是", "订阅"]);
		expect(text).toEqual(["晚上好"]);
	});

	it("不关心思考时不传 onReasoning 也不炸", async () => {
		stubStream(`event: reasoning\ndata: {"text":"想想"}\n\n`, doneFrame());
		await expect(sendChatMessage("c1", "问", { onDelta: () => {} })).resolves.toMatchObject({
			reply: { content: "答" },
		});
	});

	it("done 里回复带的思考原样交出去 —— 交接那一帧要拿它顶上", async () => {
		stubStream(doneFrame({ reasoning: "想了一下" }));
		const res = await sendChatMessage("c1", "问", { onDelta: () => {} });
		expect(res.reply.reasoning).toBe("想了一下");
	});
});

describe("groupLabel", () => {
	it("同一本地日 → 今天", () => {
		expect(groupLabel(at(24, 1), NOW)).toBe("今天");
		expect(groupLabel(at(24, 14), NOW)).toBe("今天");
	});

	it("前一本地日 → 昨天", () => {
		expect(groupLabel(at(23, 23), NOW)).toBe("昨天");
	});

	it("更早 → 更早", () => {
		expect(groupLabel(at(20, 12), NOW)).toBe("更早");
	});

	it("按日界而不是 24 小时窗口 —— 凌晨聊的那句下午仍是「今天」", () => {
		// 24 小时窗口的话,00:30 那条到了 15:00 还在窗口内没问题;但 23 日 23:00
		// 那条距今才 16 小时,会被算成「今天」—— 明明是昨晚的事。
		expect(groupLabel(at(23, 23), NOW)).toBe("昨天");
	});

	it("时间戳是脏值 → 归到「更早」,不抛也不显示 Invalid Date", () => {
		expect(groupLabel("不是时间", NOW)).toBe("更早");
	});
});

describe("groupConversations", () => {
	const meta = (id: string, updatedAt: string) => ({
		id,
		title: id,
		createdAt: updatedAt,
		updatedAt,
		messageCount: 2,
	});

	it("按标签成组,组内保持服务端给的倒序", () => {
		const got = groupConversations(
			[meta("a", at(24, 14)), meta("b", at(24, 9)), meta("c", at(23, 20)), meta("d", at(19, 8))],
			NOW,
		);
		expect(got.map((g) => g.label)).toEqual(["今天", "昨天", "更早"]);
		expect(got[0]?.items.map((i) => i.id)).toEqual(["a", "b"]);
		expect(got[2]?.items.map((i) => i.id)).toEqual(["d"]);
	});

	it("空列表 → 空分组,不产出一个空的「今天」标题", () => {
		expect(groupConversations([], NOW)).toEqual([]);
	});

	it("全在同一组时只有一个标题", () => {
		const got = groupConversations([meta("a", at(24, 14)), meta("b", at(24, 9))], NOW);
		expect(got).toHaveLength(1);
	});
});

describe("sendChatMessage — 会话级胶囊 flags", () => {
	/** 最小可用的 SSE 响应:一个 done 事件。 */
	function doneRes() {
		const payload = `event: done\ndata: ${JSON.stringify({ user: {}, reply: {}, conversation: { id: "c1" } })}\n\n`;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode(payload));
				c.close();
			},
		});
		return new Response(body, { status: 200 });
	}

	it("两颗胶囊点亮 → 请求体带 thinking/search:true", async () => {
		const fetchMock = vi.fn(async () => doneRes());
		vi.stubGlobal("fetch", fetchMock);
		await sendChatMessage("c1", "问", { onDelta: () => {} }, undefined, {
			thinking: true,
			search: true,
		});
		const body = JSON.parse(
			((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body as string,
		);
		expect(body).toMatchObject({ thinking: true, search: true });
		vi.unstubAllGlobals();
	});

	it("皮肤工坊 → 请求体带 mode:skin", async () => {
		const fetchMock = vi.fn(async () => doneRes());
		vi.stubGlobal("fetch", fetchMock);
		await sendChatMessage("c1", "做套皮肤", { onDelta: () => {} }, undefined, { mode: "skin" });
		const body = JSON.parse(
			((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body as string,
		);
		expect(body).toMatchObject({ mode: "skin" });
		vi.unstubAllGlobals();
	});

	it("日常聊天 → 请求体压根没有 mode 键(不带 = 只读窗口,写能力不会漏出来)", async () => {
		const fetchMock = vi.fn(async () => doneRes());
		vi.stubGlobal("fetch", fetchMock);
		await sendChatMessage("c1", "问", { onDelta: () => {} }, undefined, { mode: "chat" });
		const body = JSON.parse(
			((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body as string,
		);
		expect("mode" in body).toBe(false);
		vi.unstubAllGlobals();
	});

	it("胶囊全灭 / 不传 flags → 请求体里根本没有这两个键(不带 = 关)", async () => {
		const fetchMock = vi.fn(async () => doneRes());
		vi.stubGlobal("fetch", fetchMock);
		await sendChatMessage("c1", "问", { onDelta: () => {} });
		const body = JSON.parse(
			((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body as string,
		);
		expect("thinking" in body).toBe(false);
		expect("search" in body).toBe(false);
		vi.unstubAllGlobals();
	});
});
