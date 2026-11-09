/**
 * **重推的执行器**(ADR-0017 决策 5、8、10-13、18)。
 *
 * 🔴 **立刻回,后台跑。** 发送层的 `sendToTarget` 光退避就最长约 190s(3→6→12→24→48→96),
 * 一行补 N 条就是 190s × N —— HTTP 请求绝不能同步等着。按下按钮立刻回一句「收到」,
 * 消息一条条补,每补一条就往历史行里追加、`history-updated` 推到面板,那条路早就通着。
 *
 * 发送口固定是 `PushRouter.sendToTarget`,因为它**恰好**就是定案里那三条闸的交汇点:
 * 自带退避重试(决策 12:目标不可达不挡,那正是重推要解决的)、每次重试前复检 routing
 * (决策 10:用户已经取消了就停),而静音 / 免扰 / 特性总开关三道都在它**上游**的
 * `PushRouter.push` 里 —— 走这条路它们天然不参与(决策 11)。
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
	FEATURE_KEYS,
	type FeatureKey,
	fail,
	type HistoryEntry,
	makeEmptySubscription,
	type NotificationPayload,
	ok,
	type Subscription,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import {
	deferred,
	makeTrackingContext,
	stillPending,
	type TrackingContext,
} from "../../__tests__/support/track-context.js";
import { i18n } from "../../i18n/index.js";
import { createHistoryRoute } from "../../routes/history.js";
import type { RouteDeps } from "../../routes/types.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { resolveTargetScope } from "../../runtime/target-scope.js";
import { createRepushRunner, type RepushRunner } from "../repush-runner.js";
import { createRepushStore, type RepushStore } from "../repush-store.js";
import { createHistoryStore, type HistoryStore } from "../store.js";

let dataDir: string;
let history: HistoryStore;
let repush: RepushStore;
let runner: RepushRunner;
let ctx: TrackingContext;
/** 每次发送记一笔;`fail` 指定第几次(1 起)失败。 */
let sent: Array<{ targetId: string; text: string; subscriptionId: string; feature: FeatureKey }>;
let failOn: (nth: number) => boolean;
/** 给了就让发送口在第 n 次调用时抛这句话(发送口本不该抛,这是在演 bug)。 */
let throwOn: ((nth: number) => string | Error | undefined) | null;
let log: ReturnType<typeof logger>;
/** 卡住发送 —— 用来看「立刻回」。 */
let gate: (() => void) | null;

const SUB = randomUUID();
const T1 = randomUUID();
const OK = ok({ latencyMs: 5 });
const FAIL = fail("unavailable", "boom");

let routed: string[];
let enabled: boolean;

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-runner-"));
	log = logger();
	const images = makeHistoryImages(dataDir);
	repush = createRepushStore({
		dataRoot: dataDir,
		logger: log,
		images: images.repushImages,
		imageStore: images.imageStore,
	});
	history = createHistoryStore({
		dataRoot: dataDir,
		bus: createNodeMessageBus(),
		logger: log,
		images: images.historyImages,
		repush,
	});
	sent = [];
	failOn = () => false;
	throwOn = null;
	gate = null;
	routed = [T1];
	enabled = true;
	ctx = makeTrackingContext();
	runner = createRepushRunner({
		history,
		repush,
		send: recordingSend,
		routedTargets: () => routed,
		currentSubscriptionOf: (row) => row.subscriptionId,
		targetEnabled: () => enabled,
		logger: log,
		serviceCtx: ctx,
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	i18n.set({ locale: "zh-CN", voice: "maid" });
});

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
	const boom = throwOn?.(sent.length);
	if (boom !== undefined) throw boom instanceof Error ? boom : new Error(boom);
	return (failOn(sent.length) ? FAIL : OK) as DeliveryResult;
}

const text = (t: string): NotificationPayload => ({ kind: "text", text: t });

/** 放行了才有 `count`;顺带把拒绝的理由印进失败信息(比 `undefined` 好查)。 */
function started(res: Awaited<ReturnType<RepushRunner["start"]>>): number {
	if (!res.ok) throw new Error(`本该放行,却拒了:${res.message}`);
	return res.count;
}
/** 拒了才有 `code` 与 `message`;回那句给人看的话。 */
function denied(res: Awaited<ReturnType<RepushRunner["start"]>>): string {
	if (res.ok) throw new Error("本该拒,却放行了");
	return res.message;
}

/** 落一行:第一条成功、第二条失败、第三条因此从没发出去。 */
async function seedPartial(): Promise<HistoryEntry> {
	return history.record({
		pushId: randomUUID(),
		feature: "post",
		identity: { sourceKey: "bilibili", externalId: "u1" },
		subscriptionId: SUB,
		targetId: T1,
		messages: [
			{ payload: text("卡片"), role: "main", result: OK },
			{ payload: text("词云"), role: "extra", result: FAIL },
			{ payload: text("总结"), role: "extra" },
		],
	});
}

/**
 * 列表接口(`GET /api/history`)给这一行的 `repush` 那一格 —— 接的是真的历史仓与这个 runner,
 * 钉的是「闸、列表、原件去留」三处对同一行给出同一个答案。没给按钮回 undefined。
 */
async function listedRepush(using: RepushRunner, entry: HistoryEntry): Promise<unknown> {
	const app = createHistoryRoute({
		runtime: { dataRoot: dataDir, historyStore: history, repushRunner: using },
	} as unknown as RouteDeps);
	const body = (await (await app.request("/")).json()) as {
		entries: Array<{ id: string; repush?: unknown }>;
	};
	return body.entries.find((e) => e.id === entry.id)?.repush;
}

/** 等后台那一趟跑完(行的状态不再动)。 */
async function settled(entry: HistoryEntry): Promise<HistoryEntry> {
	await vi.waitFor(() => expect(runner.isRunning(entry.id)).toBe(false));
	const row = await history.findRow(entry.id, entry.createdAt);
	if (!row) throw new Error("row gone");
	return row;
}

describe("start — 立刻回", () => {
	it("🔴 发送还卡着,start 已经回来了(HTTP 不等 190s×N)", async () => {
		const entry = await seedPartial();
		gate = () => {};
		const res = await runner.start(entry.id, entry.createdAt, "missing");
		expect(started(res)).toBe(2);
		// 发送还没走完,可这一行已经在补了。
		expect(sent).toHaveLength(0);
		expect(runner.isRunning(entry.id)).toBe(true);
	});
});

describe("补哪几条", () => {
	it("missing:只补没到的两条,已经送达的那条一次都不重发", async () => {
		const entry = await seedPartial();
		expect(started(await runner.start(entry.id, entry.createdAt, "missing"))).toBe(2);
		await settled(entry);
		expect(sent.map((s) => s.text)).toEqual(["词云", "总结"]);
	});

	it("all:三条从头再发一遍,包括已经送达的那条", async () => {
		const entry = await seedPartial();
		expect(started(await runner.start(entry.id, entry.createdAt, "all"))).toBe(3);
		await settled(entry);
		expect(sent.map((s) => s.text)).toEqual(["卡片", "词云", "总结"]);
	});

	it("发的是原件里那份原样 payload,走的是这一行的那把特性键", async () => {
		const entry = await seedPartial();
		await runner.start(entry.id, entry.createdAt, "missing");
		await settled(entry);
		expect(sent.every((s) => s.targetId === T1)).toBe(true);
		expect(new Set(sent.map((s) => s.feature))).toEqual(new Set(["post"]));
	});
});

describe("结果写回历史", () => {
	it("每补一条就往行里追一条带 repushOf 的,补齐了整行翻绿", async () => {
		const entry = await seedPartial();
		await runner.start(entry.id, entry.createdAt, "missing");
		const row = await settled(entry);
		expect(row.messages).toHaveLength(5);
		expect(row.messages.slice(3).map((m) => m.repushOf)).toEqual([1, 2]);
		expect(row.status).toBe("delivered");
	});

	it("补齐之后原件就删了(决策 5)", async () => {
		const entry = await seedPartial();
		await runner.start(entry.id, entry.createdAt, "missing");
		await settled(entry);
		expect(await repush.load(entry.id, entry.createdAt, 3)).toBeNull();
	});

	it("没补齐就不删原件 —— 按钮还得能再按", async () => {
		const entry = await seedPartial();
		failOn = (n) => n === 1;
		await runner.start(entry.id, entry.createdAt, "missing");
		const row = await settled(entry);
		expect(row.status).toBe("partial");
		expect(await repush.load(entry.id, entry.createdAt, 3)).not.toBeNull();
	});

	// 失败后大概率继续失败,而且每条还要再等一轮 190s 的退避;剩下那几条本来就还在
	// 行里躺着,下次按按钮照样补得到(决策 18)。
	it("补到一半又失败 → 中止,后面那条一次都没发", async () => {
		const entry = await seedPartial();
		failOn = (n) => n === 1;
		await runner.start(entry.id, entry.createdAt, "missing");
		await settled(entry);
		expect(sent.map((s) => s.text)).toEqual(["词云"]);
	});

	// 发送口不许抛;真抛了算 bug(ADR-0026 决策 1):按结果不明记进行里(`indeterminate` + 原话),并留 error 日志,
	// 这一趟到此为止 —— 不能静默停住、行上什么都不留。
	it("发送口抛错 → 记录结果不明与原错误，后面那条不再发", async () => {
		const entry = await seedPartial();
		const error = new Error("sender exploded", { cause: new Error("network") });
		throwOn = (n) => (n === 1 ? error : undefined);
		i18n.set({ locale: "en", voice: "maid" });
		await runner.start(entry.id, entry.createdAt, "missing");
		const row = await settled(entry);
		expect(sent.map((s) => s.text)).toEqual(["词云"]);
		expect(row.messages).toHaveLength(4);
		expect(row.messages[3]).toMatchObject({
			repushOf: 1,
			result: { ok: false, code: "indeterminate", message: "sender exploded" },
		});
		expect(log.error).toHaveBeenCalledWith(
			"Repush sender threw; delivery is indeterminate and this repush task will stop",
			{
				rowId: entry.id,
				messageIndex: 1,
				error,
			},
		);
		expect(log.error.mock.calls[0]?.[1]?.error).toBe(error);
		expect(JSON.stringify(log.error.mock.calls)).not.toContain("词云");
	});
});

/**
 * **按钮该不该灰**(决策 9)。面板为每一行失败的问一次 —— 所以这一口走的是
 * `repush.has()`(只看文件在不在),不是 `load()`(那会把图全读进内存)。
 *
 * 「原件已经不在的行,按钮灰掉**并说明原因**」,不是把按钮藏掉:藏掉的话主人要么以为
 * 这行没失败过,要么以为功能坏了。
 */
describe("结果不明时拒绝再次重推", () => {
	it.each(["throw", "result"] as const)(
		"发送口以 %s 报告结果不明，重启后列表和两种补发入口均拒绝，不再发送",
		async (kind) => {
			const entry = await seedPartial();
			const active = createRepushRunner({
				history,
				repush,
				serviceCtx: ctx,
				logger: log,
				routedTargets: () => routed,
				currentSubscriptionOf: (row) => row.subscriptionId,
				targetEnabled: () => enabled,
				send: async (...args) => {
					await recordingSend(...args);
					if (kind === "throw") throw new Error("delivery receipt lost");
					return fail("indeterminate", "delivery receipt lost");
				},
			});
			expect(started(await active.start(entry.id, entry.createdAt, "missing"))).toBe(2);
			await ctx.settled();
			expect(sent.map((s) => s.text)).toEqual(["词云"]);

			// 不靠原 runner 的内存判断：重新读取落盘的原行和补丁。
			const images = makeHistoryImages(dataDir);
			const reopened = createHistoryStore({
				dataRoot: dataDir,
				bus: createNodeMessageBus(),
				logger: log,
				images: images.historyImages,
				repush,
			});
			const row = await reopened.findRow(entry.id, entry.createdAt);
			if (!row) throw new Error("row gone");
			const restartedCtx = makeTrackingContext();
			const restarted = createRepushRunner({
				history: reopened,
				repush,
				serviceCtx: restartedCtx,
				logger: log,
				send: recordingSend,
				routedTargets: () => routed,
				currentSubscriptionOf: (current) => current.subscriptionId,
				targetEnabled: () => enabled,
			});
			const denial = {
				ok: false,
				code: "conflict",
				message: "这行包含发送结果不明的消息，可能已经送达；为避免重复发送，不能再次重推。",
			};
			expect(await restarted.canRepush(row)).toEqual(denial);
			expect(await listedRepush(restarted, entry)).toEqual({
				can: false,
				code: denial.code,
				message: denial.message,
			});
			const app = createHistoryRoute({
				runtime: { dataRoot: dataDir, historyStore: reopened, repushRunner: restarted },
			} as unknown as RouteDeps);
			for (const mode of ["missing", "all"]) {
				const response = await app.request(`/${entry.id}/repush`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ createdAt: entry.createdAt, mode }),
				});
				expect(response.status).toBe(409);
				expect(await response.json()).toEqual({ code: denial.code, message: denial.message });
			}
			await restartedCtx.settled();
			expect(sent.map((s) => s.text)).toEqual(["词云"]);
			expect((await reopened.findRow(entry.id, entry.createdAt))?.messages).toHaveLength(4);
			expect(await repush.has(entry.id, entry.createdAt)).toBe(true);
		},
	);
});

describe("canRepush — 给面板的预判", () => {
	it.each([
		[
			"en",
			"The originals for this row are no longer available. Only pushes within the retention period with complete originals can be repushed.",
			"This push history row was not found.",
		],
		[
			"ja",
			"この行の元データはすでにありません。保持期間内で元データが揃っているプッシュのみ再送できます。",
			"このプッシュ履歴の行が見つかりません。",
		],
		[
			"zh-TW",
			"此列的原件已不存在，只有保留期間內且原件完整的推送可以重推。",
			"找不到此列推送紀錄。",
		],
	] as const)(
		"%s distinguishes missing originals from a missing row and sends neither",
		async (locale, originals, missing) => {
			const entry = await seedPartial();
			await repush.drop(entry.id, entry.createdAt);
			i18n.set({ locale, voice: "plain" });
			expect(await runner.canRepush(entry)).toEqual({
				ok: false,
				code: "conflict",
				message: originals,
			});
			expect(await runner.start(entry.id, entry.createdAt, "missing")).toEqual({
				ok: false,
				code: "conflict",
				message: originals,
			});
			expect(await runner.start(randomUUID(), entry.createdAt, "all")).toEqual({
				ok: false,
				code: "not_found",
				message: missing,
			});
			expect(sent).toEqual([]);
		},
	);
	it("能补 → null", async () => {
		const entry = await seedPartial();
		expect(await runner.canRepush(entry)).toBeNull();
	});

	it("原件没了 → 说得出为什么", async () => {
		const entry = await seedPartial();
		await repush.drop(entry.id, entry.createdAt);
		const denial = await runner.canRepush(entry);
		expect(denial).toMatchObject({ ok: false, code: "conflict" });
		expect(denial?.message).toContain("原料");
	});

	it("闸不让 → 说的是闸那一档的理由", async () => {
		const entry = await seedPartial();
		routed = [];
		expect(await runner.canRepush(entry)).toMatchObject({
			ok: false,
			code: "conflict",
			message: expect.stringContaining("路由"),
		});
	});

	it("正在补 → 也算不能再按", async () => {
		const entry = await seedPartial();
		gate = () => {};
		await runner.start(entry.id, entry.createdAt, "missing");
		expect(await runner.canRepush(entry)).toMatchObject({ ok: false, code: "conflict" });
	});
});

describe("闸", () => {
	it("这一行正在补 → 第二次直接拒,一条都不多发", async () => {
		const entry = await seedPartial();
		gate = () => {};
		await runner.start(entry.id, entry.createdAt, "missing");
		const second = await runner.start(entry.id, entry.createdAt, "missing");
		expect(denied(second)).toBeTruthy();
		expect(sent).toHaveLength(0);
	});

	it("routing 里没这个目标了 → 拒,一条都不发", async () => {
		const entry = await seedPartial();
		routed = [];
		const res = await runner.start(entry.id, entry.createdAt, "missing");
		expect(res.ok).toBe(false);
		expect(sent).toHaveLength(0);
	});

	it("目标停用了 → 拒", async () => {
		const entry = await seedPartial();
		enabled = false;
		expect((await runner.start(entry.id, entry.createdAt, "missing")).ok).toBe(false);
	});

	it("行压根不存在 → not_found(端点据此回 404,不是 409)", async () => {
		const res = await runner.start(randomUUID(), "2026-09-20T00:00:00.000Z", "missing");
		expect(res).toMatchObject({ ok: false, code: "not_found" });
	});

	/**
	 * 原件不在了(保留期到了、或者被 devtools 的截流清理连图一起收走了)。按钮该灰掉
	 * 并说明原因(决策 9),而不是让主人点下去再发现什么都没发生。
	 */
	it("原件已经不在 → 拒,并说得出为什么", async () => {
		const entry = await seedPartial();
		await repush.drop(entry.id, entry.createdAt);
		const res = await runner.start(entry.id, entry.createdAt, "missing");
		expect(res).toMatchObject({ ok: false, code: "conflict" });
		expect(denied(res)).toContain("原料");
		expect(sent).toHaveLength(0);
	});

	it("一条都不用补(全送到了)→ 拒", async () => {
		const entry = await history.record({
			pushId: randomUUID(),
			feature: "post",
			identity: { sourceKey: "bilibili", externalId: "u1" },
			subscriptionId: SUB,
			targetId: T1,
			messages: [{ payload: text("卡片"), role: "main", result: OK }],
		});
		expect((await runner.start(entry.id, entry.createdAt, "missing")).ok).toBe(false);
	});
});

/**
 * 行上记的订阅**现在**是哪一条(ADR-0019 决策 50 / 73):先按 `subscriptionId`,找不到再按身份
 * (`identity` 的来源键 + 外部 id 两格一起比,绝不跨来源)—— 删了又重加的 UP,旧历史照样能重推;
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
			serviceCtx: ctx,
		});
	}

	it("行的订阅删了、同 uid 又加了一条 → 闸放行,发送认的是新那条", async () => {
		const entry = await seedPartial();
		const readded = makeEmptySubscription({
			id: randomUUID(),
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		readded.routing.post = [T1];
		const r = runnerOver([readded]);
		expect(await r.canRepush(entry)).toBeNull();
		expect(started(await r.start(entry.id, entry.createdAt, "missing"))).toBe(2);
		await vi.waitFor(() => expect(r.isRunning(entry.id)).toBe(false));
		expect(sent.map((s) => s.subscriptionId)).toEqual([readded.id, readded.id]);
	});

	it("同 uid 两条都在 → 用行自己那条的路由,不是先出现的那条", async () => {
		const entry = await seedPartial();
		// 先出现的那条不路由到 T1;行自己那条(SUB)路由着。
		const first = makeEmptySubscription({
			id: randomUUID(),
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		const own = makeEmptySubscription({
			id: SUB,
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		own.routing.post = [T1];
		const r = runnerOver([first, own]);
		expect(await r.canRepush(entry)).toBeNull();
		expect(started(await r.start(entry.id, entry.createdAt, "missing"))).toBe(2);
		await vi.waitFor(() => expect(r.isRunning(entry.id)).toBe(false));
		expect(sent.map((s) => s.subscriptionId)).toEqual([SUB, SUB]);
	});

	it("id 与 uid 都对不上 → 按「路由是空」拒,理由还是「路由里把它去掉了」那句", async () => {
		const entry = await seedPartial();
		const other = makeEmptySubscription({
			id: randomUUID(),
			identity: { sourceKey: "bilibili", externalId: "u2" },
		});
		other.routing.post = [T1];
		const r = runnerOver([other]);
		expect((await r.canRepush(entry))?.message).toContain("路由");
		expect(sent).toHaveLength(0);
	});

	/** 拓展行(ADR-0019 决策 73):订阅已经删掉的一行,身份是 douyin 名下的外部 id "u1"。 */
	async function seedExtensionPartial(): Promise<HistoryEntry> {
		return history.record({
			pushId: randomUUID(),
			feature: "post",
			identity: { sourceKey: "douyin", externalId: "u1" },
			subscriptionId: SUB,
			targetId: T1,
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
		readded.routing.post = [T1];
		const r = runnerOver([readded]);
		expect(await r.canRepush(entry)).toBeNull();
		expect(started(await r.start(entry.id, entry.createdAt, "missing"))).toBe(1);
		await vi.waitFor(() => expect(r.isRunning(entry.id)).toBe(false));
		expect(sent.map((s) => s.subscriptionId)).toEqual([readded.id]);
	});

	it("拓展行的外部 id 恰好等于某个 B 站 uid → 不认成那条 B 站订阅,按「路由是空」拒", async () => {
		const entry = await seedExtensionPartial();
		const bili = makeEmptySubscription({
			id: randomUUID(),
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		bili.routing.post = [T1];
		const r = runnerOver([bili]);
		expect((await r.canRepush(entry))?.message).toContain("路由");
		expect(sent).toHaveLength(0);
	});
});

/**
 * 闸与发送都拿**行上的 `feature`** 去查路由(⑬f:历史行记的就是特性键,不再经一张「种类 → 特性键」的翻译表)。
 * 八把键各来一遍 —— 只用 `post` 的话,闸写死成 `post` 也全绿。
 */
describe("路由按行上的特性键查", () => {
	function runnerOver(subscription: Subscription): RepushRunner {
		const table = resolveTargetScope({
			subscriptions: [subscription],
			targets: [],
			connections: [],
		});
		return createRepushRunner({
			history,
			repush,
			send: recordingSend,
			routedTargets: (id, feature) => table.routedTargets(id, feature),
			currentSubscriptionOf: (row) => table.currentSubscriptionOf(row),
			targetEnabled: () => true,
			logger: logger(),
			serviceCtx: ctx,
		});
	}

	function seedRowOf(feature: FeatureKey): Promise<HistoryEntry> {
		return history.record({
			pushId: randomUUID(),
			feature,
			identity: { sourceKey: "bilibili", externalId: "u1" },
			subscriptionId: SUB,
			targetId: T1,
			messages: [
				{ payload: text("卡片"), role: "main", result: OK },
				{ payload: text("词云"), role: "extra", result: FAIL },
			],
		});
	}

	it.each(FEATURE_KEYS)("%s:目标只路由在这把键下 → 闸放行,发送带的也是这把键", async (feature) => {
		const entry = await seedRowOf(feature);
		const sub = makeEmptySubscription({
			id: SUB,
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing[feature] = [T1];
		const r = runnerOver(sub);
		expect(await r.canRepush(entry)).toBeNull();
		expect(started(await r.start(entry.id, entry.createdAt, "missing"))).toBe(1);
		await vi.waitFor(() => expect(r.isRunning(entry.id)).toBe(false));
		expect(sent.map((s) => s.feature)).toEqual([feature]);
	});

	it.each(FEATURE_KEYS)(
		"%s:目标只路由在**别的**键下 → 按「路由里把它去掉了」拒",
		async (feature) => {
			const entry = await seedRowOf(feature);
			const sub = makeEmptySubscription({
				id: SUB,
				identity: { sourceKey: "bilibili", externalId: "u1" },
			});
			for (const other of FEATURE_KEYS) if (other !== feature) sub.routing[other] = [T1];
			const r = runnerOver(sub);
			expect((await r.canRepush(entry))?.message).toContain("路由");
			expect(sent).toHaveLength(0);
		},
	);
});

/**
 * **关停**(切片 ③)。后台补发是发出去不管的活:关停在 flush 段让各写道关门,补发写回历史行的那一笔
 * 要是还没交进写道,关门后就被拒 —— 那条消息发出去了、行里却不记,按钮会让它再发一遍。
 * 所以补发登记进 `track`(补完、写回完才落定),`signal` 一中止就停在手上这一条。
 */
describe("关停", () => {
	/** 把 `appendToRow` 停在半路:放行了才真的写。 */
	function holdAppend() {
		const release = deferred();
		const original = history.appendToRow.bind(history);
		const spy = vi.spyOn(history, "appendToRow").mockImplementation(async (...args) => {
			await release.promise;
			return original(...args);
		});
		return { release, spy };
	}

	it("后台补发登记进 track:写回历史行落定它才落定", async () => {
		const entry = await seedPartial();
		const append = holdAppend();
		expect(started(await runner.start(entry.id, entry.createdAt, "missing"))).toBe(2);

		expect(ctx.tracked).toHaveLength(1);
		await vi.waitFor(() => expect(append.spy).toHaveBeenCalledTimes(1)); // 第一条发出去了,写回停在半路
		expect(await stillPending(ctx.settled())).toBe(true);
		expect((await history.findRow(entry.id, entry.createdAt))?.messages).toHaveLength(3);

		append.release.resolve();
		await ctx.settled();
		const row = await history.findRow(entry.id, entry.createdAt);
		expect(row?.messages).toHaveLength(5); // 两条都补上了,都写回了
		expect(runner.isRunning(entry.id)).toBe(false);
	});

	it("signal 中止:很快落定,已经发出去的那条写回行里,后面的一条都不再发、落定之后不再写", async () => {
		const entry = await seedPartial();
		const parked = () => {};
		gate = parked; // 第一条卡在发送口:发送口一进来就把 gate 换成放行函数
		await runner.start(entry.id, entry.createdAt, "missing");
		await vi.waitFor(() => expect(gate).not.toBe(parked));
		const appendSpy = vi.spyOn(history, "appendToRow");

		ctx.abort();
		const release = gate as () => void;
		release(); // 第一条这才发出去,回 ok
		await ctx.settled();

		expect(sent.map((s) => s.text)).toEqual(["词云"]); // 第二条(总结)没有再发
		expect(appendSpy).toHaveBeenCalledTimes(1); // 发出去的那条照样写回
		expect(runner.isRunning(entry.id)).toBe(false);
		await new Promise((r) => setTimeout(r, 30));
		expect(appendSpy).toHaveBeenCalledTimes(1); // 落定之后没有再写
		const row = await history.findRow(entry.id, entry.createdAt);
		expect(row?.messages).toHaveLength(4);
	});

	it("关停期间发送抛错也必须写回结果不明，后续预检拒绝", async () => {
		const entry = await seedPartial();
		const parked = () => {};
		gate = parked;
		throwOn = () => new Error("receipt lost during shutdown");
		await runner.start(entry.id, entry.createdAt, "missing");
		await vi.waitFor(() => expect(gate).not.toBe(parked));
		ctx.abort();
		(gate as () => void)();
		await ctx.settled();
		const row = await history.findRow(entry.id, entry.createdAt);
		if (!row) throw new Error("row gone");
		expect(row.messages).toHaveLength(4);
		expect(row.messages[3]?.result).toMatchObject({
			ok: false,
			code: "indeterminate",
			message: "receipt lost during shutdown",
		});
		expect(await runner.canRepush(row)).toMatchObject({
			ok: false,
			code: "conflict",
			message: expect.stringContaining("结果不明"),
		});
		expect(sent.map((s) => s.text)).toEqual(["词云"]);
	});

	it("关停把发送层叫醒回来的失败不写进行里(那不是这个目标真的不通)", async () => {
		const entry = await seedPartial();
		const parked = () => {};
		gate = parked;
		failOn = () => true; // 卡住的那一条醒来时回的是失败
		await runner.start(entry.id, entry.createdAt, "missing");
		await vi.waitFor(() => expect(gate).not.toBe(parked));
		const appendSpy = vi.spyOn(history, "appendToRow");

		ctx.abort();
		(gate as () => void)();
		await ctx.settled();

		expect(appendSpy).not.toHaveBeenCalled();
		expect((await history.findRow(entry.id, entry.createdAt))?.messages).toHaveLength(3);
		// 原件还在 —— 按钮下次照样能补。
		expect(await repush.load(entry.id, entry.createdAt, 3)).not.toBeNull();
	});

	it("补发出了错(写道已关门):登记进去的这件事不拒,记一条 warn", async () => {
		const log = logger();
		const localCtx = makeTrackingContext();
		const local = createRepushRunner({
			history,
			repush,
			send: recordingSend,
			routedTargets: () => routed,
			currentSubscriptionOf: (row) => row.subscriptionId,
			targetEnabled: () => enabled,
			logger: log,
			serviceCtx: localCtx,
		});
		const entry = await seedPartial();
		vi.spyOn(history, "appendToRow").mockRejectedValue(new Error("queue closed"));

		await local.start(entry.id, entry.createdAt, "missing");
		await localCtx.settled();

		await expect(localCtx.tracked[0]).resolves.toBeUndefined();
		expect(log.warn).toHaveBeenCalledWith("重推任务异常终止", {
			rowId: entry.id,
			error: expect.objectContaining({ message: "queue closed" }),
		});
		expect(local.isRunning(entry.id)).toBe(false);
	});
});

/**
 * 被静音 / 免扰挡下的行(ADR-0017 决策 6、11;ADR-0021 决策 34 的 🔗):整行没发过,一颗「补发」把它
 * 全补上。补发是主人此刻按下的显式动作 —— 发送口是 `PushRouter.sendToTarget`,不经静音 / 免扰 / 总开关
 * (这个 runner 的入参里压根没有这三样;推送层那半由 `mute-gate.test.ts` 钉)。被挡时没记 @全体,
 * 所以补发也不会 @。
 */
describe("补发被静音 / 免扰挡下的行", () => {
	async function seedSilenced(): Promise<HistoryEntry> {
		return history.record({
			pushId: randomUUID(),
			feature: "liveEnd",
			identity: { sourceKey: "bilibili", externalId: "u1" },
			subscriptionId: SUB,
			targetId: T1,
			messages: [
				{ payload: text("下播卡"), role: "main", isSilenced: true },
				{ payload: text("词云"), role: "extra", isSilenced: true },
				{ payload: text("总结"), role: "extra", isSilenced: true },
			],
		});
	}

	it("过预检:能补", async () => {
		const entry = await seedSilenced();
		expect(entry.status).toBe("silenced");
		expect(await runner.canRepush(entry)).toBeNull();
	});

	it.each(["missing", "all"] as const)(
		"%s:行里每一条都补发一次(只发原件里那几条,没有 @全体),补齐后整行 delivered、原件删掉",
		async (mode) => {
			const entry = await seedSilenced();
			expect(started(await runner.start(entry.id, entry.createdAt, mode))).toBe(3);
			const row = await settled(entry);
			expect(sent.map((s) => s.text)).toEqual(["下播卡", "词云", "总结"]);
			expect(sent.every((s) => s.feature === "liveEnd" && s.targetId === T1)).toBe(true);
			expect(row.status).toBe("delivered");
			expect(row.messages.slice(3).map((m) => [m.repushOf, m.result?.ok, m.isSilenced])).toEqual([
				[0, true, undefined],
				[1, true, undefined],
				[2, true, undefined],
			]);
			expect(await repush.load(entry.id, entry.createdAt, 3)).toBeNull();
		},
	);

	it("本体补失败 → 中止,整行变 failed,原件留着、还能再补", async () => {
		const entry = await seedSilenced();
		failOn = (n) => n === 1;
		await runner.start(entry.id, entry.createdAt, "missing");
		const row = await settled(entry);
		expect(sent).toHaveLength(1);
		expect(row.status).toBe("failed");
		expect(await runner.canRepush(row)).toBeNull();
	});

	it("附加项补失败 → partial,再按一次只补还没到的那两条", async () => {
		const entry = await seedSilenced();
		failOn = (n) => n === 2;
		await runner.start(entry.id, entry.createdAt, "missing");
		const row = await settled(entry);
		expect(row.status).toBe("partial");
		failOn = () => false;
		sent = [];
		expect(started(await runner.start(entry.id, entry.createdAt, "missing"))).toBe(2);
		expect((await settled(entry)).status).toBe("delivered");
		expect(sent.map((s) => s.text)).toEqual(["词云", "总结"]);
	});

	/**
	 * 🔴 **本体补完就被关停打断**(决策 6,10-08 改写)。这一瞬间行按状态已是 `delivered`(本体送到了,
	 * 被挡的附加项不参与状态),可词云与总结还没发。按钮与原件的去留要是跟着状态走,这一行就停在
	 * 「已送达、没有按钮、原件已删」,剩下两条再也补不出来 —— 判据是「行里还有没有没发的消息」。
	 */
	it("🔴 本体补完就被关停打断:原件还在、预检仍放行、列表仍给按钮;再补一次补齐了才删原件、不再给补", async () => {
		const entry = await seedSilenced();
		const parked = () => {};
		gate = parked; // 本体卡在发送口
		await runner.start(entry.id, entry.createdAt, "missing");
		await vi.waitFor(() => expect(gate).not.toBe(parked));
		ctx.abort(); // 关停
		(gate as () => void)(); // 本体这才发出去,回 ok;词云、总结不再发
		await ctx.settled();
		gate = null;

		const interrupted = await settled(entry);
		expect(sent.map((s) => s.text)).toEqual(["下播卡"]);
		expect(interrupted.status).toBe("delivered");
		expect(await repush.has(entry.id, entry.createdAt)).toBe(true);
		expect(await runner.canRepush(interrupted)).toBeNull();
		expect(await listedRepush(runner, entry)).toEqual({ can: true, total: 3, missing: 2 });

		// 重启之后:新的一趟,只补还没发的那两条。
		const restartedCtx = makeTrackingContext();
		const restarted = createRepushRunner({
			history,
			repush,
			send: recordingSend,
			routedTargets: () => routed,
			currentSubscriptionOf: (row) => row.subscriptionId,
			targetEnabled: () => enabled,
			logger: log,
			serviceCtx: restartedCtx,
		});
		sent = [];
		expect(started(await restarted.start(entry.id, entry.createdAt, "missing"))).toBe(2);
		await restartedCtx.settled();
		const row = await history.findRow(entry.id, entry.createdAt);
		if (!row) throw new Error("row gone");
		expect(sent.map((s) => s.text)).toEqual(["词云", "总结"]);
		expect(row.status).toBe("delivered");
		expect(await repush.has(entry.id, entry.createdAt)).toBe(false);
		expect((await restarted.canRepush(row))?.message).toContain("全都送到了");
		expect(denied(await restarted.start(entry.id, entry.createdAt, "all"))).toContain("全都送到了");
		expect(await listedRepush(restarted, entry)).toBeUndefined();
	});

	// 「整行重发」的本意就是整行:已经补到的本体也再发一遍。
	it("all 用在「本体补完、附加项还没发」的行上:三条从头再发一遍(本体又发一次),补齐后删原件", async () => {
		const entry = await seedSilenced();
		const parked = () => {};
		gate = parked;
		await runner.start(entry.id, entry.createdAt, "missing");
		await vi.waitFor(() => expect(gate).not.toBe(parked));
		ctx.abort();
		(gate as () => void)();
		await ctx.settled();
		gate = null;
		expect((await settled(entry)).status).toBe("delivered");

		const restartedCtx = makeTrackingContext();
		const restarted = createRepushRunner({
			history,
			repush,
			send: recordingSend,
			routedTargets: () => routed,
			currentSubscriptionOf: (row) => row.subscriptionId,
			targetEnabled: () => enabled,
			logger: log,
			serviceCtx: restartedCtx,
		});
		sent = [];
		expect(started(await restarted.start(entry.id, entry.createdAt, "all"))).toBe(3);
		await restartedCtx.settled();
		expect(sent.map((s) => s.text)).toEqual(["下播卡", "词云", "总结"]);
		const row = await history.findRow(entry.id, entry.createdAt);
		expect(row?.messages.slice(3).map((m) => m.repushOf)).toEqual([0, 0, 1, 2]);
		expect(row?.status).toBe("delivered");
		expect(await repush.has(entry.id, entry.createdAt)).toBe(false);
	});

	it("路由里把目标去掉了 / 目标停用了 → 照挡(决策 10)", async () => {
		const entry = await seedSilenced();
		routed = [];
		expect(denied(await runner.start(entry.id, entry.createdAt, "missing"))).toContain("路由");
		routed = [T1];
		enabled = false;
		expect(denied(await runner.start(entry.id, entry.createdAt, "missing"))).toContain("停用");
		expect(sent).toHaveLength(0);
	});
});
