import type { Connection, NotificationPayload, PushTarget } from "@bilibili-notify/internal";
import { isReachabilityEvidence } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createCaptureGate } from "../capture.js";

/**
 * D1 截流:接在派发器调适配器 `send` 的那一处(`interceptSend`)。**默认真发**(回 `undefined`
 * 放行);截流开着时不真发、记一条、回 `ok`(历史照记 delivered,不为调试改 history schema ——
 * 面板上那份截流列表才是对照)。
 */

const CONNECTION: Connection = {
	id: "ad-1",
	name: "测试 OneBot",
	kind: "direct",
	platform: "onebot",
	enabled: true,
} as unknown as Connection;

const TARGET: PushTarget = {
	id: "t-1",
	name: "测试群",
	connectionId: "ad-1",
	platform: "onebot",
	kind: "session",
	scope: "group",
	address: "123",
	enabled: true,
} as unknown as PushTarget;

function call(
	gate: ReturnType<typeof createCaptureGate>,
	payload: NotificationPayload,
	over: { isProvisional?: boolean; target?: PushTarget } = {},
) {
	return gate.intercept({
		connection: CONNECTION,
		target: over.target ?? TARGET,
		isProvisional: over.isProvisional ?? false,
		payload,
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-06T08:00:00.000Z"));
});
afterEach(() => {
	vi.useRealTimers();
});

describe("createCaptureGate", () => {
	it("默认关着:放行(回 undefined),列表为空", () => {
		const gate = createCaptureGate();

		expect(call(gate, { kind: "text", text: "hi" })).toBeUndefined();

		expect(gate.enabled()).toBe(false);
		expect(gate.entries()).toEqual([]);
	});

	it("开着:记一条摘要、回 ok", () => {
		const gate = createCaptureGate();
		gate.enable();

		const res = call(gate, {
			kind: "composite",
			segments: [
				{ kind: "at-all" },
				{ kind: "text", text: "开播啦" },
				{ kind: "image", buffer: Buffer.from("x"), mime: "image/png" },
				{ kind: "link", href: "https://live.bilibili.com/1", title: "直播间" },
			],
		});

		expect(res).toEqual({ ok: true, latencyMs: 0, isSynthetic: true });
		expect(gate.entries()).toEqual([
			{
				id: "1",
				at: Date.parse("2026-09-06T08:00:00.000Z"),
				connectionId: "ad-1",
				connectionName: "测试 OneBot",
				platform: "onebot",
				targetId: "t-1",
				targetName: "测试群",
				private: false,
				kind: "composite",
				text: "@全体\n开播啦\n直播间 https://live.bilibili.com/1",
				images: 1,
			},
		]);
	});

	it("目标是私聊会话记 private:true,群目标记 false(由目标自己的 scope 算)", () => {
		const gate = createCaptureGate();
		gate.enable();
		call(
			gate,
			{ kind: "text", text: "x" },
			{ target: { ...TARGET, scope: "private" } as PushTarget },
		);
		call(gate, { kind: "text", text: "x" });
		expect(gate.entries().map((e) => e.private)).toEqual([true, false]);
	});

	it("按会话坐标发的:目标名显示成「群 <地址>」/「私聊 <地址>」", () => {
		const gate = createCaptureGate();
		gate.enable();
		const session = (scope: "group" | "private", address: string) =>
			({ ...TARGET, id: `session:${scope}:${address}`, scope, address }) as PushTarget;

		call(
			gate,
			{ kind: "text", text: "a" },
			{ target: session("group", "123"), isProvisional: true },
		);
		call(
			gate,
			{ kind: "text", text: "b" },
			{ target: session("private", "456"), isProvisional: true },
		);

		expect(gate.entries().map((e) => e.targetName)).toEqual(["群 123", "私聊 456"]);
		expect(gate.entries()[0]?.targetId).toBe("session:group:123");
	});

	it.each<[NotificationPayload, { kind: string; text?: string; images: number }]>([
		[
			{ kind: "text", text: "纯文本" },
			{ kind: "text", text: "纯文本", images: 0 },
		],
		[
			{ kind: "image", image: { buffer: Buffer.from("x"), mime: "image/png" }, caption: "说明" },
			{ kind: "image", text: "说明", images: 1 },
		],
		[
			{ kind: "image-group", images: [{ url: "a" }, { url: "b" }], mergeForward: true },
			{ kind: "image-group", images: 2 },
		],
		[
			{
				kind: "miniapp-card",
				title: "标题",
				desc: "d",
				picUrl: "p",
				path: "pages/x",
				jumpUrl: "j",
			},
			{ kind: "miniapp-card", text: "标题", images: 0 },
		],
	])("各种载荷都摘得出:%j", (payload, expected) => {
		const gate = createCaptureGate();
		gate.enable();
		call(gate, payload);
		expect(gate.entries()[0]).toMatchObject(expected);
	});

	it("长文本截到 200 字,免得面板被一整篇周报撑爆", () => {
		const gate = createCaptureGate();
		gate.enable();
		call(gate, { kind: "text", text: "字".repeat(500) });
		expect(gate.entries()[0]?.text).toHaveLength(201);
		expect(gate.entries()[0]?.text?.endsWith("…")).toBe(true);
	});

	it("列表封顶 200 条,满了丢最旧的", () => {
		const gate = createCaptureGate();
		gate.enable();
		for (let i = 0; i < 205; i++) call(gate, { kind: "text", text: `#${i}` });
		const entries = gate.entries();
		expect(entries).toHaveLength(200);
		expect(entries[0]?.text).toBe("#5");
		expect(entries.at(-1)?.text).toBe("#204");
	});

	it("关掉之后又放行;列表留着直到清空", () => {
		const gate = createCaptureGate();
		gate.enable();
		expect(call(gate, { kind: "text", text: "a" })).toBeDefined();
		gate.disable();
		expect(call(gate, { kind: "text", text: "b" })).toBeUndefined();

		expect(gate.entries().map((e) => e.text)).toEqual(["a"]);
		gate.clear();
		expect(gate.entries()).toEqual([]);
	});

	it("时间窗:开一次记一段,关了封口,清历史后从头记", () => {
		const gate = createCaptureGate();
		gate.enable();
		vi.setSystemTime(new Date("2026-09-06T08:10:00.000Z"));
		gate.disable();
		vi.setSystemTime(new Date("2026-09-06T08:20:00.000Z"));
		gate.enable();

		expect(gate.windows()).toEqual([
			{ from: Date.parse("2026-09-06T08:00:00.000Z"), to: Date.parse("2026-09-06T08:10:00.000Z") },
			{ from: Date.parse("2026-09-06T08:20:00.000Z"), to: null },
		]);

		// 清完历史:已封口的窗丢掉,开着的那段从「现在」重新起算 —— 否则再清一次把同一段又删一遍。
		vi.setSystemTime(new Date("2026-09-06T08:30:00.000Z"));
		gate.resetWindows();
		expect(gate.windows()).toEqual([{ from: Date.parse("2026-09-06T08:30:00.000Z"), to: null }]);
	});

	it("连开两次不叠窗", () => {
		const gate = createCaptureGate();
		gate.enable();
		gate.enable();
		expect(gate.windows()).toHaveLength(1);
		gate.disable();
		gate.disable();
		expect(gate.windows()).toHaveLength(1);
	});

	it("拦下来那条回的结果标了 isSynthetic —— 它没出网,不能拿去翻目标的可达状态", () => {
		// 回 ok 是为了让调用链照常跑完(推送引擎、历史那行都当它成了)。但 dispatcher 的
		// onDelivery 会拿同一个结果去写 target.testStatus —— 那是落盘、还广播
		// config-changed 的。截流期间把一个发不出去的目标标成绿的,还活得比截流久。
		const gate = createCaptureGate();
		gate.enable();
		const res = call(gate, { kind: "text", text: "x" });
		expect(res).toMatchObject({ ok: true, isSynthetic: true });
		if (!res) throw new Error("unreachable");
		expect(isReachabilityEvidence(res)).toBe(false);
	});

	it("count() 只回条数,不拷整张表 —— 生效条每几秒念一次拦下几条", () => {
		const gate = createCaptureGate();
		gate.enable();
		call(gate, { kind: "text", text: "1" });
		call(gate, { kind: "text", text: "2" });
		expect(gate.count()).toBe(2);
		expect(gate.count()).toBe(gate.entries().length);
	});
});
