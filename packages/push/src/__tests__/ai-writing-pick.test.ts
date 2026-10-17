/**
 * 单元测试 —— 推送层按**目标**挑正文(ADR-0032 决策 2)。
 *
 * 锚点可以带两份正文:`messages`(模板)与可选的 `aiMessages`(AI 版)。推送层按路由、闸、
 * 附加项收窄出该收的目标之后,逐目标按 `aiWriting()`(现取)挑那个目标用哪一份:
 * 例外里写了听例外,没写跟默认行。本体只认 `writing.post`,总结附加项只认 `writing.liveSummary`;
 * 「谁收」(三态表)与「用哪份字」(这张表)是两个维度,互不干涉。
 *
 * 断言一律落在派发器里每个目标**实际收到的载荷**与 `onSend` 里那个目标的消息上,不只数条数。
 */

import {
	type AiWritingSettings,
	type DeliveryResult,
	makeEmptySubscription,
	type NotificationPayload,
	type PushTarget,
	type Subscription,
	sameIdentity,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it } from "vite-plus/test";
import { PushRouter, type PushSendResult } from "../push-router";
import { type FakeDispatcher, setExtraDefault, silentLogger, trackedPushBase } from "./helpers";

const TEMPLATE: NotificationPayload = { kind: "text", text: "模板" };
const AI: NotificationPayload = { kind: "text", text: "点评" };

interface SendCall {
	targetId: string;
	payload: NotificationPayload;
}

const isAtAll = (p: NotificationPayload) =>
	p.kind === "composite" && p.segments.length === 1 && p.segments[0]?.kind === "at-all";

function makeDispatcher(opts?: { disabled?: string[] }): {
	dispatcher: FakeDispatcher;
	calls: SendCall[];
} {
	const calls: SendCall[] = [];
	const dispatcher: FakeDispatcher = {
		isAvailable: () => true,
		supportsAtAll: () => true,
		isEnabled: (id) => !opts?.disabled?.includes(id),
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

/** 写一份 `ai.writing`:`post` / `liveSummary` 各给「默认行」与例外,没给的是出厂(开、无例外)。 */
function writing(
	post: Partial<AiWritingSettings["post"]> = {},
	liveSummary: Partial<AiWritingSettings["liveSummary"]> = {},
): AiWritingSettings {
	return {
		post: { isOnByDefault: true, byTarget: {}, ...post },
		liveSummary: { isOnByDefault: true, byTarget: {}, ...liveSummary },
	};
}

function postSub(targets: string[]): Subscription {
	const sub = makeEmptySubscription({
		id: "s1",
		identity: { sourceKey: "bilibili", externalId: "u1" },
	});
	sub.routing.post = targets;
	return sub;
}

function makePush(
	sub: Subscription,
	state: { writing: AiWritingSettings; muted?: boolean },
	opts?: { disabled?: string[] },
) {
	const { dispatcher, calls } = makeDispatcher(opts);
	const { base, settled } = trackedPushBase();
	const sent: PushSendResult[] = [];
	const push = new PushRouter({
		...base,
		aiWriting: () => state.writing,
		muted: () => state.muted ?? false,
		dispatcher,
		store: makeStore([sub]),
		logger: silentLogger,
		onSend: (info) => sent.push(info),
	});
	push.start();
	return { push, calls, sent, settled };
}

/** 本体锚点:模板 + 可选的 AI 版。 */
function postPush(
	push: PushRouter,
	messages: PushAnchorMessages,
	aiMessages?: PushAnchorMessages,
	options?: { allowAtAll?: false },
) {
	return push.push({
		subscriptionId: "s1",
		feature: "post",
		...options,
		anchors: [{ role: "main", messages, ...(aiMessages ? { aiMessages } : {}) }],
	});
}
type PushAnchorMessages = NotificationPayload[] | Promise<NotificationPayload[] | undefined>;

/** 每个目标在派发器里收到的非 @全体 载荷文字。 */
function textsByTarget(calls: SendCall[]): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const c of calls) {
		if (isAtAll(c.payload)) continue;
		out[c.targetId] = [
			...(out[c.targetId] ?? []),
			c.payload.kind === "text" ? c.payload.text : c.payload.kind,
		];
	}
	return out;
}

/** `onSend` 里每个目标记下的消息文字。 */
function recordedByTarget(sent: PushSendResult[]): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const s of sent) {
		if (!s.target) continue;
		out[s.target.id] = [
			...(out[s.target.id] ?? []),
			...s.messages.map((m) => (m.payload.kind === "text" ? m.payload.text : m.payload.kind)),
		];
	}
	return out;
}

describe("按目标挑正文:本体(writing.post)", () => {
	it("默认开、乙写了关:甲收到 AI 版,乙收到模板版,onSend 各带各的", async () => {
		const { push, calls, sent } = makePush(postSub(["t1", "t2"]), {
			writing: writing({ isOnByDefault: true, byTarget: { t2: false } }),
		});
		await postPush(push, [TEMPLATE], [AI]);
		expect(textsByTarget(calls)).toEqual({ t1: ["点评"], t2: ["模板"] });
		expect(recordedByTarget(sent)).toEqual({ t1: ["点评"], t2: ["模板"] });
	});

	it("默认关、甲写了开:反过来", async () => {
		const { push, calls, sent } = makePush(postSub(["t1", "t2"]), {
			writing: writing({ isOnByDefault: false, byTarget: { t1: true } }),
		});
		await postPush(push, [TEMPLATE], [AI]);
		expect(textsByTarget(calls)).toEqual({ t1: ["点评"], t2: ["模板"] });
		expect(recordedByTarget(sent)).toEqual({ t1: ["点评"], t2: ["模板"] });
	});

	it("锚点没有 aiMessages:不管设置怎么写,全部收到 messages", async () => {
		const { push, calls } = makePush(postSub(["t1", "t2"]), {
			writing: writing({ isOnByDefault: true, byTarget: { t1: true } }),
		});
		await postPush(push, [TEMPLATE]);
		expect(textsByTarget(calls)).toEqual({ t1: ["模板"], t2: ["模板"] });
	});

	it("aiMessages 是被拒绝的约定:全部收到 messages,锚点没被跳过", async () => {
		const { push, calls } = makePush(postSub(["t1", "t2"]), { writing: writing() });
		await postPush(push, [TEMPLATE], Promise.reject(new Error("AI 没做出来")));
		expect(textsByTarget(calls)).toEqual({ t1: ["模板"], t2: ["模板"] });
	});

	it("aiMessages 给了空(数组或 undefined):全部收到 messages", async () => {
		const { push, calls } = makePush(postSub(["t1"]), { writing: writing() });
		await postPush(push, [TEMPLATE], []);
		await postPush(push, [TEMPLATE], Promise.resolve(undefined));
		expect(textsByTarget(calls)).toEqual({ t1: ["模板", "模板"] });
	});

	it("messages 自己为空或被拒绝仍跳过,哪怕 aiMessages 好好的", async () => {
		const { push, calls, sent } = makePush(postSub(["t1"]), { writing: writing() });
		await postPush(push, [], [AI]);
		await postPush(push, Promise.reject(new Error("模板没做出来")), [AI]);
		expect(calls).toEqual([]);
		expect(sent).toEqual([]);
	});

	it("多条序列整段挑同一份:AI 版两条、模板一条,各按各的条数发", async () => {
		const ai2: NotificationPayload = { kind: "text", text: "点评二" };
		const { push, calls } = makePush(postSub(["t1", "t2"]), {
			writing: writing({ isOnByDefault: true, byTarget: { t2: false } }),
		});
		await postPush(push, [TEMPLATE], [AI, ai2]);
		expect(textsByTarget(calls)).toEqual({ t1: ["点评", "点评二"], t2: ["模板"] });
	});

	it("byTarget 里路由之外的 id、停用目标的 id:无影响", async () => {
		const { push, calls } = makePush(
			postSub(["t1", "t3"]),
			{ writing: writing({ isOnByDefault: false, byTarget: { t9: true, t3: true } }) },
			{ disabled: ["t3"] },
		);
		await postPush(push, [TEMPLATE], [AI]);
		// t3 停用:不收;t9 不在路由里:无事发生;t1 没写,跟默认(关)。
		expect(textsByTarget(calls)).toEqual({ t1: ["模板"] });
	});

	it("无目标(没有可用路由):记「默认那一份」,只听默认行、不听例外", async () => {
		const on = makePush(postSub([]), { writing: writing({ isOnByDefault: true }) });
		await postPush(on.push, [TEMPLATE], [AI]);
		expect(on.sent).toHaveLength(1);
		expect(on.sent[0]?.target).toBeNull();
		expect(on.sent[0]?.messages.map((m) => m.payload)).toEqual([AI]);

		const off = makePush(postSub([]), {
			writing: writing({ isOnByDefault: false, byTarget: { t1: true } }),
		});
		await postPush(off.push, [TEMPLATE], [AI]);
		expect(off.sent[0]?.messages.map((m) => m.payload)).toEqual([TEMPLATE]);

		const noAi = makePush(postSub([]), { writing: writing({ isOnByDefault: true }) });
		await postPush(noAi.push, [TEMPLATE]);
		expect(noAi.sent[0]?.messages.map((m) => m.payload)).toEqual([TEMPLATE]);
	});

	it("被静音挡下:每个目标记下的是它自己那份,带 isSilenced,一条都没发", async () => {
		const { push, calls, sent } = makePush(postSub(["t1", "t2"]), {
			writing: writing({ isOnByDefault: true, byTarget: { t2: false } }),
			muted: true,
		});
		await postPush(push, [TEMPLATE], [AI]);
		expect(calls).toEqual([]);
		expect(recordedByTarget(sent)).toEqual({ t1: ["点评"], t2: ["模板"] });
		expect(sent.every((s) => s.messages.every((m) => "isSilenced" in m && m.isSilenced))).toBe(
			true,
		);
	});

	it("读口是现取的:构造之后改了设置,下一次推送按新的挑", async () => {
		const state = { writing: writing({ isOnByDefault: true }) };
		const { push, calls } = makePush(postSub(["t1"]), state);
		await postPush(push, [TEMPLATE], [AI]);
		state.writing = writing({ isOnByDefault: false });
		await postPush(push, [TEMPLATE], [AI]);
		expect(textsByTarget(calls)).toEqual({ t1: ["点评", "模板"] });
	});
});

describe("按目标挑正文:与 @全体 叠", () => {
	it("四个目标各占一种:每个 @ 的目标上 at-all 先于本体,本体是它自己挑的那份,次序同今天", async () => {
		const sub = postSub(["t1", "t2", "t3", "t4"]);
		// t1、t2 要 @全体;t3、t4 不要。t2、t4 不用 AI。
		sub.extraTargets.atAllPost = { t1: true, t2: true };
		const { push, calls } = makePush(sub, {
			writing: writing({ isOnByDefault: true, byTarget: { t2: false, t4: false } }),
		});
		await postPush(push, [TEMPLATE], [AI]);
		const trace = calls.map(
			(c) => `${c.targetId}:${isAtAll(c.payload) ? "@" : (c.payload as { text: string }).text}`,
		);
		// 先不 @ 的组(按路由先后),后 @ 的组(每个目标 @ 在前、本体在后)。
		expect(trace).toEqual(["t3:点评", "t4:模板", "t1:@", "t1:点评", "t2:@", "t2:模板"]);
	});

	it("@全体 卡住时 push() 照常返回,卡片是自己挑的那份", async () => {
		const sub = postSub(["t1"]);
		sub.extraTargets.atAllPost = { t1: true };
		const calls: SendCall[] = [];
		const dispatcher: FakeDispatcher = {
			isAvailable: () => true,
			supportsAtAll: () => true,
			isEnabled: () => true,
			send: (targetId, payload) => {
				calls.push({ targetId, payload });
				if (isAtAll(payload)) return new Promise<DeliveryResult>(() => {});
				return Promise.resolve({ ok: true, latencyMs: 1 } as DeliveryResult);
			},
			resolve: (id) => ({ id, name: id, platform: "test" }) as unknown as PushTarget,
		};
		const { base } = trackedPushBase();
		const push = new PushRouter({
			...base,
			aiWriting: () => writing(),
			dispatcher,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		const out = await postPush(push, [TEMPLATE], [AI]);
		expect(out).toHaveLength(1);
		expect(isAtAll(calls[0]?.payload as NotificationPayload)).toBe(true);
		expect(calls[1]?.payload).toEqual(AI);
	});
});

describe("按目标挑正文:附加项(writing.liveSummary)", () => {
	function summarySub(): Subscription {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.liveEnd = ["t1", "t2", "t3"];
		return sub;
	}

	function pushSummary(push: PushRouter, withAi = true) {
		return push.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [
				{
					role: "extra",
					extra: "liveSummary",
					messages: [TEMPLATE],
					...(withAi ? { aiMessages: [AI] } : {}),
				},
			],
		});
	}

	it("先按三态表收窄谁收,再按 writing.liveSummary 挑用哪份字,两个维度互不干涉", async () => {
		const sub = summarySub();
		setExtraDefault(sub, "liveSummary", true);
		// t3 不订总结:即使 byTarget 写了开也收不到。
		sub.extraTargets.liveSummary = { t3: false };
		const { push, calls, settled } = makePush(sub, {
			// 本体那份(writing.post)故意反着写,证明总结不看它。
			writing: writing(
				{ isOnByDefault: false },
				{ isOnByDefault: false, byTarget: { t1: true, t3: true } },
			),
		});
		await pushSummary(push);
		await settled();
		expect(textsByTarget(calls)).toEqual({ t1: ["点评"], t2: ["模板"] });
	});

	it("总结附加项不看 writing.post", async () => {
		const sub = summarySub();
		setExtraDefault(sub, "liveSummary", true);
		const { push, calls, settled } = makePush(sub, {
			writing: writing({ isOnByDefault: true }, { isOnByDefault: false }),
		});
		await pushSummary(push);
		await settled();
		expect(textsByTarget(calls)).toEqual({ t1: ["模板"], t2: ["模板"], t3: ["模板"] });
	});

	it("没有 aiMessages 的总结锚点:全部模板", async () => {
		const sub = summarySub();
		setExtraDefault(sub, "liveSummary", true);
		const { push, calls, settled } = makePush(sub, { writing: writing() });
		await pushSummary(push, false);
		await settled();
		expect(textsByTarget(calls)).toEqual({ t1: ["模板"], t2: ["模板"], t3: ["模板"] });
	});

	it("不是 post 本体、也不带 liveSummary 键的锚点,带了 aiMessages 也不挑", async () => {
		const sub = summarySub();
		const { push, calls } = makePush(sub, { writing: writing() });
		await push.push({
			subscriptionId: "s1",
			feature: "liveEnd",
			anchors: [{ role: "main", messages: [TEMPLATE], aiMessages: [AI] }],
		});
		expect(textsByTarget(calls)).toEqual({ t1: ["模板"], t2: ["模板"], t3: ["模板"] });
	});
});
