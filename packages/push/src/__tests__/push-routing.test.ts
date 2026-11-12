/**
 * 单元测试 — `PushRouter.push` 的 routing 决策(只有本体那一个锚点的推送)。
 *
 * 这是 push 链路的"路由网关":sub.features → sub.routing → quietHours 三道 gate
 * 后才到 dispatcher.send。任何环节走错 = 用户看到漏推 / 推错目标 / 免扰失效。
 *
 * 锁住:
 *   - 无订阅 / 无 routing 不调 dispatcher
 *   - features=false 总开关短路(配 defaults provider 时)
 *   - quietHours 命中时不发
 *   - atAll 修饰仅作用于 dynamic / live,且按折叠后的 extras 默认 + tristate 覆写决定
 *   - onSend 回调每个 target 触发一次,target 字段填
 */

import { Buffer } from "node:buffer";
import {
	type DeliveryResult,
	FEATURE_KEYS,
	type GlobalDefaults,
	makeDefaultGlobalSettings,
	makeEmptySubscription,
	type NotificationPayload,
	type PushTarget,
	type Subscription,
	sameIdentity,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it, vi } from "vite-plus/test";
import { PushRouter, type PushSendResult } from "../push-router";
import {
	type FakeDispatcher,
	makeExtensionSub,
	pushBase,
	pushMain,
	setExtraDefault,
	silentLogger,
} from "./helpers";

interface SendCall {
	targetId: string;
	payload: NotificationPayload;
}

function makeDispatcher(opts?: { available?: boolean; atAll?: (id: string) => boolean }): {
	dispatcher: FakeDispatcher;
	calls: SendCall[];
} {
	const available = opts?.available ?? true;
	const calls: SendCall[] = [];
	const dispatcher: FakeDispatcher = {
		isAvailable: () => available,
		supportsAtAll: opts?.atAll ?? (() => true),
		isEnabled: () => true,
		send: async (targetId, payload) => {
			calls.push({ targetId, payload });
			return { ok: true, latencyMs: 1 } as DeliveryResult;
		},
		resolve: (id) =>
			({
				id,
				name: id,
				connectionId: "a",
				platform: "test",
				scope: "group",
				enabled: true,
			}) as unknown as PushTarget,
	};
	return { dispatcher, calls };
}

function makeStore(subs: Subscription[]): SubscriptionStore {
	return {
		list: () => [...subs],
		findByIdentity: (identity) =>
			subs.find((s) => sameIdentity(subscriptionIdentityOf(s), identity)),
		listByIdentity: (identity) =>
			subs.filter((s) => sameIdentity(subscriptionIdentityOf(s), identity)),
		findById: (id) => subs.find((s) => s.id === id),
		upsert: () => {},
		removeById: () => undefined,
		replaceAll: () => {},
	};
}

function loopbackDefaults(): GlobalDefaults {
	// 任意 features=true、quietHours=空,使 runtime gate 直接放行
	const g = makeDefaultGlobalSettings();
	for (const k of FEATURE_KEYS) g.defaults.features[k] = true;
	g.defaults.schedule.quietHours = [];
	return g.defaults;
}

describe("PushRouter.push — routing decision", () => {
	it("订阅 id 查不到 → 不调 dispatcher", async () => {
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([]),
			logger: silentLogger,
		});
		push.start();
		const out = await pushMain(push, "nope", "liveStart", { kind: "text", text: "x" });
		expect(out).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	it("routing 空数组 → 不调 dispatcher", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		await pushMain(push, "s1", "liveStart", { kind: "text", text: "x" });
		expect(calls).toHaveLength(0);
	});

	it("routing 命中两个 target → dispatcher.send 调两次", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1", "t2"];
		setExtraDefault(sub, "atAllLiveStart", false); // 排除 @全体 路径的额外 send 调用,只验证路由
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		await pushMain(push, "s1", "liveStart", { kind: "text", text: "开播了" });
		expect(calls.map((c) => c.targetId)).toEqual(["t1", "t2"]);
	});

	it("features.X=false(defaults provider)→ 短路,不调 dispatcher", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1"];
		const defaults = loopbackDefaults();
		defaults.features.liveStart = false;
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
			defaults: () => defaults,
		});
		push.start();
		await pushMain(push, "s1", "liveStart", { kind: "text", text: "x" });
		expect(calls).toHaveLength(0);
	});

	it("quietHours 命中(0-24)→ 全天免扰,不发", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1"];
		const defaults = loopbackDefaults();
		defaults.schedule.quietHours = [{ start: 0, end: 0 }]; // 整天免扰
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
			defaults: () => defaults,
		});
		push.start();
		await pushMain(push, "s1", "liveStart", { kind: "text", text: "x" });
		expect(calls).toHaveLength(0);
	});

	it("quietHours 按 quietHoursNow 给的那一刻判,不按真时钟 —— devtools「当作现在是 xx:xx」靠它", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1"];
		const defaults = loopbackDefaults();
		defaults.schedule.quietHours = [{ start: 2, end: 4 }]; // 凌晨 2-4 点免扰
		const { dispatcher, calls } = makeDispatcher();
		let pretend = new Date("2026-09-06T03:00:00+08:00"); // 上海 03:00，落在免扰里
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
			defaults: () => defaults,
			quietHoursNow: () => pretend,
		});
		push.start();
		await pushMain(push, "s1", "liveStart", { kind: "text", text: "x" });
		expect(calls).toHaveLength(0);

		pretend = new Date("2026-09-06T15:00:00+08:00"); // 上海 15:00，放行
		await pushMain(push, "s1", "liveStart", { kind: "text", text: "y" });
		// live 默认带 @全体,所以是两条;这里只关心「放行了」。
		expect(calls.length).toBeGreaterThan(0);
	});

	it("extras.atAllPost 默认为 true → @全体单独一条 + 原 payload 两条独立消息", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.post = ["t1"];
		setExtraDefault(sub, "atAllPost", true);
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		await pushMain(push, "s1", "post", { kind: "text", text: "动态" });
		expect(calls).toHaveLength(2);
		// 第 1 条:@全体 单独一条 composite,只含 at-all 段
		expect(calls[0].payload.kind).toBe("composite");
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments).toEqual([{ kind: "at-all" }]);
		}
		// 第 2 条:原 payload 原样不变(卡片 + 文字保持单独消息形态)
		expect(calls[1].payload).toEqual({ kind: "text", text: "动态" });
	});

	it("atAll tristate 覆写:per-target false 强 OFF + 顺序 plain → @全体 → 原 payload", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1", "t2"];
		setExtraDefault(sub, "atAllLiveStart", true);
		sub.extraTargets.atAllLiveStart = { t1: false }; // 显式关 t1 的 @全体,t2 走 default=true
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		await pushMain(push, "s1", "liveStart", { kind: "text", text: "开播" });
		// t1 一条原 payload;t2 先收 @全体 only,再收原 payload。共 3 条。
		expect(calls).toHaveLength(3);
		expect(calls[0]).toMatchObject({ targetId: "t1" });
		expect(calls[0].payload.kind).toBe("text"); // t1 plain,原 payload
		expect(calls[1]).toMatchObject({ targetId: "t2" });
		expect(calls[1].payload.kind).toBe("composite"); // t2 第 1 条 @全体 only
		if (calls[1].payload.kind === "composite") {
			expect(calls[1].payload.segments).toEqual([{ kind: "at-all" }]);
		}
		expect(calls[2]).toMatchObject({ targetId: "t2" });
		expect(calls[2].payload).toEqual({ kind: "text", text: "开播" }); // t2 第 2 条原 payload
	});

	it("目标平台不支持 @全体(QQ 官方机器人)→ 订阅默认开着也不单发 @全体,只发原 payload", async () => {
		// 真机撞上的:唯一目标是官机、订阅默认「开播 @全体」开着、三态表里没这个目标。
		// 以前照样进 @全体 分支,单发一条只含 at-all 段的消息 —— 官机适配器把那一段丢掉,
		// 剩下空消息,每次开播都记一条「empty payload」失败;抽屉里这种目标的 @全体开关
		// 却一直显示为关、还写着「发送时会自动跳过」。
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1"];
		setExtraDefault(sub, "atAllLiveStart", true);
		const { dispatcher, calls } = makeDispatcher({ atAll: () => false });
		const seen: PushSendResult[] = [];
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
			onSend: (info) => seen.push(info),
		});
		push.start();
		await pushMain(push, "s1", "liveStart", { kind: "text", text: "开播" });
		await new Promise((r) => setTimeout(r, 0));
		expect(calls.map((c) => c.payload)).toEqual([{ kind: "text", text: "开播" }]);
		// 历史那一行也不该多出一条「@全体」附加项。
		expect(seen).toHaveLength(1);
		expect(seen[0]?.messages.map((m) => m.role)).toEqual(["main"]);
	});

	it("@全体 的分流问派发器的 supportsAtAll:回 false 的目标不进 @全体,回 true 的照进(目标对象上的 platform 不参与)", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1", "t2"];
		setExtraDefault(sub, "atAllLiveStart", true);
		const { dispatcher, calls } = makeDispatcher({ atAll: (id) => id !== "t1" });
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		await pushMain(push, "s1", "liveStart", { kind: "text", text: "开播" });
		await new Promise((r) => setTimeout(r, 0));
		const atAllCalls = calls.filter((c) => c.payload.kind === "composite");
		expect(atAllCalls.map((c) => c.targetId)).toEqual(["t2"]);
		expect(calls.filter((c) => c.targetId === "t1").map((c) => c.payload.kind)).toEqual(["text"]);
	});

	it("allowAtAll: false → 抑制 @全体,即使 feature=liveStart 且 extras.atAllLiveStart 默认为 true(本次 bug 修复:周期「正在直播」)", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1", "t2"];
		setExtraDefault(sub, "atAllLiveStart", true);
		sub.extraTargets.atAllLiveStart = { t1: true }; // 即便 per-target 显式 true 也得被抑制
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		await pushMain(
			push,
			"s1",
			"liveStart",
			{ kind: "text", text: "正在直播" },
			{ allowAtAll: false },
		);
		expect(calls.map((c) => c.targetId)).toEqual(["t1", "t2"]); // 仍正常路由
		for (const c of calls) expect(c.payload.kind).toBe("text"); // 但都没 at-all 头
	});

	it("不传 allowAtAll → 按 feature 决定(开播仍 @全体)", async () => {
		const mk = () => {
			const sub = makeEmptySubscription({
				id: "s1",
				identity: { sourceKey: "bilibili", externalId: "u1" },
			});
			sub.routing.liveStart = ["t1"];
			setExtraDefault(sub, "atAllLiveStart", true);
			return sub;
		};
		const assertAtAllThenPayload = (calls: SendCall[]) => {
			// 单 target 走 atAll 路径 → @全体 only + 原 payload 两条
			expect(calls).toHaveLength(2);
			expect(calls[0].payload.kind).toBe("composite");
			if (calls[0].payload.kind === "composite") {
				expect(calls[0].payload.segments).toEqual([{ kind: "at-all" }]);
			}
			expect(calls[1].payload).toEqual({ kind: "text", text: "开播" });
		};
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([mk()]),
			logger: silentLogger,
		});
		push.start();
		await pushMain(push, "s1", "liveStart", { kind: "text", text: "开播" });
		assertAtAllThenPayload(calls);
	});

	it("@全体 单独一条 → composite [image,text] 原 payload 第二条(live)", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1"];
		setExtraDefault(sub, "atAllLiveStart", true);
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		const payload: NotificationPayload = {
			kind: "composite",
			segments: [
				{ kind: "image", buffer: Buffer.from([1]), mime: "image/jpeg" },
				{ kind: "text", text: "开播啦" },
			],
		};
		await pushMain(push, "s1", "liveStart", payload);
		expect(calls).toHaveLength(2);
		// 第 1 条:@全体 only
		expect(calls[0].payload.kind).toBe("composite");
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments).toEqual([{ kind: "at-all" }]);
		}
		// 第 2 条:原 [image, text] 不改不重组
		if (calls[1].payload.kind === "composite") {
			expect(calls[1].payload.segments.map((s) => s.kind)).toEqual(["image", "text"]);
		}
	});

	it("@全体 单独一条对 post 同样生效(共用同一条分支)", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.post = ["t1"];
		setExtraDefault(sub, "atAllPost", true);
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		await pushMain(push, "s1", "post", {
			kind: "composite",
			segments: [
				{ kind: "image", buffer: Buffer.from([3]), mime: "image/jpeg" },
				{ kind: "text", text: "发了条动态" },
			],
		});
		expect(calls).toHaveLength(2);
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments).toEqual([{ kind: "at-all" }]);
		}
		if (calls[1].payload.kind === "composite") {
			expect(calls[1].payload.segments.map((s) => s.kind)).toEqual(["image", "text"]);
		}
	});

	it("@全体 单独一条:image+caption / text-only 原 payload 都保持原样不变", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1"];
		setExtraDefault(sub, "atAllLiveStart", true);
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		await pushMain(push, "s1", "liveStart", {
			kind: "image",
			image: { buffer: Buffer.from([2]), mime: "image/png" },
			caption: "字幕",
		});
		expect(calls).toHaveLength(2);
		// 第 1 条:@全体 only
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments).toEqual([{ kind: "at-all" }]);
		}
		// 第 2 条:image+caption 原样(不被升级为 composite)
		expect(calls[1].payload.kind).toBe("image");
		if (calls[1].payload.kind === "image") {
			expect(calls[1].payload.caption).toBe("字幕");
		}
		// 纯文本无图 → 同样两条:@全体 only + text 原 payload
		calls.length = 0;
		await pushMain(push, "s1", "liveStart", { kind: "text", text: "无图开播" });
		expect(calls).toHaveLength(2);
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments).toEqual([{ kind: "at-all" }]);
		}
		expect(calls[1].payload).toEqual({ kind: "text", text: "无图开播" });
	});

	it("image-group + atAllTargets:同样先发独立 @全体 再发合并转发", async () => {
		// 合并转发节点跟外层独立 @全体 不冲突,一视同仁两条发出,@ 提醒在前。
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.post = ["t1"];
		setExtraDefault(sub, "atAllPost", true);
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		await pushMain(push, "s1", "post", {
			kind: "image-group",
			images: [{ url: "http://x/1.jpg" }],
			mergeForward: true,
		});
		expect(calls).toHaveLength(2);
		// 第 1 条:@全体 only
		expect(calls[0].payload.kind).toBe("composite");
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments).toEqual([{ kind: "at-all" }]);
		}
		// 第 2 条:原 image-group 原样
		expect(calls[1].payload.kind).toBe("image-group");
	});

	it("非 post / liveStart 的 feature 不进入 atAll 分支(superchat 即使 extras.atAllPost=true)", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.superchat = ["t1"];
		setExtraDefault(sub, "atAllPost", true); // 无效字段,不应影响 superchat
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		await pushMain(push, "s1", "superchat", { kind: "text", text: "SC" });
		expect(calls[0].payload.kind).toBe("text"); // 没 at-all 头
	});

	it("@全体 发送卡死不阻塞卡片正文:卡片照常发出、push 正常返回", async () => {
		// 回归:无管理权限的群发 @全体 会触发协议端拒绝 + adapter 重试,旧版顺序
		// await @全体 会把卡片正文连同 push 一起拖到重试结束。现在
		// @全体 best-effort 即发不 await,卡片不再被它拖住。
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1"];
		setExtraDefault(sub, "atAllLiveStart", true);
		const calls: SendCall[] = [];
		const isAtAll = (p: NotificationPayload) =>
			p.kind === "composite" && p.segments.length === 1 && p.segments[0]?.kind === "at-all";
		const dispatcher: FakeDispatcher = {
			isAvailable: () => true,
			supportsAtAll: () => true,
			isEnabled: () => true,
			// @全体 这条永不 resolve(模拟无权限群的重试卡死);卡片正文立即成功。
			send: (targetId, payload) => {
				calls.push({ targetId, payload });
				if (isAtAll(payload)) return new Promise<DeliveryResult>(() => {});
				return Promise.resolve({ ok: true, latencyMs: 1 } as DeliveryResult);
			},
			resolve: (id) =>
				({
					id,
					name: id,
					connectionId: "a",
					platform: "test",
					scope: "group",
					enabled: true,
				}) as unknown as PushTarget,
		};
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		// 旧版会在此处永久挂起;现在应在卡片发出后立即返回。
		const out = await pushMain(push, "s1", "liveStart", { kind: "text", text: "开播" });
		// @全体 与卡片都被发起(顺序:@全体 在前),且 @全体 同步先入 dispatcher。
		expect(calls.map((c) => c.targetId)).toEqual(["t1", "t1"]);
		expect(isAtAll(calls[0].payload)).toBe(true);
		expect(calls[1].payload).toEqual({ kind: "text", text: "开播" });
		// 返回里只含已完成的卡片结果(@全体 仍 in-flight,不计入返回值)。
		expect(out).toHaveLength(1);
		expect(out[0].ok).toBe(true);
	});

	// 关停(切片 ③):@全体 即发不等,它落地后追加的那次 onSend 会把这条落进历史。不登记进 track 的话,
	// 关停返回、历史写道关门之后这次回调才到 —— 那条 @全体 的历史就丢了。
	it("@全体 落地后追加的那次 onSend 登记进 track:回调交出去它才落定", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1"];
		setExtraDefault(sub, "atAllLiveStart", true);
		const isAtAll = (p: NotificationPayload) =>
			p.kind === "composite" && p.segments.length === 1 && p.segments[0]?.kind === "at-all";
		let landAtAll!: (result: DeliveryResult) => void;
		const atAllLanded = new Promise<DeliveryResult>((resolve) => {
			landAtAll = resolve;
		});
		const dispatcher: FakeDispatcher = {
			isAvailable: () => true,
			supportsAtAll: () => true,
			isEnabled: () => true,
			send: (_targetId, payload) =>
				isAtAll(payload)
					? atAllLanded
					: Promise.resolve({ ok: true, latencyMs: 1 } as DeliveryResult),
			resolve: (id) =>
				({
					id,
					name: id,
					connectionId: "a",
					platform: "test",
					scope: "group",
					enabled: true,
				}) as unknown as PushTarget,
		};
		const tracked: Promise<unknown>[] = [];
		const sent: PushSendResult[] = [];
		const push = new PushRouter({
			...pushBase(),
			serviceCtx: { ...pushBase().serviceCtx, track: (task) => void tracked.push(task) },
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
			onSend: (info) => sent.push(info),
		});
		push.start();

		await pushMain(push, "s1", "liveStart", { kind: "text", text: "开播" });

		// 卡片那次回调已经交出去了;@全体 还在路上 —— 登记着的这件事不许落。
		expect(sent).toHaveLength(1);
		expect(tracked).toHaveLength(1);
		let settled = false;
		void Promise.all(tracked).then(() => {
			settled = true;
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(settled).toBe(false);

		landAtAll({ ok: true, latencyMs: 2 });
		await Promise.all(tracked);
		expect(sent).toHaveLength(2);
		expect(sent[1]?.messages[0]).toMatchObject({ role: "extra", result: { ok: true } });
	});

	it("onSend 每个 target 触发一次,target 字段填", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.post = ["t1", "t2"];
		const onSend = vi.fn();
		const { dispatcher } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
			onSend,
		});
		push.start();
		await pushMain(push, "s1", "post", { kind: "text", text: "x" });
		expect(onSend).toHaveBeenCalledTimes(2);
		const calls = onSend.mock.calls.map((c) => c[0]);
		expect(calls[0]).toMatchObject({ subscriptionId: "s1", feature: "post" });
		expect(calls[0].target.id).toBe("t1");
	});
});

/**
 * 推送链的运行期键是**订阅自己的 id**,不是 B 站 uid(ADR-0019 决策 50)。
 *
 * 按 uid 找的年代,同一个 uid 配了两条订阅时「先出现的那条说了算」,第二条的路由整条被
 * 无视;拓展订阅没有 uid,压根找不到。这两条钉的就是那两个洞。
 */
describe("PushRouter.push — 按订阅 id 找订阅", () => {
	it("两条 uid 相同、路由不同的 B 站订阅:按 B 的 id 广播只发到 B 的目标", async () => {
		const a = makeEmptySubscription({
			id: "sA",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		a.routing.liveStart = ["tA"];
		const b = makeEmptySubscription({
			id: "sB",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		b.routing.liveStart = ["tB"];
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([a, b]),
			logger: silentLogger,
		});
		push.start();
		await pushMain(push, "sB", "liveStart", { kind: "text", text: "x" }, { allowAtAll: false });
		expect(calls.map((c) => c.targetId)).toEqual(["tB"]);
	});

	it("拓展来源的订阅(外部 id 不是 uid)按 id 广播能路由到它的目标,onSend 带的是它的订阅 id", async () => {
		const ext = makeExtensionSub({ id: "sE", externalId: "u1" });
		ext.routing.post = ["tE"];
		setExtraDefault(ext, "atAllPost", false);
		const seen: PushSendResult[] = [];
		const { dispatcher, calls } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([ext]),
			logger: silentLogger,
			onSend: (info) => seen.push(info),
		});
		push.start();
		await pushMain(push, "sE", "post", { kind: "text", text: "x" });
		expect(calls.map((c) => c.targetId)).toEqual(["tE"]);
		expect(seen.map((i) => i.subscriptionId)).toEqual(["sE"]);
	});
});

/**
 * 日志参数保留订阅 id 和中立身份，来源键与外部 id 分开记录。
 * 仅影响日志，发送仍按订阅 id 路由。
 */
describe("PushRouter.push — 日志里的订阅标签", () => {
	async function gateLogEntry(sub: Subscription) {
		const defaults = loopbackDefaults();
		defaults.features.liveStart = false;
		const lines: { msg: string; args: unknown[] }[] = [];
		const { dispatcher } = makeDispatcher();
		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store: makeStore([sub]),
			logger: {
				...silentLogger,
				debug: (msg: string, ...args: unknown[]) => lines.push({ msg, args }),
			},
			defaults: () => defaults,
		});
		push.start();
		await pushMain(push, sub.id, "liveStart", { kind: "text", text: "x" });
		return lines[0];
	}

	it("B 站订阅也用来源键和外部 id", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveStart = ["t1"];
		expect(await gateLogEntry(sub)).toEqual({
			msg: "特性总开关已关闭，跳过推送",
			args: [
				{
					event: "push.feature_disabled",
					subscriptionId: "s1",
					identity: { sourceKey: "bilibili", externalId: "u1" },
					feature: "liveStart",
				},
			],
		});
	});

	it("拓展订阅 → <拓展 id>:<外部 id>", async () => {
		const ext = makeExtensionSub({ id: "sE", extensionId: "douyin", externalId: "sec-1" });
		ext.routing.liveStart = ["tE"];
		expect(await gateLogEntry(ext)).toEqual({
			msg: "特性总开关已关闭，跳过推送",
			args: [
				{
					event: "push.feature_disabled",
					subscriptionId: "sE",
					identity: { sourceKey: "douyin", externalId: "sec-1" },
					feature: "liveStart",
				},
			],
		});
	});
});
