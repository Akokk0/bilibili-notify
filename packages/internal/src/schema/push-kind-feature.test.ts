/**
 * **推送类型 ↔ 特性键,两头对表。**
 *
 * 一条历史行记的是 `PushKind`(8 种),而路由、闸、订阅里的开关认的是 `FeatureKey`
 * (7 把)—— 人工重推要复检「这个目标还在不在这条路由里」,就得从行上那个 kind 翻回
 * 那把键。多出来的那一种是 `live-ongoing`:开播与周期「正在直播」在历史上是两件事,
 * 在配置上却共用 `live` 那一把键和同一份目标。
 *
 * 这一份钉的是**两个方向对得上**,不是复述任何一张表:
 *
 * - 每一把 `FeatureKey` 正着翻成 `PushKind` 再翻回来,必须还是它自己;
 * - 每一种 `PushKind` 都翻得出一把**真实存在**的键,一种都不能漏。
 *
 * 将来加第 8 把特性键、或者再拆一种推送类型出来,漏改任何一边这里都会红。
 */

import { describe, expect, it } from "vite-plus/test";
import { FEATURE_KEYS } from "../constants.js";
import { featureToPushKind, PushKindSchema, pushKindToFeature } from "./history.js";

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
	 * 比「都对得上」更进一步:两张表的**规模差**必须恰好是那一种。多一种对不上的
	 * (比如哪天把下播词云拆成独立 kind 却忘了给它指一把键),上面两条仍可能都绿 ——
	 * 因为它只要指到任意一把存在的键就行。
	 */
	it("只有 live-ongoing 不是任何一把键正着翻出来的那个", () => {
		const forward = new Set(FEATURE_KEYS.map(featureToPushKind));
		const extra = PushKindSchema.options.filter((k) => !forward.has(k));
		expect(extra).toEqual(["live-ongoing"]);
		// 而它跟开播归同一把键 —— 配置上它们本来就共用一份开关和一份目标。
		expect(pushKindToFeature("live-ongoing")).toBe("live");
		expect(pushKindToFeature("live")).toBe("live");
	});
});
