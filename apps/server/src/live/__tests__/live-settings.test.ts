import { makeDefaultGlobalConfig, makeEmptySubscription } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createLiveSettingsCache, rotateLiveCover } from "../live-settings";
import type { PickLiveCover } from "../live-types";

/**
 * 直播卡自定义封面的取法(全局 `cards.liveCoverImageIds` + 订阅自己的 `overrides.cards.liveCoverImageIds`):
 * - 全局:空 = 沿用来源的封面;一张 = 固定;多张 = 顺序轮换;
 * - 订阅:没设 = 跟全局;**空列表 = 不用自定义封面(不落回全局)**;一张 = 固定;多张 = 轮换。
 *
 * 订阅没设时宿主递进来的是 `undefined`;设了(含空列表)是那串资产 id。返回这一张卡用的封面资产 id,没有就 `undefined`。
 */

/** 按游标键顺序轮换的选择器,和宿主的 `pickExistingCardBg` 同一个形状。 */
function countingPicker() {
	const cursors: Record<string, number> = {};
	const calls: string[] = [];
	const pick: PickLiveCover = (key, images) => {
		calls.push(key);
		const i = cursors[key] ?? 0;
		cursors[key] = i + 1;
		return images[i % images.length];
	};
	return { pick, calls };
}

describe("rotateLiveCover — 全局封面,订阅没设", () => {
	it("全局一张 → 固定用这一张,不动游标", () => {
		const { pick, calls } = countingPicker();
		expect(rotateLiveCover(undefined, ["g1"], pick, "u1:live-cover")).toBe("g1");
		expect(calls).toEqual([]);
	});

	it("全局多张 → 每推一次顺序轮换", () => {
		const { pick } = countingPicker();
		const covers = [1, 2, 3].map(() =>
			rotateLiveCover(undefined, ["g1", "g2"], pick, "u1:live-cover"),
		);
		expect(covers).toEqual(["g1", "g2", "g1"]);
	});

	it("全局为空 → 不带封面(沿用来源的封面)", () => {
		const { pick } = countingPicker();
		expect(rotateLiveCover(undefined, [], pick, "k")).toBeUndefined();
		expect(rotateLiveCover(undefined, undefined, pick, "k")).toBeUndefined();
	});

	it("全局多张而选择器选不出 → 不带封面(全局那套没有首张兜底)", () => {
		expect(rotateLiveCover(undefined, ["g1", "g2"], () => undefined, "k")).toBeUndefined();
	});
});

describe("rotateLiveCover — 订阅自己设了", () => {
	it("空列表 → 不用自定义封面,全局有多张也不落回", () => {
		const { pick, calls } = countingPicker();
		expect(rotateLiveCover([], ["g1", "g2"], pick, "k")).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("空列表 → 全局只有一张也不落回", () => {
		const { pick } = countingPicker();
		expect(rotateLiveCover([], ["g1"], pick, "k")).toBeUndefined();
	});

	it("一张 → 固定用它,压过全局", () => {
		const { pick, calls } = countingPicker();
		expect(rotateLiveCover(["s1"], ["g1", "g2"], pick, "k")).toBe("s1");
		expect(calls).toEqual([]);
	});

	it("多张 → 用它自己的列表轮换,游标键是传进来的那个", () => {
		const { pick, calls } = countingPicker();
		const covers = [1, 2, 3].map(() =>
			rotateLiveCover(["s1", "s2"], ["g1"], pick, "u1:live-cover"),
		);
		expect(covers).toEqual(["s1", "s2", "s1"]);
		expect(calls).toEqual(["u1:live-cover", "u1:live-cover", "u1:live-cover"]);
	});

	it("多张而选择器选不出 → 退回自己列表的首张", () => {
		expect(rotateLiveCover(["s1", "s2"], ["g1"], () => undefined, "k")).toBe("s1");
	});
});

describe("B 站封面轮换游标", () => {
	it("B 站来源的游标键带来源前缀: bilibili:<uid>:live-cover", () => {
		const calls: string[] = [];
		rotateLiveCover(
			["s1", "s2"],
			[],
			(key) => {
				calls.push(key);
				return "s1";
			},
			"bilibili:u1:live-cover",
		);
		expect(calls).toEqual(["bilibili:u1:live-cover"]);
	});
});

/**
 * 折好的直播设置缓存的读口:`(sub) => liveSettingsOf(sub, globals())` 不再每条互动现折一次
 * (每次都是一份 globals 深拷贝)。按 `Subscription` 对象身份认,`globals` 换了整张作废 ——
 * 订阅仓每次改动都整条换新对象,所以改了订阅自然不命中。
 */
describe("createLiveSettingsCache", () => {
	it("同一订阅对象读两次只折一次;globals 变了、换了订阅对象才重折", () => {
		const bus = createNodeMessageBus();
		const globals = vi.fn(() => makeDefaultGlobalConfig());
		const cache = createLiveSettingsCache({ bus, getGlobals: globals });
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "acme", externalId: "room-1" },
		});

		const first = cache.of(sub);
		expect(cache.of(sub)).toBe(first);
		expect(globals).toHaveBeenCalledTimes(1);

		bus.emit("config-changed", { scope: "globals" });
		const afterGlobals = cache.of(sub);
		expect(afterGlobals).not.toBe(first);
		expect(globals).toHaveBeenCalledTimes(2);

		// 订阅仓改一条订阅是整条换新对象:同一个 id 的新对象不命中旧缓存。
		const replacement = { ...sub };
		cache.of(replacement);
		expect(globals).toHaveBeenCalledTimes(3);

		// 只有 globals 作用域会影响折出来的直播设置,别的作废事件不重折。
		bus.emit("config-changed", { scope: "targets" });
		cache.of(replacement);
		expect(globals).toHaveBeenCalledTimes(3);

		cache.dispose();
	});
});
