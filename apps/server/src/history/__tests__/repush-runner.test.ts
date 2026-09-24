/**
 * **重推的执行器**(ADR-0017 决策 5、8、10-13、18)。
 *
 * 🔴 **立刻回,后台跑。** 发送层的 `sendToTarget` 光退避就最长约 190s(3→6→12→24→48→96),
 * 一行补 N 条就是 190s × N —— HTTP 请求绝不能同步等着。按下按钮立刻回一句「收到」,
 * 消息一条条补,每补一条就往历史行里追加、`history-updated` 推到面板,那条路早就通着。
 *
 * 发送口固定是 `BilibiliPush.sendToTarget`,因为它**恰好**就是定案里那三条闸的交汇点:
 * 自带退避重试(决策 12:目标不可达不挡,那正是重推要解决的)、每次重试前复检 routing
 * (决策 10:用户已经取消了就停),而静音 / 免扰 / 特性总开关三道都在它**上游**的
 * `broadcastToFeature` 里 —— 走这条路它们天然不参与(决策 11)。
 *
 * 「一条失败即中止后续条」照搬本来的推送语义:失败后大概率继续失败,而且每条都要再等
 * 一轮 190s 的退避;剩下那几条本来就还在行里躺着,下次按按钮照样补得到(决策 18)。
 */

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DeliveryResult,
	type FeatureKey,
	type HistoryEntry,
	makeEmptySubscription,
	type NotificationPayload,
	type Subscription,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { resolveTargetScope } from "../../runtime/target-scope.js";
import { createRepushRunner, type RepushRunner } from "../repush-runner.js";
import { createRepushStore, type RepushStore } from "../repush-store.js";
import { createHistoryStore, type HistoryStore } from "../store.js";

let dataDir: string;
let history: HistoryStore;
let repush: RepushStore;
let runner: RepushRunner;
/** 每次发送记一笔;`fail` 指定第几次(1 起)失败。 */
let sent: Array<{ targetId: string; text: string; subscriptionId: string; feature: FeatureKey }>;
let failOn: (nth: number) => boolean;
/** 卡住发送 —— 用来看「立刻回」。 */
let gate: (() => void) | null;

const SUB = randomUUID();
const T1 = randomUUID();
const OK = { ok: true, latencyMs: 5 };
const FAIL = { ok: false, latencyMs: 7, err: "boom" };

let routed: string[];
let enabled: boolean;

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-runner-"));
	const log = logger();
	repush = createRepushStore({ dataDir, logger: log });
	history = createHistoryStore({ dataDir, bus: createNodeMessageBus(), logger: log, repush });
	sent = [];
	failOn = () => false;
	gate = null;
	routed = [T1];
	enabled = true;
	runner = createRepushRunner({
		history,
		repush,
		send: recordingSend,
		routedTargets: () => routed,
		currentSubscriptionOf: (row) => row.subscriptionId,
		targetEnabled: () => enabled,
		logger: log,
	});
});
afterEach(() => vi.restoreAllMocks());

/** 发送口的替身:记一笔,按 `failOn` 回成败;`gate` 在时先卡住。 */
async function recordingSend(
	targetId: string,
	payload: NotificationPayload,
	routing: { subscriptionId: string; feature: FeatureKey },
): Promise<DeliveryResult> {
	if (gate)
		await new Promise<void>((r) => {
			gate = r;
		});
	sent.push({
		targetId,
		text: payload.kind === "text" ? payload.text : payload.kind,
		subscriptionId: routing.subscriptionId,
		feature: routing.feature,
	});
	return (failOn(sent.length) ? FAIL : OK) as DeliveryResult;
}

const text = (t: string): NotificationPayload => ({ kind: "text", text: t });

/** 放行了才有 `count`;顺带把拒绝的理由印进失败信息(比 `undefined` 好查)。 */
function started(res: Awaited<ReturnType<RepushRunner["start"]>>): number {
	if (!res.ok) throw new Error(`本该放行,却拒了:${res.reason}`);
	return res.count;
}
/** 拒了才有 `reason`。 */
function denied(res: Awaited<ReturnType<RepushRunner["start"]>>): string {
	if (res.ok) throw new Error("本该拒,却放行了");
	return res.reason;
}

/** 落一行:第一条成功、第二条失败、第三条因此从没发出去。 */
async function seedPartial(): Promise<HistoryEntry> {
	return history.record({
		pushId: randomUUID(),
		kind: "dynamic",
		uid: "u1",
		subscriptionId: SUB,
		target: T1,
		messages: [
			{ payload: text("卡片"), role: "main", result: OK },
			{ payload: text("词云"), role: "extra", result: FAIL },
			{ payload: text("总结"), role: "extra" },
		],
	});
}

/** 等后台那一趟跑完(行的状态不再动)。 */
async function settled(entry: HistoryEntry): Promise<HistoryEntry> {
	await vi.waitFor(() => expect(runner.isRunning(entry.id)).toBe(false));
	const row = await history.findRow(entry.id, entry.ts);
	if (!row) throw new Error("row gone");
	return row;
}

describe("start — 立刻回", () => {
	it("🔴 发送还卡着,start 已经回来了(HTTP 不等 190s×N)", async () => {
		const entry = await seedPartial();
		gate = () => {};
		const res = await runner.start(entry.id, entry.ts, "missing");
		expect(started(res)).toBe(2);
		// 发送还没走完,可这一行已经在补了。
		expect(sent).toHaveLength(0);
		expect(runner.isRunning(entry.id)).toBe(true);
	});
});

describe("补哪几条", () => {
	it("missing:只补没到的两条,已经送达的那条一次都不重发", async () => {
		const entry = await seedPartial();
		expect(started(await runner.start(entry.id, entry.ts, "missing"))).toBe(2);
		await settled(entry);
		expect(sent.map((s) => s.text)).toEqual(["词云", "总结"]);
	});

	it("all:三条从头再发一遍,包括已经送达的那条", async () => {
		const entry = await seedPartial();
		expect(started(await runner.start(entry.id, entry.ts, "all"))).toBe(3);
		await settled(entry);
		expect(sent.map((s) => s.text)).toEqual(["卡片", "词云", "总结"]);
	});

	it("发的是原件里那份原样 payload,走的是这一行的那把特性键", async () => {
		const entry = await seedPartial();
		await runner.start(entry.id, entry.ts, "missing");
		await settled(entry);
		expect(sent.every((s) => s.targetId === T1)).toBe(true);
		expect(new Set(sent.map((s) => s.feature))).toEqual(new Set(["dynamic"]));
	});
});

describe("结果写回历史", () => {
	it("每补一条就往行里追一条带 retryOf 的,补齐了整行翻绿", async () => {
		const entry = await seedPartial();
		await runner.start(entry.id, entry.ts, "missing");
		const row = await settled(entry);
		expect(row.messages).toHaveLength(5);
		expect(row.messages.slice(3).map((m) => m.retryOf)).toEqual([1, 2]);
		expect(row.status).toBe("delivered");
	});

	it("补齐之后原件就删了(决策 5)", async () => {
		const entry = await seedPartial();
		await runner.start(entry.id, entry.ts, "missing");
		await settled(entry);
		expect(await repush.load(entry.id, entry.ts, 3)).toBeNull();
	});

	it("没补齐就不删原件 —— 按钮还得能再按", async () => {
		const entry = await seedPartial();
		failOn = (n) => n === 1;
		await runner.start(entry.id, entry.ts, "missing");
		const row = await settled(entry);
		expect(row.status).toBe("partial");
		expect(await repush.load(entry.id, entry.ts, 3)).not.toBeNull();
	});

	// 失败后大概率继续失败,而且每条还要再等一轮 190s 的退避;剩下那几条本来就还在
	// 行里躺着,下次按按钮照样补得到(决策 18)。
	it("补到一半又失败 → 中止,后面那条一次都没发", async () => {
		const entry = await seedPartial();
		failOn = (n) => n === 1;
		await runner.start(entry.id, entry.ts, "missing");
		await settled(entry);
		expect(sent.map((s) => s.text)).toEqual(["词云"]);
	});
});

/**
 * **按钮该不该灰**(决策 9)。面板为每一行失败的问一次 —— 所以这一口走的是
 * `repush.has()`(只看文件在不在),不是 `load()`(那会把图全读进内存)。
 *
 * 「原件已经不在的行,按钮灰掉**并说明原因**」,不是把按钮藏掉:藏掉的话主人要么以为
 * 这行没失败过,要么以为功能坏了。
 */
describe("canRepush — 给面板的预判", () => {
	it("能补 → null", async () => {
		const entry = await seedPartial();
		expect(await runner.canRepush(entry)).toBeNull();
	});

	it("原件没了 → 说得出为什么", async () => {
		const entry = await seedPartial();
		await repush.drop(entry.id, entry.ts);
		const reason = await runner.canRepush(entry);
		expect(reason).toBeTruthy();
		expect(reason).toContain("原料");
	});

	it("闸不让 → 说的是闸那一档的理由", async () => {
		const entry = await seedPartial();
		routed = [];
		expect(await runner.canRepush(entry)).toContain("路由");
	});

	it("正在补 → 也算不能再按", async () => {
		const entry = await seedPartial();
		gate = () => {};
		await runner.start(entry.id, entry.ts, "missing");
		expect(await runner.canRepush(entry)).toBeTruthy();
	});
});

describe("闸", () => {
	it("这一行正在补 → 第二次直接拒,一条都不多发", async () => {
		const entry = await seedPartial();
		gate = () => {};
		await runner.start(entry.id, entry.ts, "missing");
		const second = await runner.start(entry.id, entry.ts, "missing");
		expect(denied(second)).toBeTruthy();
		expect(sent).toHaveLength(0);
	});

	it("routing 里没这个目标了 → 拒,一条都不发", async () => {
		const entry = await seedPartial();
		routed = [];
		const res = await runner.start(entry.id, entry.ts, "missing");
		expect(res.ok).toBe(false);
		expect(sent).toHaveLength(0);
	});

	it("目标停用了 → 拒", async () => {
		const entry = await seedPartial();
		enabled = false;
		expect((await runner.start(entry.id, entry.ts, "missing")).ok).toBe(false);
	});

	it("行压根不存在 → notFound(端点据此回 404,不是 409)", async () => {
		const res = await runner.start(randomUUID(), "2026-09-20T00:00:00.000Z", "missing");
		expect(res.ok).toBe(false);
		expect(res.ok === false && res.notFound).toBe(true);
	});

	/**
	 * 原件不在了(保留期到了、或者被 devtools 的截流清理连图一起收走了)。按钮该灰掉
	 * 并说明原因(决策 9),而不是让主人点下去再发现什么都没发生。
	 */
	it("原件已经不在 → 拒,并说得出为什么", async () => {
		const entry = await seedPartial();
		await repush.drop(entry.id, entry.ts);
		const res = await runner.start(entry.id, entry.ts, "missing");
		expect(denied(res)).toBeTruthy();
		expect(sent).toHaveLength(0);
	});

	it("一条都不用补(全送到了)→ 拒", async () => {
		const entry = await history.record({
			pushId: randomUUID(),
			kind: "dynamic",
			uid: "u1",
			subscriptionId: SUB,
			target: T1,
			messages: [{ payload: text("卡片"), role: "main", result: OK }],
		});
		expect((await runner.start(entry.id, entry.ts, "missing")).ok).toBe(false);
	});
});

/**
 * 行上记的订阅**现在**是哪一条(ADR-0019 决策 50 / 73):先按 `subscriptionId`,找不到再按身份
 * (B 站行按 uid、拓展行按拓展 id + 外部 id,绝不跨支)—— 删了又重加的 UP,旧历史照样能重推;
 * 同 uid 两条都在时认行自己那条。
 *
 * 这里接的是真的路由快照表(`resolveTargetScope`),不是桩:要钉的正是 runner 拿行去问表、
 * 再拿表给的那条订阅去发这一整串。
 */
describe("重推认的是哪一条订阅", () => {
	function runnerOver(subscriptions: Subscription[]): RepushRunner {
		const table = resolveTargetScope({ subscriptions, targets: [], connections: [] });
		return createRepushRunner({
			history,
			repush,
			send: recordingSend,
			routedTargets: (id, feature) => table.routedTargets(id, feature),
			currentSubscriptionOf: (row) => table.currentSubscriptionOf(row),
			targetEnabled: () => true,
			logger: logger(),
		});
	}

	it("行的订阅删了、同 uid 又加了一条 → 闸放行,发送认的是新那条", async () => {
		const entry = await seedPartial();
		const readded = makeEmptySubscription({ id: randomUUID(), uid: "u1" });
		readded.routing.dynamic = [T1];
		const r = runnerOver([readded]);
		expect(await r.canRepush(entry)).toBeNull();
		expect(started(await r.start(entry.id, entry.ts, "missing"))).toBe(2);
		await vi.waitFor(() => expect(r.isRunning(entry.id)).toBe(false));
		expect(sent.map((s) => s.subscriptionId)).toEqual([readded.id, readded.id]);
	});

	it("同 uid 两条都在 → 用行自己那条的路由,不是先出现的那条", async () => {
		const entry = await seedPartial();
		// 先出现的那条不路由到 T1;行自己那条(SUB)路由着。
		const first = makeEmptySubscription({ id: randomUUID(), uid: "u1" });
		const own = makeEmptySubscription({ id: SUB, uid: "u1" });
		own.routing.dynamic = [T1];
		const r = runnerOver([first, own]);
		expect(await r.canRepush(entry)).toBeNull();
		expect(started(await r.start(entry.id, entry.ts, "missing"))).toBe(2);
		await vi.waitFor(() => expect(r.isRunning(entry.id)).toBe(false));
		expect(sent.map((s) => s.subscriptionId)).toEqual([SUB, SUB]);
	});

	it("id 与 uid 都对不上 → 按「路由是空」拒,理由还是「路由里把它去掉了」那句", async () => {
		const entry = await seedPartial();
		const other = makeEmptySubscription({ id: randomUUID(), uid: "u2" });
		other.routing.dynamic = [T1];
		const r = runnerOver([other]);
		expect(await r.canRepush(entry)).toContain("路由");
		expect(sent).toHaveLength(0);
	});

	/** 拓展行(ADR-0019 决策 73):订阅已经删掉的一行,身份是 douyin 名下的外部 id "u1"。 */
	async function seedExtensionPartial(): Promise<HistoryEntry> {
		return history.record({
			pushId: randomUUID(),
			kind: "dynamic",
			extensionId: "douyin",
			externalId: "u1",
			subscriptionId: SUB,
			target: T1,
			messages: [
				{ payload: text("作品"), role: "main", result: OK },
				{ payload: text("点评"), role: "extra", result: FAIL },
			],
		});
	}

	it("拓展行的订阅删了、同一个拓展同一个外部 id 又加了一条 → 闸放行,发送认的是新那条", async () => {
		const entry = await seedExtensionPartial();
		const readded = makeExtensionSubscription({
			id: randomUUID(),
			extensionId: "douyin",
			externalId: "u1",
		});
		readded.routing.dynamic = [T1];
		const r = runnerOver([readded]);
		expect(await r.canRepush(entry)).toBeNull();
		expect(started(await r.start(entry.id, entry.ts, "missing"))).toBe(1);
		await vi.waitFor(() => expect(r.isRunning(entry.id)).toBe(false));
		expect(sent.map((s) => s.subscriptionId)).toEqual([readded.id]);
	});

	it("拓展行的外部 id 恰好等于某个 B 站 uid → 不认成那条 B 站订阅,按「路由是空」拒", async () => {
		const entry = await seedExtensionPartial();
		const bili = makeEmptySubscription({ id: randomUUID(), uid: "u1" });
		bili.routing.dynamic = [T1];
		const r = runnerOver([bili]);
		expect(await r.canRepush(entry)).toContain("路由");
		expect(sent).toHaveLength(0);
	});
});
