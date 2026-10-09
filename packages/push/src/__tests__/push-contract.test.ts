/**
 * `PushRouter.push` 的推送契约 —— 历史一行 = 一次推送 × 一个目标。
 *
 * 锁住:
 *   - 一个锚点对每个目标只回调 `onSend` 一次,带这一段的全部消息与逐条结果
 *   - `pushId` 由推送层自己生成:同一次推送里各目标、各锚点拿到同一个,另一次是新的
 *   - 某条失败仍中止该目标后续条:失败那条在消息列表里,被中止的不在
 *   - 可用目标为零(没配,或配的全停用)→ 以 `target: null` 回调一次,不调 dispatcher、不重试
 *   - 停用目标不当候选:只推给启用的,停用的既不发也不记
 *   - 附加项(`role: "extra"`)与本体分开标;@全体 恒为附加项,且在本体那次回调之后
 *   - 交进来时特性关着 / 订阅不在 → 一律不回调 —— 那不是「无目标」
 *   - 交进来时在静音 / 免扰里 → 一条都不发,但照样按目标回调,消息带 `isSilenced`、没有结果(文末「被静音 / 免扰挡下的推送照记」)
 *   - 上面这四样只在交进来时判一次(文末「一次推送只判一次」);锚点按先后发(「一次推送按锚点发」)
 */

import {
	type DeliveryResult,
	FEATURE_KEYS,
	fail,
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
	pushBase,
	pushMain,
	setExtraDefault,
	silentLogger,
	trackedPushBase,
} from "./helpers";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const M1: NotificationPayload = { kind: "text", text: "m1" };
const M2: NotificationPayload = { kind: "text", text: "m2" };
const M3: NotificationPayload = { kind: "text", text: "m3" };

function textOf(p: NotificationPayload): string {
	if (p.kind === "text") return p.text;
	if (p.kind === "composite" && p.segments[0]?.kind === "at-all") return "@全体";
	return p.kind;
}

interface DispatcherOptions {
	/** 哪些目标停用了(配置层面);缺省全启用。 */
	disabled?: string[];
	/** 按 (targetId, 该目标第几次 send) 指定失败。 */
	failOn?: (targetId: string, nth: number) => boolean;
}

function makeDispatcher(opts: DispatcherOptions = {}) {
	const calls: Array<{ targetId: string; payload: NotificationPayload }> = [];
	const perTarget = new Map<string, number>();
	const isAvailable = vi.fn(() => true);
	const dispatcher: FakeDispatcher = {
		isAvailable,
		supportsAtAll: () => true,
		isEnabled: (id) => !opts.disabled?.includes(id),
		send: async (targetId, payload) => {
			const nth = (perTarget.get(targetId) ?? 0) + 1;
			perTarget.set(targetId, nth);
			calls.push({ targetId, payload });
			if (opts.failOn?.(targetId, nth)) return fail("unavailable", "boom");
			return { ok: true, latencyMs: 1 } as DeliveryResult;
		},
		resolve: (id) =>
			({
				id,
				name: id,
				connectionId: "a",
				platform: "test",
				scope: "group",
				enabled: !opts.disabled?.includes(id),
			}) as unknown as PushTarget,
	};
	return { dispatcher, calls, isAvailable };
}

function makeStore(subs: Subscription[]): SubscriptionStore {
	return {
		list: () => [...subs],
		findByIdentity: (identity) =>
			subs.find((s) => sameIdentity(subscriptionIdentityOf(s), identity)),
		findById: (id) => subs.find((s) => s.id === id),
		upsert: () => {},
		removeById: () => undefined,
		replaceAll: () => {},
	};
}

function subWith(targets: string[], atAll = false): Subscription {
	const sub = makeEmptySubscription({
		id: "s1",
		identity: { sourceKey: "bilibili", externalId: "u1" },
	});
	sub.routing.post = [...targets];
	setExtraDefault(sub, "atAllPost", atAll);
	return sub;
}

function setup(sub: Subscription, dispatcherOpts: DispatcherOptions = {}) {
	const { dispatcher, calls, isAvailable } = makeDispatcher(dispatcherOpts);
	const seen: PushSendResult[] = [];
	const { base, settled } = trackedPushBase();
	const push = new PushRouter({
		...base,
		dispatcher,
		store: makeStore([sub]),
		logger: silentLogger,
		onSend: (info) => seen.push(info),
	});
	push.start();
	return { push, calls, seen, isAvailable, settled };
}

/**
 * 一次回调压成 `[目标, [文案, role, ok]...]`,方便整体比对。
 *
 * `ok: null` 有两种来源,在这一层刻意压成同一个:无目标行的每一条,和被中止、
 * 从没出过网的那几条(ADR-0017 决策 17)。两者本就是同一个形状 ——「没有结果」。
 */
function flat(info: PushSendResult): [string | null, Array<[string, string, boolean | null]>] {
	return [
		info.target?.id ?? null,
		// `PushSendResult` 是个联合,无目标那一支的消息类型上压根没有 `result` 这个键,
		// 所以得先 `in` 一道再取。
		info.messages.map((m) => [
			textOf(m.payload),
			m.role,
			"result" in m ? (m.result?.ok ?? null) : null,
		]),
	];
}

describe("推送契约:一个锚点 × 每个目标回调一次", () => {
	it("两个目标各收两条 → 回调两次,各带整段消息与逐条结果,pushId 相同", async () => {
		const { push, seen } = setup(subWith([T1, T2]));
		await pushMain(push, "s1", "post", [M1, M2]);
		expect(seen.map(flat)).toEqual([
			[
				T1,
				[
					["m1", "main", true],
					["m2", "main", true],
				],
			],
			[
				T2,
				[
					["m1", "main", true],
					["m2", "main", true],
				],
			],
		]);
		expect(seen[0]?.pushId).toBe(seen[1]?.pushId);
		expect(seen[0]).toMatchObject({ subscriptionId: "s1", feature: "post" });
	});

	it("pushId 是推送层自己生成的:同一次推送里各目标同一个;另一次是新的", async () => {
		const { push, seen } = setup(subWith([T1, T2]));
		await pushMain(push, "s1", "post", M1);
		await pushMain(push, "s1", "post", M1);
		const ids = seen.map((s) => s.pushId);
		expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(ids[0]).toBe(ids[1]);
		expect(ids[2]).toBe(ids[3]);
		expect(ids[2]).not.toBe(ids[0]);
	});

	/**
	 * **中止仍是中止 —— 只是不再静默。** 被挡下的那几条照样出现在列表里,结果是 `null`
	 * (没有 `result` = 从没出过网,ADR-0017 决策 17)。它们没有进 dispatcher,这一点由
	 * `payload-sequence.test.ts` 的「被中止的那几条一次都没进 dispatcher」钉着。
	 *
	 * 为什么要记:人工重推的按钮上写着「补 N 条」,而从前这一行只剩 2 条,第 3 条连存在过
	 * 都看不出来 —— 补不回来,也查不出少了什么。
	 */
	it("某条失败仍中止该目标后续条:失败那条在列表里,被中止的也在(没有结果);别的目标不受牵连", async () => {
		const { push, seen } = setup(subWith([T1, T2]), {
			failOn: (id, nth) => id === T1 && nth === 2,
		});
		await pushMain(push, "s1", "post", [M1, M2, M3]);
		expect(seen.map(flat)).toEqual([
			[
				T1,
				[
					["m1", "main", true],
					["m2", "main", false],
					["m3", "main", null], // 被中止,从没出过网
				],
			],
			[
				T2,
				[
					["m1", "main", true],
					["m2", "main", true],
					["m3", "main", true],
				],
			],
		]);
	});

	it("role: 本体锚点标本体,附加项锚点(图集 / 词云 / 总结)标附加项", async () => {
		const { push, seen, settled } = setup(subWith([T1]));
		await push.push({
			subscriptionId: "s1",
			feature: "post",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", messages: [M2] },
			],
		});
		await settled();
		expect(seen.map(flat)).toEqual([
			[T1, [["m1", "main", true]]],
			[T1, [["m2", "extra", true]]],
		]);
	});
});

/**
 * 历史行记的就是这次推送的那把特性键(⑬f):回调的 `feature` 原样是 `push()` 收到的那把,
 * 不另带一份「推送种类」—— 补报与周期各记什么,由引擎选哪把键推决定(见 `engine-push-adapters.test.ts`)。
 */
describe("推送契约:历史记的就是这次推送的特性键", () => {
	it.each(FEATURE_KEYS)(
		"%s:回调带的 feature 就是交进来的那把,没有第二个种类字段",
		async (feature) => {
			const sub = subWith([]);
			sub.routing[feature] = [T1];
			const { push, seen } = setup(sub);
			// 开播默认会 @全体(再回调一次),这里只看本体那一次。
			await pushMain(push, "s1", feature, M1, { allowAtAll: false });
			expect(seen).toHaveLength(1);
			expect(seen[0]?.feature).toBe(feature);
			expect(seen[0]).not.toHaveProperty("kind");
		},
	);

	it("同一订阅连着推两把不同的键,各记各的(补报记开播、周期记正在直播的前提)", async () => {
		const sub = subWith([]);
		sub.routing.liveStart = [T1];
		sub.routing.liveStreaming = [T1];
		const { push, seen } = setup(sub);
		await pushMain(push, "s1", "liveStart", M1, { allowAtAll: false });
		await pushMain(push, "s1", "liveStreaming", M2, { allowAtAll: false });
		expect(seen.map((s) => s.feature)).toEqual(["liveStart", "liveStreaming"]);
	});

	it("无目标那次回调也带 feature", async () => {
		const { push, seen } = setup(subWith([]));
		await pushMain(push, "s1", "post", M1);
		expect(seen[0]).toMatchObject({ target: null, feature: "post" });
		expect(seen[0]).not.toHaveProperty("kind");
	});
});

describe("推送契约:无可用目标", () => {
	it("没配目标 → target:null 回调一次,消息照带(没有结果),不调 dispatcher,返回空", async () => {
		const { push, seen, calls } = setup(subWith([]));
		const out = await pushMain(push, "s1", "post", [M1, M2]);
		expect(out).toEqual([]);
		expect(calls).toHaveLength(0);
		expect(seen.map(flat)).toEqual([
			[
				null,
				[
					["m1", "main", null],
					["m2", "main", null],
				],
			],
		]);
		expect(seen[0]).toMatchObject({ subscriptionId: "s1", feature: "post" });
	});

	it("配了目标但全停用 → 同样是无目标;停用的不进可达性重试", async () => {
		const { push, seen, calls, isAvailable } = setup(subWith([T1, T2]), {
			disabled: [T1, T2],
		});
		await pushMain(push, "s1", "post", M1);
		expect(calls).toHaveLength(0);
		expect(isAvailable).not.toHaveBeenCalled();
		expect(seen.map(flat)).toEqual([[null, [["m1", "main", null]]]]);
	});

	it("一个启用一个停用 → 只推给启用的;停用的既不发也不记", async () => {
		const { push, seen, calls } = setup(subWith([T1, T2]), { disabled: [T2] });
		await pushMain(push, "s1", "post", M1);
		expect(calls.map((c) => c.targetId)).toEqual([T1]);
		expect(seen.map(flat)).toEqual([[T1, [["m1", "main", true]]]]);
	});

	it("附加项的锚点也走无目标:同一 pushId 再回调一次 target:null", async () => {
		const { push, seen, settled } = setup(subWith([]));
		await push.push({
			subscriptionId: "s1",
			feature: "post",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", messages: [M2] },
			],
		});
		await settled();
		expect(seen[0]?.pushId).toBe(seen[1]?.pushId);
		expect(seen.map(flat)).toEqual([
			[null, [["m1", "main", null]]],
			[null, [["m2", "extra", null]]],
		]);
	});
});

describe("推送契约:@全体 是附加项", () => {
	it("本体那次回调在前;@全体 单独一次回调、标 extra、同一 pushId 同一目标", async () => {
		const { push, seen } = setup(subWith([T1], true));
		await pushMain(push, "s1", "post", [M1, M2]);
		// @全体 是 fire-and-forget,等它落地。
		await vi.waitFor(() => expect(seen).toHaveLength(2));
		expect(seen.map(flat)).toEqual([
			[
				T1,
				[
					["m1", "main", true],
					["m2", "main", true],
				],
			],
			[T1, [["@全体", "extra", true]]],
		]);
		expect(seen[0]?.pushId).toBe(seen[1]?.pushId);
	});

	it("@全体 发失败 → 本体照旧记成功,附加项那次回调带失败结果", async () => {
		const { push, seen } = setup(subWith([T1], true), {
			failOn: (id, nth) => id === T1 && nth === 1,
		});
		await pushMain(push, "s1", "post", M1);
		await vi.waitFor(() => expect(seen).toHaveLength(2));
		expect(seen.map(flat)).toEqual([
			[T1, [["m1", "main", true]]],
			[T1, [["@全体", "extra", false]]],
		]);
	});
});

describe("推送契约:特性关着 / 订阅不在,不算无目标", () => {
	it("特性关着 → 不回调、不记", async () => {
		const sub = subWith([]);
		sub.overrides = { features: { post: false } };
		const { push, seen } = setup(sub);
		await pushMain(push, "s1", "post", M1);
		expect(seen).toHaveLength(0);
	});

	it("订阅本身没有 → 不回调、不记", async () => {
		const { push, seen } = setup(subWith([]));
		await pushMain(push, "nobody", "post", M1);
		expect(seen).toHaveLength(0);
	});

	// 闸序:先算目标、再记被挡。静音期间一个可用目标都没有的推送,落的是「无目标」那一行(不是被挡)。
	it("全局静音 + 没有可用目标 → 照落「无目标」:回调 target:null,消息不带 isSilenced", async () => {
		const { dispatcher } = makeDispatcher();
		const seen: PushSendResult[] = [];
		const push = new PushRouter({
			...pushBase(),
			muted: () => true,
			dispatcher,
			store: makeStore([subWith([])]),
			logger: silentLogger,
			onSend: (info) => seen.push(info),
		});
		push.start();
		await pushMain(push, "s1", "post", M1);
		expect(seen.map(flat)).toEqual([[null, [["m1", "main", null]]]]);
		expect(seen[0]?.messages[0]).not.toHaveProperty("isSilenced");
	});
});

/** 一个由用例决定何时兑现 / 拒绝的约定。 */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** 让已经就绪的微任务与 0ms 定时器都跑完:断言「此刻还没发」之前用。 */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const QUIET = new Date(2026, 8, 6, 3, 0, 0); // 03:00,落在 2-4 点的免扰里
const AWAKE = new Date(2026, 8, 6, 15, 0, 0);

function setupPush(sub: Subscription = subWith([T1, T2])) {
	const subs = [sub];
	const { dispatcher, calls } = makeDispatcher();
	const seen: PushSendResult[] = [];
	const warns: string[] = [];
	const { base, tracked, settled } = trackedPushBase();
	const defaults = base.defaults();
	defaults.schedule.quietHours = [{ start: 2, end: 4 }];
	const clock = { now: AWAKE, muted: false };
	const router = new PushRouter({
		...base,
		dispatcher,
		store: makeStore(subs),
		logger: { ...silentLogger, warn: (message: unknown) => void warns.push(String(message)) },
		onSend: (info) => seen.push(info),
		muted: () => clock.muted,
		quietHoursNow: () => clock.now,
	});
	router.start();
	const sent = () => calls.map((c) => [c.targetId, textOf(c.payload)]);
	return { router, subs, sub, defaults, clock, calls, seen, sent, warns, tracked, settled };
}

type PushSetup = ReturnType<typeof setupPush>;

/**
 * 一次「被挡」的回调压成 `[目标, [文案, role]...]`;顺手断言这一段每条消息都带 `isSilenced: true`、
 * 而且没有结果 —— 被挡不是失败,也不是「没发出去的后续条」。
 */
function silenced(info: PushSendResult): [string | null, Array<[string, string]>] {
	for (const m of info.messages) {
		expect(m).toMatchObject({ isSilenced: true });
		expect(m).not.toHaveProperty("result");
	}
	return [info.target?.id ?? null, info.messages.map((m) => [textOf(m.payload), m.role])];
}

/** 用例期间进程里冒出来的未处理拒绝;收尾时应当一条都没有。 */
function watchUnhandledRejections() {
	const reasons: unknown[] = [];
	const onUnhandled = (reason: unknown) => void reasons.push(reason);
	process.on("unhandledRejection", onUnhandled);
	return {
		reasons,
		async stop() {
			await tick();
			await tick();
			process.off("unhandledRejection", onUnhandled);
		},
	};
}

/**
 * 一次推送整个交进来(ADR-0021 决策 34 的 🔗,10-08):订阅在不在、总开关、全局静音、免扰时段
 * 在 `push()` 交进来那一刻判一次,裁决管整次推送;之后各锚点不再看这四样。
 * 按目标判的(路由复查、附加项三态表、@全体)照旧每个锚点发出时现判。
 */
describe("一次推送只判一次", () => {
	/** 交进来之后才变的那四样,各一个方向。 */
	const turnsBlocking: Array<[string, (s: PushSetup) => void, (s: PushSetup) => void]> = [
		[
			"免扰时段",
			(s) => {
				s.clock.now = QUIET;
			},
			(s) => {
				s.clock.now = AWAKE;
			},
		],
		[
			"全局静音",
			(s) => {
				s.clock.muted = true;
			},
			(s) => {
				s.clock.muted = false;
			},
		],
		[
			"总开关",
			(s) => {
				s.defaults.features.post = false;
			},
			(s) => {
				s.defaults.features.post = true;
			},
		],
	];

	it.each(turnsBlocking)("交进来时放行,之后%s挡上 → 后面的锚点照发", async (_name, block) => {
		const s = setupPush();
		const later = deferred<NotificationPayload[]>();
		await s.router.push({
			subscriptionId: "s1",
			feature: "post",
			allowAtAll: false,
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", messages: later.promise },
			],
		});
		block(s);
		later.resolve([M2]);
		await s.settled();
		expect(s.sent()).toEqual([
			[T1, "m1"],
			[T2, "m1"],
			[T1, "m2"],
			[T2, "m2"],
		]);
	});

	// 时间上的挡(免扰、静音)管整次推送:交进来时挡下了,之后放开,后面才做好的锚点也一起算被挡 ——
	// 一条都不发,照样按目标记下来(见文末「被静音 / 免扰挡下的推送照记」)。
	it.each(turnsBlocking.slice(0, 2))(
		"交进来时被%s挡下,之后放开 → 本体与后面的锚点都不发,都记成被挡;做不出来的跳过",
		async (_name, block, unblock) => {
			const s = setupPush();
			const unhandled = watchUnhandledRejections();
			const later = deferred<NotificationPayload[]>();
			const broken = deferred<NotificationPayload[]>();
			block(s);
			const out = await s.router.push({
				subscriptionId: "s1",
				feature: "post",
				anchors: [
					{ role: "main", messages: [M1] },
					{ role: "extra", messages: later.promise },
					{ role: "extra", messages: broken.promise },
				],
			});
			expect(out).toEqual([]);
			unblock(s);
			later.resolve([M2]);
			broken.reject(new Error("总结没写出来"));
			await s.settled();
			await unhandled.stop();
			expect(s.calls).toHaveLength(0);
			expect(s.seen.map(silenced)).toEqual([
				[T1, [["m1", "main"]]],
				[T2, [["m1", "main"]]],
				[T1, [["m2", "extra"]]],
				[T2, [["m2", "extra"]]],
			]);
			expect(s.warns).toHaveLength(1);
			expect(unhandled.reasons).toEqual([]);
		},
	);

	it("交进来时总开关关着,之后打开 → 不发、不回调(什么都不留),约定有人接着", async () => {
		const s = setupPush();
		const unhandled = watchUnhandledRejections();
		const later = deferred<NotificationPayload[]>();
		const broken = deferred<NotificationPayload[]>();
		s.defaults.features.post = false;
		const out = await s.router.push({
			subscriptionId: "s1",
			feature: "post",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", messages: later.promise },
				{ role: "extra", messages: broken.promise },
			],
		});
		expect(out).toEqual([]);
		s.defaults.features.post = true;
		later.resolve([M2]);
		broken.reject(new Error("总结没写出来"));
		await s.settled();
		await unhandled.stop();
		expect(s.calls).toHaveLength(0);
		expect(s.seen).toHaveLength(0);
		expect(unhandled.reasons).toEqual([]);
	});

	it("交进来时订阅不在 → 之后补上了也不发,约定有人接着", async () => {
		const s = setupPush();
		const unhandled = watchUnhandledRejections();
		const broken = deferred<NotificationPayload[]>();
		s.subs.length = 0;
		await s.router.push({
			subscriptionId: "s1",
			feature: "post",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", messages: broken.promise },
			],
		});
		s.subs.push(s.sub);
		broken.reject(new Error("boom"));
		await s.settled();
		await unhandled.stop();
		expect(s.calls).toHaveLength(0);
		expect(s.seen).toHaveLength(0);
		expect(unhandled.reasons).toEqual([]);
	});

	// 订阅没了就没有路由可查:后面的锚点静默丢掉,不发、不回调(不是「无目标」,也不落失败行)。
	it("交进来之后订阅被删 → 后面的锚点不发、不回调", async () => {
		const s = setupPush();
		const later = deferred<NotificationPayload[]>();
		await s.router.push({
			subscriptionId: "s1",
			feature: "post",
			allowAtAll: false,
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", messages: later.promise },
			],
		});
		const before = { calls: s.calls.length, seen: s.seen.length };
		s.subs.length = 0;
		later.resolve([M2]);
		await s.settled();
		expect(s.calls).toHaveLength(before.calls);
		expect(s.seen).toHaveLength(before.seen);
	});

	it("交进来之后目标被移出路由 → 后面的锚点不再发给它", async () => {
		const s = setupPush();
		const later = deferred<NotificationPayload[]>();
		await s.router.push({
			subscriptionId: "s1",
			feature: "post",
			allowAtAll: false,
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", messages: later.promise },
			],
		});
		s.sub.routing.post = [T1];
		later.resolve([M2]);
		await s.settled();
		expect(s.sent()).toEqual([
			[T1, "m1"],
			[T2, "m1"],
			[T1, "m2"],
		]);
		// 被移出的那个目标在这个锚点上连回调都没有:它不是「发失败」,是这个锚点本来就没它。
		expect(s.seen.map(flat)).toEqual([
			[T1, [["m1", "main", true]]],
			[T2, [["m1", "main", true]]],
			[T1, [["m2", "extra", true]]],
		]);
	});

	it("各锚点的回调带同一个 pushId(推送层自己生成);另一次推送是新的", async () => {
		const s = setupPush(subWith([T1]));
		const once = () =>
			s.router.push({
				subscriptionId: "s1",
				feature: "post",
				allowAtAll: false,
				anchors: [
					{ role: "main", messages: [M1] },
					{ role: "extra", messages: [M2] },
					{ role: "extra", extra: "wordcloud", messages: Promise.resolve([M3]) },
				],
			});
		await once();
		await s.settled();
		await once();
		await s.settled();
		const ids = s.seen.map((info) => info.pushId);
		expect(ids).toHaveLength(6);
		expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(new Set(ids.slice(0, 3)).size).toBe(1);
		expect(new Set(ids.slice(3)).size).toBe(1);
		expect(ids[3]).not.toBe(ids[0]);
	});
});

/** 锚点:内容各做各的,发送按先后;本体发完就返回,其余在后台。 */
describe("一次推送按锚点发", () => {
	const WORDCLOUD: NotificationPayload = { kind: "text", text: "词云" };
	const SUMMARY: NotificationPayload = { kind: "text", text: "总结" };

	function liveEndSub(): Subscription {
		const sub = subWith([]);
		sub.routing.liveEnd = [T1];
		setExtraDefault(sub, "wordcloud", true);
		setExtraDefault(sub, "liveSummary", true);
		return sub;
	}

	it("后面的锚点先做好也得等:总结先兑现、词云后兑现 → 发出的次序仍是 本体、词云、总结", async () => {
		const s = setupPush(liveEndSub());
		const wordcloud = deferred<NotificationPayload[]>();
		const summary = deferred<NotificationPayload[]>();
		await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "wordcloud", messages: wordcloud.promise },
				{ role: "extra", extra: "liveSummary", messages: summary.promise },
			],
		});
		summary.resolve([SUMMARY]);
		await tick();
		expect(s.sent()).toEqual([[T1, "m1"]]);
		wordcloud.resolve([WORDCLOUD]);
		await s.settled();
		expect(s.sent()).toEqual([
			[T1, "m1"],
			[T1, "词云"],
			[T1, "总结"],
		]);
	});

	it("前一个锚点没发完,后一个不发", async () => {
		const sub = liveEndSub();
		const subs = [sub];
		const sentTexts: string[] = [];
		const firstExtra = deferred<DeliveryResult>();
		const { base, settled } = trackedPushBase();
		const dispatcher: FakeDispatcher = {
			isAvailable: () => true,
			supportsAtAll: () => true,
			isEnabled: () => true,
			send: async (_targetId, payload) => {
				sentTexts.push(textOf(payload));
				if (textOf(payload) === "词云") return firstExtra.promise;
				return { ok: true, latencyMs: 1 } as DeliveryResult;
			},
			resolve: (id) =>
				({ id, name: id, connectionId: "a", platform: "test" }) as unknown as PushTarget,
		};
		const router = new PushRouter({
			...base,
			dispatcher,
			store: makeStore(subs),
			logger: silentLogger,
		});
		router.start();
		await router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "wordcloud", messages: [WORDCLOUD] },
				{ role: "extra", extra: "liveSummary", messages: [SUMMARY] },
			],
		});
		await tick();
		expect(sentTexts).toEqual(["m1", "词云"]);
		firstExtra.resolve({ ok: true, latencyMs: 1 } as DeliveryResult);
		await settled();
		expect(sentTexts).toEqual(["m1", "词云", "总结"]);
	});

	it("空的锚点跳过(空数组 / 约定给了 undefined),后面的照发", async () => {
		const s = setupPush(liveEndSub());
		await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", messages: [] },
				{ role: "extra", extra: "wordcloud", messages: Promise.resolve(undefined) },
				{ role: "extra", extra: "liveSummary", messages: Promise.resolve([SUMMARY]) },
			],
		});
		await s.settled();
		expect(s.seen.map(flat)).toEqual([
			[T1, [["m1", "main", true]]],
			[T1, [["总结", "extra", true]]],
		]);
	});

	it("空的锚点连「无目标」那一行都不落(没配目标时只有有内容的锚点各回调一次)", async () => {
		const sub = liveEndSub();
		sub.routing.liveEnd = [];
		const s = setupPush(sub);
		await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [] },
				{ role: "extra", extra: "wordcloud", messages: Promise.resolve(undefined) },
				{ role: "extra", extra: "liveSummary", messages: [SUMMARY] },
			],
		});
		await s.settled();
		expect(s.seen.map(flat)).toEqual([[null, [["总结", "extra", null]]]]);
	});

	it("约定被拒绝 → 记一条警告、跳过、不回调,后面的照发,没有未处理的拒绝", async () => {
		const s = setupPush(liveEndSub());
		const unhandled = watchUnhandledRejections();
		const wordcloud = deferred<NotificationPayload[]>();
		await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "wordcloud", messages: wordcloud.promise },
				{ role: "extra", extra: "liveSummary", messages: [SUMMARY] },
			],
		});
		wordcloud.reject(new Error("词云画不出来"));
		await s.settled();
		await unhandled.stop();
		expect(s.seen.map(flat)).toEqual([
			[T1, [["m1", "main", true]]],
			[T1, [["总结", "extra", true]]],
		]);
		expect(s.warns).toHaveLength(1);
		expect(s.warns[0]).toContain("词云画不出来");
		expect(unhandled.reasons).toEqual([]);
	});

	it("本体发完就返回,此时后面的约定还没兑现;后台的发送登记进 track,发完才落定", async () => {
		const s = setupPush(liveEndSub());
		const summary = deferred<NotificationPayload[]>();
		const out = await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "liveSummary", messages: summary.promise },
			],
		});
		expect(out).toEqual([{ ok: true, latencyMs: 1 }]);
		expect(s.tracked).toHaveLength(1);
		let backgroundDone = false;
		void s.tracked[0]?.then(() => {
			backgroundDone = true;
		});
		await tick();
		expect(backgroundDone).toBe(false);
		expect(s.sent()).toEqual([[T1, "m1"]]);
		summary.resolve([SUMMARY]);
		await s.settled();
		await tick();
		expect(backgroundDone).toBe(true);
		expect(s.sent()).toEqual([
			[T1, "m1"],
			[T1, "总结"],
		]);
	});

	it("只有本体 → 没有后台活可登记", async () => {
		const s = setupPush();
		await s.router.push({
			subscriptionId: "s1",
			feature: "post",
			allowAtAll: false,
			anchors: [{ role: "main", messages: [M1] }],
		});
		expect(s.tracked).toHaveLength(0);
	});

	it("没有本体 → 立即回空,附加项照常发,而且没有 @全体;不给键发给全部路由目标,给了键按三态表收窄", async () => {
		const sub = subWith([T1, T2], true);
		setExtraDefault(sub, "wordcloud", false);
		sub.extraTargets.wordcloud = { [T2]: true };
		const s = setupPush(sub);
		const gallery = deferred<NotificationPayload[]>();
		const out = await s.router.push({
			subscriptionId: "s1",
			feature: "post",
			anchors: [
				{ role: "extra", messages: gallery.promise },
				{ role: "extra", extra: "wordcloud", messages: [M2] },
			],
		});
		expect(out).toEqual([]);
		expect(s.calls).toHaveLength(0);
		gallery.resolve([M1]);
		await s.settled();
		expect(s.sent()).toEqual([
			[T1, "m1"],
			[T2, "m1"],
			[T2, "m2"],
		]);
		expect(s.seen.flatMap((info) => info.messages.map((m) => m.role))).toEqual([
			"extra",
			"extra",
			"extra",
		]);
	});

	it("每个目标各取自己的锚点:A 要词云不要总结、B 相反 → 各自的回调里只有自己的", async () => {
		const sub = liveEndSub();
		sub.routing.liveEnd = [T1, T2];
		sub.extraTargets.wordcloud = { [T2]: false };
		sub.extraTargets.liveSummary = { [T1]: false };
		const s = setupPush(sub);
		await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "wordcloud", messages: Promise.resolve([WORDCLOUD]) },
				{ role: "extra", extra: "liveSummary", messages: Promise.resolve([SUMMARY]) },
			],
		});
		await s.settled();
		expect(s.seen.map(flat)).toEqual([
			[T1, [["m1", "main", true]]],
			[T2, [["m1", "main", true]]],
			[T1, [["词云", "extra", true]]],
			[T2, [["总结", "extra", true]]],
		]);
	});

	it("本体对某个目标失败,不拦它的附加项", async () => {
		const sub = liveEndSub();
		const subs = [sub];
		const { dispatcher, calls } = makeDispatcher({ failOn: (_id, nth) => nth === 1 });
		const { base, settled } = trackedPushBase();
		const router = new PushRouter({
			...base,
			dispatcher,
			store: makeStore(subs),
			logger: silentLogger,
		});
		router.start();
		const out = await router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "wordcloud", messages: [WORDCLOUD] },
			],
		});
		await settled();
		expect(out.map((r) => r.ok)).toEqual([false]);
		expect(calls.map((c) => textOf(c.payload))).toEqual(["m1", "词云"]);
	});

	it("关停之后,还没发的锚点不发", async () => {
		const s = setupPush(liveEndSub());
		const summary = deferred<NotificationPayload[]>();
		await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "liveSummary", messages: summary.promise },
			],
		});
		s.router.stop();
		summary.resolve([SUMMARY]);
		await s.settled();
		expect(s.sent()).toEqual([[T1, "m1"]]);
		expect(s.seen).toHaveLength(1);
	});

	it("停了又起(换了一代)之后,上一代还没发的锚点不发", async () => {
		const s = setupPush(liveEndSub());
		const summary = deferred<NotificationPayload[]>();
		await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "liveSummary", messages: summary.promise },
			],
		});
		s.router.stop();
		s.router.start();
		summary.resolve([SUMMARY]);
		await s.settled();
		expect(s.sent()).toEqual([[T1, "m1"]]);
	});

	it.each([
		["本体没排在第一个", ["extra", "main"]],
		["本体有两个", ["main", "main"]],
	] as const)("%s → 抛(调用方的 bug),约定照样有人接着", async (_name, roles) => {
		const s = setupPush();
		const unhandled = watchUnhandledRejections();
		const broken = deferred<NotificationPayload[]>();
		await expect(
			s.router.push({
				subscriptionId: "s1",
				feature: "post",
				anchors: [
					...roles.map((role) => ({ role, messages: [M1] })),
					{ role: "extra", messages: broken.promise },
				],
			}),
		).rejects.toThrow("本体");
		broken.reject(new Error("boom"));
		await unhandled.stop();
		expect(s.calls).toHaveLength(0);
		expect(unhandled.reasons).toEqual([]);
	});
});

/**
 * 被静音 / 免扰挡下的推送照记(ADR-0021 决策 34 的 🔗,10-08):一条都不发,但每个锚点照常算它该发给
 * 哪些目标(路由 ∩ 启用、附加项三态表收窄),对每个目标回调一次,消息带 `isSilenced: true`、没有结果 ——
 * 宿主据此落 `silenced` 行、存下重推原件。先算目标、再记被挡;被挡时不插 @全体。
 */
describe("被静音 / 免扰挡下的推送照记", () => {
	const WORDCLOUD: NotificationPayload = { kind: "text", text: "词云" };
	const SUMMARY: NotificationPayload = { kind: "text", text: "总结" };

	function liveEndSub(targets: string[] = [T1, T2]): Subscription {
		const sub = subWith([]);
		sub.routing.liveEnd = [...targets];
		setExtraDefault(sub, "wordcloud", true);
		setExtraDefault(sub, "liveSummary", true);
		return sub;
	}

	const blocked: Array<[string, (s: PushSetup) => void]> = [
		[
			"全局静音",
			(s) => {
				s.clock.muted = true;
			},
		],
		[
			"免扰时段",
			(s) => {
				s.clock.now = QUIET;
			},
		],
	];

	it.each(blocked)(
		"%s:不调派发器;每个该收的目标回调一次,消息带 isSilenced、没有结果;同一次推送同一个 pushId",
		async (_name, block) => {
			const s = setupPush(liveEndSub());
			block(s);
			const out = await s.router.push({
				subscriptionId: "s1",
				feature: "liveEnd",
				anchors: [
					{ role: "main", messages: [M1, M2] },
					{ role: "extra", extra: "wordcloud", messages: [WORDCLOUD] },
				],
			});
			await s.settled();
			expect(out).toEqual([]);
			expect(s.calls).toHaveLength(0);
			expect(s.seen.map(silenced)).toEqual([
				[
					T1,
					[
						["m1", "main"],
						["m2", "main"],
					],
				],
				[
					T2,
					[
						["m1", "main"],
						["m2", "main"],
					],
				],
				[T1, [["词云", "extra"]]],
				[T2, [["词云", "extra"]]],
			]);
			expect(new Set(s.seen.map((info) => info.pushId)).size).toBe(1);
			expect(s.seen[0]).toMatchObject({ subscriptionId: "s1", feature: "liveEnd" });
		},
	);

	it("附加项先按三态表收窄、再记被挡:每个目标的回调里只有它本来会收到的", async () => {
		const sub = liveEndSub();
		sub.extraTargets.wordcloud = { [T2]: false };
		sub.extraTargets.liveSummary = { [T1]: false };
		const s = setupPush(sub);
		s.clock.muted = true;
		await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "wordcloud", messages: Promise.resolve([WORDCLOUD]) },
				{ role: "extra", extra: "liveSummary", messages: Promise.resolve([SUMMARY]) },
			],
		});
		await s.settled();
		expect(s.seen.map(silenced)).toEqual([
			[T1, [["m1", "main"]]],
			[T2, [["m1", "main"]]],
			[T1, [["词云", "extra"]]],
			[T2, [["总结", "extra"]]],
		]);
	});

	it("附加项收窄成空 → 这个锚点什么都不记(不是无目标,也不是被挡)", async () => {
		const sub = liveEndSub([T1]);
		sub.extraTargets.wordcloud = { [T1]: false };
		const s = setupPush(sub);
		s.clock.muted = true;
		await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "wordcloud", messages: [WORDCLOUD] },
			],
		});
		await s.settled();
		expect(s.seen.map(silenced)).toEqual([[T1, [["m1", "main"]]]]);
	});

	it("被挡时不插 @全体:该 @ 的目标上也只记本体,没有 @全体 那一条,也没有它的后台活", async () => {
		const s = setupPush(subWith([T1], true));
		s.clock.muted = true;
		await s.router.push({
			subscriptionId: "s1",
			feature: "post",
			anchors: [{ role: "main", messages: [M1] }],
		});
		await s.settled();
		expect(s.calls).toHaveLength(0);
		expect(s.seen.map(silenced)).toEqual([[T1, [["m1", "main"]]]]);
		expect(s.tracked).toHaveLength(0);
	});

	it("没有可用目标 → 照落「无目标」:每个有内容的锚点回调一次 target:null,不带 isSilenced", async () => {
		const s = setupPush(liveEndSub([]));
		s.clock.now = QUIET;
		await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "wordcloud", messages: [WORDCLOUD] },
			],
		});
		await s.settled();
		expect(s.seen.map(flat)).toEqual([
			[null, [["m1", "main", null]]],
			[null, [["词云", "extra", null]]],
		]);
		for (const info of s.seen) expect(info.messages[0]).not.toHaveProperty("isSilenced");
	});

	it("等约定了结再记,按锚点先后:总结先做好也排在词云后面;本体记完 push() 就返回,其余在后台", async () => {
		const s = setupPush(liveEndSub([T1]));
		s.clock.muted = true;
		const wordcloud = deferred<NotificationPayload[]>();
		const summary = deferred<NotificationPayload[]>();
		const out = await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "wordcloud", messages: wordcloud.promise },
				{ role: "extra", extra: "liveSummary", messages: summary.promise },
			],
		});
		expect(out).toEqual([]);
		expect(s.seen.map(silenced)).toEqual([[T1, [["m1", "main"]]]]);
		expect(s.tracked).toHaveLength(1);
		summary.resolve([SUMMARY]);
		await tick();
		expect(s.seen).toHaveLength(1);
		wordcloud.resolve([WORDCLOUD]);
		await s.settled();
		expect(s.seen.map(silenced)).toEqual([
			[T1, [["m1", "main"]]],
			[T1, [["词云", "extra"]]],
			[T1, [["总结", "extra"]]],
		]);
	});

	it("空的锚点跳过;没有本体 → 立即回空,附加项照记", async () => {
		const s = setupPush(liveEndSub([T1]));
		s.clock.muted = true;
		const out = await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "extra", extra: "wordcloud", messages: Promise.resolve(undefined) },
				{ role: "extra", extra: "liveSummary", messages: [SUMMARY] },
			],
		});
		expect(out).toEqual([]);
		await s.settled();
		expect(s.seen.map(silenced)).toEqual([[T1, [["总结", "extra"]]]]);
	});

	it("交进来之后目标被移出路由 / 订阅被删 → 后面的锚点不再为它记", async () => {
		const s = setupPush(liveEndSub());
		s.clock.muted = true;
		const wordcloud = deferred<NotificationPayload[]>();
		const summary = deferred<NotificationPayload[]>();
		await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "wordcloud", messages: wordcloud.promise },
				{ role: "extra", extra: "liveSummary", messages: summary.promise },
			],
		});
		s.sub.routing.liveEnd = [T1];
		wordcloud.resolve([WORDCLOUD]);
		await tick();
		s.subs.length = 0;
		summary.resolve([SUMMARY]);
		await s.settled();
		expect(s.seen.map(silenced)).toEqual([
			[T1, [["m1", "main"]]],
			[T2, [["m1", "main"]]],
			[T1, [["词云", "extra"]]],
		]);
	});

	it("关停之后,还没记的锚点不记", async () => {
		const s = setupPush(liveEndSub([T1]));
		s.clock.muted = true;
		const summary = deferred<NotificationPayload[]>();
		await s.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{ role: "main", messages: [M1] },
				{ role: "extra", extra: "liveSummary", messages: summary.promise },
			],
		});
		s.router.stop();
		summary.resolve([SUMMARY]);
		await s.settled();
		expect(s.seen).toHaveLength(1);
	});

	it("闸序:静音着、总开关也关着 / 订阅不在 → 仍然什么都不留", async () => {
		const off = setupPush(liveEndSub());
		off.clock.muted = true;
		off.defaults.features.liveEnd = false;
		await off.router.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [{ role: "main", messages: [M1] }],
		});
		expect(off.seen).toHaveLength(0);

		const gone = setupPush(liveEndSub());
		gone.clock.muted = true;
		await gone.router.push({
			subscriptionId: "nobody",
			feature: "liveEnd",
			anchors: [{ role: "main", messages: [M1] }],
		});
		expect(gone.seen).toHaveLength(0);
	});
});
