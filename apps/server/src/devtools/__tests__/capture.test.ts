import type {
	AdapterCapabilities,
	NotificationPayload,
	PushAdapter,
	PushTarget,
} from "@bilibili-notify/internal";
import { isReachabilityEvidence } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PlatformAdapter } from "../../platforms/types.js";
import { createCaptureGate } from "../capture.js";

/**
 * D1 截流:推送出口(`PlatformAdapter.send`)外面套一层。**默认真发**;截流开着时不真发、
 * 记一条、回 `ok`(历史照记 delivered,不为调试改 history schema —— 面板上那份截流列表才是
 * 对照)。别的方法一律透传,可选方法有就有、没有就没有 —— 「没实现 = 什么都不支持」这条
 * 判定靠的是方法在不在。
 */

const ADAPTER: PushAdapter = {
	id: "ad-1",
	name: "测试 OneBot",
	platform: "onebot",
	enabled: true,
} as unknown as PushAdapter;

const TARGET: PushTarget = {
	id: "t-1",
	name: "测试群",
	adapterId: "ad-1",
	platform: "onebot",
	scope: "group",
	enabled: true,
	session: { groupId: "123" },
} as unknown as PushTarget;

function fakeInner(extra: Partial<PlatformAdapter> = {}) {
	const send = vi.fn<PlatformAdapter["send"]>(async () => ({ ok: true, latencyMs: 7 }));
	const inner: PlatformAdapter = {
		platforms: ["onebot"],
		isAvailable: () => true,
		send,
		probe: async () => ({ ok: true, latencyMs: 3 }),
		...extra,
	};
	return { inner, send };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-06T08:00:00.000Z"));
});
afterEach(() => {
	vi.useRealTimers();
});

describe("createCaptureGate", () => {
	it("默认关着:send 原样透传,列表为空", async () => {
		const gate = createCaptureGate();
		const { inner, send } = fakeInner();
		const wrapped = gate.wrap(inner);
		const payload: NotificationPayload = { kind: "text", text: "hi" };

		const res = await wrapped.send(ADAPTER, TARGET, payload, { private: true });

		expect(send).toHaveBeenCalledWith(ADAPTER, TARGET, payload, { private: true });
		expect(res).toEqual({ ok: true, latencyMs: 7 });
		expect(gate.enabled()).toBe(false);
		expect(gate.entries()).toEqual([]);
	});

	it("开着:不真发、记一条摘要、回 ok", async () => {
		const gate = createCaptureGate();
		const { inner, send } = fakeInner();
		const wrapped = gate.wrap(inner);
		gate.enable();

		const res = await wrapped.send(ADAPTER, TARGET, {
			kind: "composite",
			segments: [
				{ type: "at-all" },
				{ type: "text", text: "开播啦" },
				{ type: "image", buffer: Buffer.from("x"), mime: "image/png" },
				{ type: "link", href: "https://live.bilibili.com/1", title: "直播间" },
			],
		});

		expect(send).not.toHaveBeenCalled();
		expect(res).toEqual({ ok: true, latencyMs: 0, synthetic: true });
		expect(gate.entries()).toEqual([
			{
				id: "1",
				at: Date.parse("2026-09-06T08:00:00.000Z"),
				adapterId: "ad-1",
				adapterName: "测试 OneBot",
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
			{ kind: "forward-images", images: [{ url: "a" }, { url: "b" }], forward: true },
			{ kind: "forward-images", images: 2 },
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
	])("各种载荷都摘得出:%j", async (payload, expected) => {
		const gate = createCaptureGate();
		const wrapped = gate.wrap(fakeInner().inner);
		gate.enable();
		await wrapped.send(ADAPTER, TARGET, payload);
		expect(gate.entries()[0]).toMatchObject(expected);
	});

	it("长文本截到 200 字,免得面板被一整篇周报撑爆", async () => {
		const gate = createCaptureGate();
		const wrapped = gate.wrap(fakeInner().inner);
		gate.enable();
		await wrapped.send(ADAPTER, TARGET, { kind: "text", text: "字".repeat(500) });
		expect(gate.entries()[0]?.text).toHaveLength(201);
		expect(gate.entries()[0]?.text?.endsWith("…")).toBe(true);
	});

	it("列表封顶 200 条,满了丢最旧的", async () => {
		const gate = createCaptureGate();
		const wrapped = gate.wrap(fakeInner().inner);
		gate.enable();
		for (let i = 0; i < 205; i++) {
			await wrapped.send(ADAPTER, TARGET, { kind: "text", text: `#${i}` });
		}
		const entries = gate.entries();
		expect(entries).toHaveLength(200);
		expect(entries[0]?.text).toBe("#5");
		expect(entries.at(-1)?.text).toBe("#204");
	});

	it("关掉之后又真发;列表留着直到清空", async () => {
		const gate = createCaptureGate();
		const { inner, send } = fakeInner();
		const wrapped = gate.wrap(inner);
		gate.enable();
		await wrapped.send(ADAPTER, TARGET, { kind: "text", text: "a" });
		gate.disable();
		await wrapped.send(ADAPTER, TARGET, { kind: "text", text: "b" });

		expect(send).toHaveBeenCalledTimes(1);
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

	it("别的方法透传;可选方法有就有、没有就没有", async () => {
		const gate = createCaptureGate();
		const bare = gate.wrap(fakeInner().inner);
		expect(bare.reconcile).toBeUndefined();
		expect(bare.dispose).toBeUndefined();
		expect(bare.capabilities).toBeUndefined();
		expect(bare.probeCapabilities).toBeUndefined();
		expect(bare.platforms).toEqual(["onebot"]);
		expect(bare.isAvailable(ADAPTER, TARGET)).toBe(true);
		expect(await bare.probe(ADAPTER)).toEqual({ ok: true, latencyMs: 3 });

		const reconcile = vi.fn();
		const dispose = vi.fn();
		const caps: AdapterCapabilities = { miniAppCard: { state: "supported", checkedAt: 1 } };
		const full = gate.wrap(
			fakeInner({
				reconcile,
				dispose,
				capabilities: () => caps,
				probeCapabilities: async () => caps,
			}).inner,
		);
		full.reconcile?.([ADAPTER]);
		await full.dispose?.();
		expect(reconcile).toHaveBeenCalledWith([ADAPTER]);
		expect(dispose).toHaveBeenCalledOnce();
		expect(full.capabilities?.(ADAPTER)).toBe(caps);
		expect(await full.probeCapabilities?.(ADAPTER)).toBe(caps);
	});

	it("拦下来那条回的结果标了 synthetic —— 它没出网,不能拿去翻目标的可达状态", async () => {
		// 回 ok 是为了让调用链照常跑完(推送引擎、历史那行都当它成了)。但 sink 的
		// onDelivery 会拿同一个结果去写 target.testStatus —— 那是落盘、还广播
		// config-changed 的。截流期间把一个发不出去的目标标成绿的,还活得比截流久。
		const gate = createCaptureGate();
		const { inner } = fakeInner();
		gate.enable();
		const res = await gate.wrap(inner).send(ADAPTER, TARGET, { kind: "text", text: "x" });
		expect(res).toMatchObject({ ok: true, synthetic: true });
		expect(isReachabilityEvidence(res)).toBe(false);
	});
	it("count() 只回条数,不拷整张表 —— 生效条每几秒念一次拦下几条", async () => {
		const gate = createCaptureGate();
		const { inner } = fakeInner();
		gate.enable();
		const wrapped = gate.wrap(inner);
		await wrapped.send(ADAPTER, TARGET, { kind: "text", text: "1" });
		await wrapped.send(ADAPTER, TARGET, { kind: "text", text: "2" });
		expect(gate.count()).toBe(2);
		expect(gate.count()).toBe(gate.entries().length);
	});
	it("包装器不认识的成员也原样带过去 —— 接口日后多一个方法,这里不用跟、也不会悄悄丢", () => {
		const gate = createCaptureGate();
		const { inner } = fakeInner();
		const extra = () => "extra";
		const wrapped = gate.wrap({ ...inner, extra } as typeof inner);
		expect((wrapped as unknown as { extra: () => string }).extra).toBe(extra);
	});
});
