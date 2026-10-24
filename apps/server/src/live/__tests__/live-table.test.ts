/**
 * 在播表(ADR-0019 决策 12 / 57 / 61):首页「正在直播」里那几行的来处。
 *
 * 写表的是场次引擎(`LiveSessionEngine.apply` 先写表、再改场次,见 `live-sessions.test.ts`),这里直接调表的三个
 * 写口(`replace` / `merge` / `remove`);表自己只听总线两处 —— 来源停了(`extension-stopped`)、订阅删了 / 停用了
 * (`subscription-changed`)—— 所以拿一条真的总线去喂它,剪掉哪一处订阅都会红。
 *
 * 行里装的是中立的 `LiveDetails`(图是图库引用):「行装的是 `LiveDetails`」那一条钉的是 data-model 的
 * 「图一律图库引用」。
 */

import type { LiveDetails } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createLiveTable, type LiveTable, liveListeningEntryOf } from "../live-table.js";

const EXT = "douyin";
const SUB_A = "c0000000-0000-4000-8000-000000000001";
const SUB_B = "c0000000-0000-4000-8000-000000000002";
const T0 = Date.UTC(2026, 8, 23, 12);
const COVER_REF = `${"c".repeat(64)}.png`;
const AVATAR_REF = `${"a".repeat(64)}.png`;

let bus: ReturnType<typeof createNodeMessageBus>;
let clock: number;
let table: LiveTable;

beforeEach(() => {
	bus = createNodeMessageBus();
	clock = T0;
	table = createLiveTable({ bus, now: () => clock });
});

const LIVE_URL = "https://live.douyin.com/1";

/** 开一场:整行换新(引擎收到开播信号时的写法)。 */
function start(
	details: LiveDetails = {},
	over: { ids?: string[]; sourceKey?: string; startedAt?: number } = {},
): void {
	for (const id of over.ids ?? [SUB_A]) {
		table.replace(id, over.sourceKey ?? EXT, over.startedAt ?? T0, { url: LIVE_URL, ...details });
	}
}

/** 一份在播的直播状态:报了的格盖上去(引擎收到 `isLive: true` 的状态信号时的写法)。 */
function status(
	details: LiveDetails = {},
	over: { ids?: string[]; sourceKey?: string; startedAt?: number } = {},
): void {
	for (const id of over.ids ?? [SUB_A]) {
		table.merge(id, over.sourceKey ?? EXT, over.startedAt, details);
	}
}

describe("开播 / 下播", () => {
	it("行装的是 LiveDetails:开播 → 进表,带着开播时刻与直播那几格(图是图库引用);下播 → 出表", () => {
		start(
			{
				title: "晚上好",
				cover: { ref: COVER_REF },
				category: "聊天",
				currentViewers: 12,
				totalViewers: 340,
				likes: 3,
				creator: { name: "抖音甲", avatar: AVATAR_REF },
			},
			{ startedAt: T0 - 60_000 },
		);
		expect(table.get(SUB_A)).toEqual({
			subscriptionId: SUB_A,
			sourceKey: EXT,
			startedAt: T0 - 60_000,
			details: {
				title: "晚上好",
				cover: { ref: COVER_REF },
				category: "聊天",
				url: LIVE_URL,
				currentViewers: 12,
				totalViewers: 340,
				likes: 3,
				creator: { name: "抖音甲", avatar: AVATAR_REF },
			},
			updatedAt: T0,
		});
		expect(table.list().map((row) => row.subscriptionId)).toEqual([SUB_A]);

		table.remove(SUB_A);
		expect(table.get(SUB_A)).toBeUndefined();
		expect(table.list()).toEqual([]);
	});
});

describe("直播状态", () => {
	it("在播 → 报了的格盖上去、没报的留着;开播时刻一直在;最后更新时刻跟着走", () => {
		start(
			{ title: "晚上好", cover: { ref: COVER_REF }, currentViewers: 12 },
			{ startedAt: T0 - 60_000 },
		);
		clock = T0 + 30_000;
		status({ currentViewers: 40, likes: 7 });
		expect(table.get(SUB_A)).toEqual({
			subscriptionId: SUB_A,
			sourceKey: EXT,
			startedAt: T0 - 60_000,
			details: {
				title: "晚上好",
				cover: { ref: COVER_REF },
				url: LIVE_URL,
				currentViewers: 40,
				likes: 7,
			},
			updatedAt: T0 + 30_000,
		});
		// 报了新标题就换成新的。
		status({ title: "改名了" });
		expect(table.get(SUB_A)?.details.title).toBe("改名了");
		expect(table.get(SUB_A)?.startedAt).toBe(T0 - 60_000);
	});

	it("在线与累计两格各合并各的:这一轮只报了一格,另一格留着上一轮的(决策 75)", () => {
		start({ currentViewers: 12, totalViewers: 340 });
		status({ currentViewers: 30 });
		expect(table.get(SUB_A)?.details).toMatchObject({ currentViewers: 30, totalViewers: 340 });
		status({ totalViewers: 900 });
		expect(table.get(SUB_A)?.details).toMatchObject({ currentViewers: 30, totalViewers: 900 });
		// 只报过直播状态(BN 重启过)也带得进来。
		status({ totalViewers: 7 }, { ids: [SUB_B] });
		expect(table.get(SUB_B)?.details.totalViewers).toBe(7);
	});

	it("在播而表里没有(BN 中途重启过、开播信号没见着)→ 照样进表;没报开播时刻就没有", () => {
		status({ title: "早就在播了", currentViewers: 5 });
		expect(table.get(SUB_A)).toEqual({
			subscriptionId: SUB_A,
			sourceKey: EXT,
			details: { title: "早就在播了", currentViewers: 5 },
			updatedAt: T0,
		});
	});

	it("没报的格不带键:合并时「没报」不盖掉已有的", () => {
		start({ title: "晚上好" });
		status({ title: undefined, likes: 1 });
		expect(table.get(SUB_A)?.details).toEqual({ title: "晚上好", url: LIVE_URL, likes: 1 });
	});

	it("新的一场开播:上一场留下的格一概不带(漏了下播的那场在这儿收尾)", () => {
		status({ title: "上一场", cover: { ref: COVER_REF }, likes: 99 });
		start({}, { startedAt: T0 + 1_000 });
		expect(table.get(SUB_A)).toEqual({
			subscriptionId: SUB_A,
			sourceKey: EXT,
			startedAt: T0 + 1_000,
			details: { url: LIVE_URL },
			updatedAt: T0,
		});
	});

	it("几条订阅各进各的、各出各的", () => {
		start({}, { ids: [SUB_A, SUB_B] });
		expect(table.list().map((row) => row.subscriptionId)).toEqual([SUB_A, SUB_B]);
		table.remove(SUB_B);
		expect(table.list().map((row) => row.subscriptionId)).toEqual([SUB_A]);
	});
});

describe("作废", () => {
	it("收摊之后不再听总线、不再收写", () => {
		start();
		table.dispose();

		bus.emit("extension-stopped", { extensionId: EXT });
		start({}, { ids: [SUB_B] });

		expect(table.list().map((row) => row.subscriptionId)).toEqual([SUB_A]);
	});

	it("来源停了 → 它名下的全部出表,别的来源的留着", () => {
		start({}, { ids: [SUB_A] });
		start({}, { ids: [SUB_B], sourceKey: "kuaishou" });
		bus.emit("extension-stopped", { extensionId: EXT });
		expect(table.list().map((row) => row.subscriptionId)).toEqual([SUB_B]);
	});

	it("订阅删了 / 停用了 → 出表;别的改动(改备注)不动它", () => {
		start({}, { ids: [SUB_A, SUB_B] });
		const a = makeExtensionSubscription({ id: SUB_A, extensionId: EXT, externalId: "sec-1" });
		const b = makeExtensionSubscription({ id: SUB_B, extensionId: EXT, externalId: "sec-1" });

		bus.emit("subscription-changed", { ops: [{ kind: "update", sub: { ...a, notes: "备注" } }] });
		expect(table.get(SUB_A)).toBeDefined();

		bus.emit("subscription-changed", { ops: [{ kind: "update", sub: { ...a, enabled: false } }] });
		expect(table.get(SUB_A)).toBeUndefined();

		bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: b }] });
		expect(table.list()).toEqual([]);
	});
});

describe("在播行的对外投影", () => {
	it("时刻换成 ISO、分区叫 category、累计观看原样是数字;带 identity,此刻在线与封面不上面板", () => {
		start({
			title: "晚上好",
			cover: { ref: COVER_REF },
			category: "聊天",
			currentViewers: 12,
			totalViewers: 3_456,
			likes: 3,
		});
		const row = table.get(SUB_A);
		const identity = { sourceKey: EXT, externalId: "sec-1" };
		expect(row && JSON.parse(JSON.stringify(liveListeningEntryOf(row, identity)))).toEqual({
			subscriptionId: SUB_A,
			identity,
			isLive: true,
			title: "晚上好",
			category: "聊天",
			startedAt: new Date(T0).toISOString(),
			totalViewers: 3_456,
		});
	});
});

describe("观看人数缺数与零", () => {
	it("还没收到过帧 → undefined；收到 0 → 保持 0", () => {
		start();
		expect(table.get(SUB_A)?.details).not.toHaveProperty("totalViewers");
		status({ totalViewers: 0 });
		expect(table.get(SUB_A)?.details.totalViewers).toBe(0);
	});
});
