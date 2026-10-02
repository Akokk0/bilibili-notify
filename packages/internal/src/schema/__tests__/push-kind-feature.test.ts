/**
 * **推送类型 ↔ 特性键,两头对表。**
 *
 * 一条历史行记的是 `PushKind`(8 种),而路由、闸、订阅里的开关认的是 `FeatureKey`
 * (8 把)—— 人工重推要复检「这个目标还在不在这条路由里」,就得从行上那个 kind 翻回
 * 那把键。⑬d 之后周期「正在直播」有了自己的特性键 `liveStreaming`,两边一一对应:
 * 历史行的 `live-ongoing` 归 `liveStreaming`,`live` 归 `liveStart`(重启补报也记成 `live`)。
 *
 * 这一份钉的是**两个方向对得上**,不是复述任何一张表:
 *
 * - 每一把 `FeatureKey` 正着翻成 `PushKind` 再翻回来,必须还是它自己;
 * - 每一种 `PushKind` 都翻得出一把**真实存在**的键,一种都不能漏。
 *
 * 将来加第 9 把特性键、或者再拆一种推送类型出来,漏改任何一边这里都会红。
 */

import { describe, expect, it } from "vite-plus/test";
import { FEATURE_KEYS } from "../../constants.js";
import { featureToPushKind, PushKindSchema, pushKindToFeature } from "../history.js";

describe("PushKind ↔ FeatureKey", () => {
	it("每一把键翻过去再翻回来,还是它自己", () => {
		for (const key of FEATURE_KEYS) {
			expect(pushKindToFeature(featureToPushKind(key))).toBe(key);
		}
	});

	it("每一种推送类型都翻得出一把真实存在的键", () => {
		for (const kind of PushKindSchema.options) {
			expect(FEATURE_KEYS).toContain(pushKindToFeature(kind));
		}
	});

	/**
	 * 比「都对得上」更进一步:两张表的**规模差**必须是零。多一种对不上的
	 * (比如哪天把下播词云拆成独立 kind 却忘了给它指一把键),上面两条仍可能都绿 ——
	 * 因为它只要指到任意一把存在的键就行。
	 */
	it("每一种推送类型都是某把键正着翻出来的:周期「正在直播」归 liveStreaming,不再并回 liveStart", () => {
		const forward = new Set(FEATURE_KEYS.map(featureToPushKind));
		const extra = PushKindSchema.options.filter((k) => !forward.has(k));
		expect(extra).toEqual([]);
		expect(featureToPushKind("liveStreaming")).toBe("live-ongoing");
		expect(featureToPushKind("liveStart")).toBe("live");
		expect(pushKindToFeature("live-ongoing")).toBe("liveStreaming");
		expect(pushKindToFeature("live")).toBe("liveStart");
	});
});
