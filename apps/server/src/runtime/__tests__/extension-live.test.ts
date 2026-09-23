/**
 * 拓展订阅的在播表(ADR-0019 决策 12 / 57 / 61):首页「正在直播」里拓展那几行的来处。
 *
 * 表只听总线 —— 拓展的上报(`subscription-reported`)、订阅的增删改(`subscription-changed`)、拓展
 * 停了(`extension-stopped`)—— 所以这里拿一条真的总线去喂它,剪掉哪一处订阅都会红。
 */

import type {
	Disposable,
	SubscriptionReport,
	SubscriptionReportDelivery,
} from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import {
	createExtensionLiveTable,
	EXTENSION_LIVE_COALESCE_MS,
	type ExtensionLiveTable,
	extensionLiveSnapshot,
} from "../extension-live.js";
import { createNodeMessageBus } from "../message-bus.js";

const EXT = "douyin";
const SUB_A = "c0000000-0000-4000-8000-000000000001";
const SUB_B = "c0000000-0000-4000-8000-000000000002";
const T0 = Date.UTC(2026, 8, 23, 12);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** 手摇的定时器:合并窗口什么时候到,由测试说了算。 */
function manualTimers() {
	const pending: Array<{ fn: () => void; ms: number; live: boolean }> = [];
	return {
		pending,
		setTimeout(fn: () => void, ms: number): Disposable {
			const job = { fn, ms, live: true };
			pending.push(job);
			return {
				dispose() {
					job.live = false;
				},
			};
		},
		/** 到点的那些跑一遍。 */
		flush() {
			for (const job of pending.splice(0)) if (job.live) job.fn();
		},
	};
}

let bus: ReturnType<typeof createNodeMessageBus>;
let timers: ReturnType<typeof manualTimers>;
let clock: number;
let table: ExtensionLiveTable;
/** 总线上听到的每一发「在播表变了」。 */
let changed: number;

beforeEach(() => {
	bus = createNodeMessageBus();
	timers = manualTimers();
	clock = T0;
	changed = 0;
	bus.on("extension-live-changed", () => {
		changed += 1;
	});
	table = createExtensionLiveTable({ bus, timers, now: () => clock });
});

function report(
	report: SubscriptionReport,
	subscriptionIds: string[] = [SUB_A],
	extensionId = EXT,
): void {
	const delivery: SubscriptionReportDelivery = {
		extensionId,
		externalId: "sec-1",
		subscriptionIds,
		report,
	};
	bus.emit("subscription-reported", delivery);
}

const LIVE_URL = "https://live.douyin.com/1";

describe("开播 / 下播", () => {
	it("开播 → 进表,带着开播时刻与直播那几格;下播 → 出表", () => {
		report({
			kind: "liveStart",
			value: {
				url: LIVE_URL,
				startedAt: T0 - 60_000,
				title: "晚上好",
				cover: PNG,
				category: "聊天",
				viewers: 12,
				likes: 3,
			},
		});
		expect(table.get(SUB_A)).toEqual({
			subscriptionId: SUB_A,
			extensionId: EXT,
			startedAt: T0 - 60_000,
			title: "晚上好",
			cover: PNG,
			category: "聊天",
			viewers: 12,
			likes: 3,
			url: LIVE_URL,
			updatedAt: T0,
		});
		expect(table.list().map((row) => row.subscriptionId)).toEqual([SUB_A]);

		report({ kind: "liveEnd", value: { url: LIVE_URL } });
		expect(table.get(SUB_A)).toBeUndefined();
		expect(table.list()).toEqual([]);
	});
});

describe("直播状态", () => {
	it("live: true → 报了的格盖上去、没报的留着;开播时刻一直在;最后更新时刻跟着走", () => {
		report({
			kind: "liveStart",
			value: { url: LIVE_URL, startedAt: T0 - 60_000, title: "晚上好", cover: PNG, viewers: 12 },
		});
		clock = T0 + 30_000;
		report({ kind: "liveStatus", value: { live: true, viewers: 40, likes: 7 } });
		expect(table.get(SUB_A)).toEqual({
			subscriptionId: SUB_A,
			extensionId: EXT,
			startedAt: T0 - 60_000,
			title: "晚上好",
			cover: PNG,
			viewers: 40,
			likes: 7,
			url: LIVE_URL,
			updatedAt: T0 + 30_000,
		});
		// 报了新标题就换成新的。
		report({ kind: "liveStatus", value: { live: true, title: "改名了" } });
		expect(table.get(SUB_A)?.title).toBe("改名了");
		expect(table.get(SUB_A)?.startedAt).toBe(T0 - 60_000);
	});

	it("live: true 而表里没有(BN 中途重启过、开播事件没见着)→ 照样进表;没报开播时刻就没有", () => {
		report({ kind: "liveStatus", value: { live: true, title: "早就在播了", viewers: 5 } });
		expect(table.get(SUB_A)).toEqual({
			subscriptionId: SUB_A,
			extensionId: EXT,
			title: "早就在播了",
			viewers: 5,
			updatedAt: T0,
		});
	});

	it("live: false → 出表", () => {
		report({ kind: "liveStart", value: { url: LIVE_URL, startedAt: T0 } });
		report({ kind: "liveStatus", value: { live: false } });
		expect(table.get(SUB_A)).toBeUndefined();
	});

	it("新的一场开播:上一场留下的格一概不带(漏了下播的那场在这儿收尾)", () => {
		report({ kind: "liveStatus", value: { live: true, title: "上一场", cover: PNG, likes: 99 } });
		report({ kind: "liveStart", value: { url: LIVE_URL, startedAt: T0 + 1_000 } });
		expect(table.get(SUB_A)).toEqual({
			subscriptionId: SUB_A,
			extensionId: EXT,
			startedAt: T0 + 1_000,
			url: LIVE_URL,
			updatedAt: T0,
		});
	});

	it("一条上报对上同一个人的几条订阅:每条各进各的", () => {
		report({ kind: "liveStart", value: { url: LIVE_URL, startedAt: T0 } }, [SUB_A, SUB_B]);
		expect(table.list().map((row) => row.subscriptionId)).toEqual([SUB_A, SUB_B]);
		report({ kind: "liveEnd", value: { url: LIVE_URL } }, [SUB_B]);
		expect(table.list().map((row) => row.subscriptionId)).toEqual([SUB_A]);
	});

	it("作品与资料更新不碰在播表", () => {
		report({
			kind: "post",
			value: { id: "p1", url: "https://www.douyin.com/video/p1", publishedAt: T0 },
		});
		report({ kind: "profile", value: { name: "新名字" } });
		expect(table.list()).toEqual([]);
		expect(timers.pending).toEqual([]);
	});
});

describe("作废", () => {
	it("拓展停了 → 它名下的全部出表,别的拓展的留着", () => {
		report({ kind: "liveStart", value: { url: LIVE_URL, startedAt: T0 } }, [SUB_A]);
		report({ kind: "liveStart", value: { url: LIVE_URL, startedAt: T0 } }, [SUB_B], "kuaishou");
		bus.emit("extension-stopped", EXT);
		expect(table.list().map((row) => row.subscriptionId)).toEqual([SUB_B]);
	});

	it("订阅删了 / 停用了 → 出表;别的改动(改备注)不动它", () => {
		report({ kind: "liveStart", value: { url: LIVE_URL, startedAt: T0 } }, [SUB_A, SUB_B]);
		const a = makeExtensionSubscription({ id: SUB_A, extensionId: EXT, externalId: "sec-1" });
		const b = makeExtensionSubscription({ id: SUB_B, extensionId: EXT, externalId: "sec-1" });

		bus.emit("subscription-changed", [{ type: "update", sub: { ...a, notes: "备注" } }]);
		expect(table.get(SUB_A)).toBeDefined();

		bus.emit("subscription-changed", [{ type: "update", sub: { ...a, enabled: false } }]);
		expect(table.get(SUB_A)).toBeUndefined();

		bus.emit("subscription-changed", [{ type: "remove", sub: b }]);
		expect(table.list()).toEqual([]);
	});
});

describe("「在播表变了」", () => {
	it("进表、改人数、又进一条挨着来 → 窗口尾沿只发一次", () => {
		report({ kind: "liveStart", value: { url: LIVE_URL, startedAt: T0 } });
		report({ kind: "liveStatus", value: { live: true, viewers: 3 } });
		report({ kind: "liveStart", value: { url: LIVE_URL, startedAt: T0 } }, [SUB_B]);
		expect(changed).toBe(0);
		expect(timers.pending.map((job) => job.ms)).toEqual([EXTENSION_LIVE_COALESCE_MS]);
		timers.flush();
		expect(changed).toBe(1);

		// 窗口过了,下一处变化另起一个窗口。
		bus.emit("extension-stopped", EXT);
		timers.flush();
		expect(changed).toBe(2);
	});

	it("每轮都报、面板上看得见的一格没变 → 不发", () => {
		report({ kind: "liveStatus", value: { live: true, title: "同一场", viewers: 3 } });
		timers.flush();
		changed = 0;
		clock = T0 + 60_000;
		// 点赞、封面、链接首页不画,变了也不惊动面板;最后更新时刻照样跟着走。
		report({
			kind: "liveStatus",
			value: { live: true, title: "同一场", viewers: 3, likes: 10, cover: PNG, url: LIVE_URL },
		});
		expect(timers.pending).toEqual([]);
		expect(table.get(SUB_A)?.updatedAt).toBe(T0 + 60_000);
		// 不在表里的下播、停了一个名下什么都没有的拓展:什么都没变。
		report({ kind: "liveEnd", value: { url: LIVE_URL } }, [SUB_B]);
		bus.emit("extension-stopped", "kuaishou");
		expect(timers.pending).toEqual([]);
		expect(changed).toBe(0);
	});

	it("收摊之后不再听总线,挂着的那一发也不发了", () => {
		report({ kind: "liveStart", value: { url: LIVE_URL, startedAt: T0 } });
		table.dispose();
		timers.flush();
		expect(changed).toBe(0);
		report({ kind: "liveStart", value: { url: LIVE_URL, startedAt: T0 } }, [SUB_B]);
		expect(table.get(SUB_B)).toBeUndefined();
	});
});

describe("面板上的那一行", () => {
	it("时刻换成 ISO、分区叫 areaName、人数原样是数字;封面与点赞不上面板", () => {
		report({
			kind: "liveStart",
			value: {
				url: LIVE_URL,
				startedAt: T0,
				title: "晚上好",
				cover: PNG,
				category: "聊天",
				viewers: 12,
				likes: 3,
			},
		});
		const row = table.get(SUB_A);
		expect(row && JSON.parse(JSON.stringify(extensionLiveSnapshot(row)))).toEqual({
			kind: "extension",
			subscriptionId: SUB_A,
			extensionId: EXT,
			isLive: true,
			title: "晚上好",
			areaName: "聊天",
			startedAt: new Date(T0).toISOString(),
			viewers: 12,
		});
	});
});
