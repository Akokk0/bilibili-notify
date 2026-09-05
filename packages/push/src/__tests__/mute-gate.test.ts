/**
 * 单元测试 — 全局静音闸。
 *
 * 静音挡的是**订阅推送**,闸和 quietHours 并排装在 `broadcastToFeature` 里,所以
 * 动态 / 直播 / SC / 上舰 / 词云 / 总结 / 下播 一道全挡住。
 *
 * 但**不挡发给主人的私聊**。这条不是风格取舍:主人敲下 `/mute` 之后,「好的,静音到
 * 几点」这句回复本身也走私聊路径。一起挡掉的话,他会看到指令毫无反应 —— 静音生效
 * 的唯一证据恰好被静音吞了。运行错误告警同理,静音是「别来推送打扰我」,不是
 * 「出了事也别告诉我」。
 *
 * provider 不传 = 完全维持旧行为,koishi 端没有指令系统、也就没有静音状态。
 */

import {
	type DeliveryResult,
	makeEmptySubscription,
	type NotificationPayload,
	type NotificationSink,
	type PushTarget,
	type Subscription,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it } from "vite-plus/test";
import { BilibiliPush } from "../bilibili-push";
import { pushBase, silentLogger } from "./helpers";

function makeSink(): { sink: NotificationSink; calls: string[] } {
	const calls: string[] = [];
	const sink: NotificationSink = {
		isAvailable: () => true,
		isEnabled: () => true,
		send: async (targetId) => {
			calls.push(targetId);
			return { ok: true, latencyMs: 1 } as DeliveryResult;
		},
		sendPrivate: async (targetId) => {
			calls.push(targetId);
			return { ok: true, latencyMs: 1 } as DeliveryResult;
		},
		resolve: (id) => ({ id, name: id, adapterId: "a" }) as unknown as PushTarget,
	};
	return { sink, calls };
}

function makeStore(subs: Subscription[]): SubscriptionStore {
	return {
		list: () => [...subs],
		findByUid: (uid) => subs.find((s) => s.uid === uid),
		findById: (id) => subs.find((s) => s.id === id),
		upsert: () => {},
		removeById: () => undefined,
		replaceAll: () => {},
	};
}

const MASTER = { id: "master", name: "master", adapterId: "a" } as unknown as PushTarget;

function setup(muted: () => boolean) {
	const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
	sub.routing.live = ["t1"];
	sub.routing.dynamic = ["t1"];
	sub.atAllDefaults.live = false;
	sub.atAllDefaults.dynamic = false;
	const { sink, calls } = makeSink();
	const push = new BilibiliPush({
		...pushBase(),
		sink,
		store: makeStore([sub]),
		logger: silentLogger,
		master: MASTER,
		muted,
	});
	push.start();
	return { push, calls };
}

const TEXT: NotificationPayload = { kind: "text", text: "x" };

describe("全局静音闸", () => {
	it("静音中 → 订阅推送不发,sink 一次都不调", async () => {
		const { push, calls } = setup(() => true);
		const out = await push.broadcastToFeature("u1", "live", TEXT);
		expect(out).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	it("没静音 → 照常发", async () => {
		const { push, calls } = setup(() => false);
		await push.broadcastToFeature("u1", "live", TEXT);
		expect(calls).toEqual(["t1"]);
	});

	// 「全局」的意思是所有 feature 一起挡,不是只挡开播。
	it("静音挡的是全部 feature,不只是直播", async () => {
		const { push, calls } = setup(() => true);
		await push.broadcastToFeature("u1", "dynamic", TEXT);
		expect(calls).toHaveLength(0);
	});

	// 每次现问,不是构造时快照 —— 否则到期之后要等下一次重启才恢复。
	it("到期后无需重建 push 实例,下一条推送就通了", async () => {
		let muted = true;
		const { push, calls } = setup(() => muted);
		await push.broadcastToFeature("u1", "live", TEXT);
		expect(calls).toHaveLength(0);
		muted = false;
		await push.broadcastToFeature("u1", "live", TEXT);
		expect(calls).toEqual(["t1"]);
	});

	// 这条是静音功能能不能用的前提:回复被自己挡掉的话,主人只会以为指令坏了。
	it("静音中,发给主人的私聊照发 —— 指令回复走的就是这条路", async () => {
		const { push, calls } = setup(() => true);
		await push.sendPrivateMsg("好的，静音到 21:00");
		expect(calls).toEqual(["master"]);
	});

	it("静音中,运行错误告警照发", async () => {
		const { push, calls } = setup(() => true);
		await push.sendErrorMsg("登录态失效了");
		expect(calls).toEqual(["master"]);
	});

	it("不传 provider → 一切照旧(koishi 端没有静音这回事)", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.live = ["t1"];
		sub.atAllDefaults.live = false;
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({
			...pushBase(),
			sink,
			store: makeStore([sub]),
			logger: silentLogger,
		});
		push.start();
		await push.broadcastToFeature("u1", "live", TEXT);
		expect(calls).toEqual(["t1"]);
	});
});
