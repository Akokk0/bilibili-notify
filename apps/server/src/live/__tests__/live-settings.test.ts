import { describe, expect, it } from "vite-plus/test";
import { rotateLiveCover } from "../live-settings";
import type { CustomCardStyleLike, PickLiveCover } from "../live-types";

/**
 * 直播卡自定义封面的取法(全局 `cards.liveCoverImageIds` + 订阅自己的 `overrides.cards.liveCoverImageIds`):
 * - 全局:空 = 沿用来源的封面;一张 = 固定;多张 = 顺序轮换;
 * - 订阅:没设 = 跟全局;**空列表 = 不用自定义封面(不落回全局)**;一张 = 固定;多张 = 轮换。
 *
 * 订阅没设时宿主递进来的样式是 `{ enable: false }`;设了(含空列表)是 `{ enable: true, liveCoverImages: [...] }`。
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

const NO_OVERRIDE: CustomCardStyleLike = { enable: false };
const overrideOf = (ids: string[]): CustomCardStyleLike => ({
	enable: true,
	liveCoverImage: ids[0],
	liveCoverImages: ids,
});

describe("rotateLiveCover — 全局封面,订阅没设", () => {
	it("全局一张 → 固定用这一张,不动游标", () => {
		const { pick, calls } = countingPicker();
		const out = rotateLiveCover(NO_OVERRIDE, ["g1"], pick, "u1:live-cover");
		expect(out.enable).toBe(true);
		expect(out.liveCoverImage).toBe("g1");
		expect(calls).toEqual([]);
	});

	it("全局多张 → 每推一次顺序轮换", () => {
		const { pick } = countingPicker();
		const covers = [1, 2, 3].map(
			() => rotateLiveCover(NO_OVERRIDE, ["g1", "g2"], pick, "u1:live-cover").liveCoverImage,
		);
		expect(covers).toEqual(["g1", "g2", "g1"]);
	});

	it("全局为空 → 不带封面,样式原样(沿用来源的封面)", () => {
		const { pick } = countingPicker();
		expect(rotateLiveCover(NO_OVERRIDE, [], pick, "k")).toEqual({ enable: false });
		expect(rotateLiveCover(NO_OVERRIDE, undefined, pick, "k")).toEqual({ enable: false });
	});
});

describe("rotateLiveCover — 订阅自己设了", () => {
	it("空列表 → 不用自定义封面,全局有多张也不落回", () => {
		const { pick, calls } = countingPicker();
		const out = rotateLiveCover(overrideOf([]), ["g1", "g2"], pick, "k");
		expect(out.liveCoverImage).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("空列表 → 全局只有一张也不落回", () => {
		const { pick } = countingPicker();
		const out = rotateLiveCover(overrideOf([]), ["g1"], pick, "k");
		expect(out.liveCoverImage).toBeUndefined();
	});

	it("一张 → 固定用它,压过全局", () => {
		const { pick, calls } = countingPicker();
		const out = rotateLiveCover(overrideOf(["s1"]), ["g1", "g2"], pick, "k");
		expect(out.enable).toBe(true);
		expect(out.liveCoverImage).toBe("s1");
		expect(calls).toEqual([]);
	});

	it("多张 → 用它自己的列表轮换,游标键是传进来的那个", () => {
		const { pick, calls } = countingPicker();
		const covers = [1, 2, 3].map(
			() => rotateLiveCover(overrideOf(["s1", "s2"]), ["g1"], pick, "u1:live-cover").liveCoverImage,
		);
		expect(covers).toEqual(["s1", "s2", "s1"]);
		expect(calls).toEqual(["u1:live-cover", "u1:live-cover", "u1:live-cover"]);
	});
});
