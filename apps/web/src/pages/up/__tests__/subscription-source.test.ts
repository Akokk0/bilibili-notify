/**
 * 订阅源拓展在订阅页上的样子(ADR-0019 决策 4 / 5 / 10 / 41)。
 *
 * - 名字、短名、颜色、叫法、特性都取来源表(`/api/sources`)里的描述符;特性顺序跟 FEATURE_KEYS 走,
 *   不跟清单里写的顺序走。
 * - 平台选择列在册的全部来源(来源表里带 `has` 的那些,B 站也在其中);停着的拓展来源表里照列、不带 `has`。
 * - 拓展列表没回来时不下「没开」的结论;没装时拿不到名字就写拓展 id。
 */

import type { SourceEntry } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { registeredSources, subscriptionPlatformOf } from "../subscription-source";

function entry(over: Partial<SourceEntry["descriptor"]> = {}, key = "douyin"): SourceEntry {
	return {
		status: "running",
		key,
		descriptor: {
			label: "抖音",
			shortLabel: "抖",
			color: "#161823",
			postNoun: "作品",
			supportedFeatures: ["post", "liveStart"],
			...over,
		},
	};
}

/** `subscriptionPlatformOf` 只看订阅记在哪个拓展名下,手里只要拓展 id。 */
function sub(sourceKey = "douyin"): { sourceKey: string } {
	return { sourceKey };
}

describe("平台选择那一排", () => {
	it("列在册的全部来源(带 has 的),先后照来源表;停着的拓展(不带 has)不列", () => {
		const has = { auth: false, liveStatus: false, preview: false };
		const sources = [
			{ ...entry({ label: "B 站" }, "bilibili"), has },
			{ ...entry(), has },
			entry({ label: "停着的" }, "stopped"),
		];
		expect(registeredSources(sources).map((e) => e.key)).toEqual(["bilibili", "douyin"]);
	});

	it("来源表还没回来 → 一个都不列", () => {
		expect(registeredSources(undefined)).toEqual([]);
	});
});

describe("一条拓展订阅的平台", () => {
	it("内置来源也只看来源表判断运行态,不需要拓展记录", () => {
		const p = subscriptionPlatformOf({ sourceKey: "native" }, [entry({}, "native")]);
		expect(p).toMatchObject({ label: "抖音", absent: false, status: "running" });
	});

	it("单一已安装来源不画冗余徽章,未知与遗留身份保守显示", () => {
		expect(subscriptionPlatformOf(sub(), [entry()]).showBadge).toBe(false);
		expect(subscriptionPlatformOf(sub(), [entry(), entry({}, "second")]).showBadge).toBe(true);
		expect(subscriptionPlatformOf(sub(), undefined).showBadge).toBe(true);
		expect(subscriptionPlatformOf(sub(), []).showBadge).toBe(true);
	});

	it("在跑:外观照描述符,只列它声明的特性", () => {
		const p = subscriptionPlatformOf(sub(), [entry()]);
		expect(p).toMatchObject({
			label: "抖音",
			shortLabel: "抖",
			color: "#161823",
			postNoun: "作品",
			absent: false,
		});
		expect(p.features).toEqual(["post", "liveStart"]);
	});

	it("描述符声明了 liveStreaming:这个平台多一把「正在直播」;没声明的不多", () => {
		const both = subscriptionPlatformOf(sub(), [
			entry({ supportedFeatures: ["post", "liveStart", "liveStreaming", "liveEnd"] }),
		]);
		expect(both.features).toEqual(["post", "liveStart", "liveStreaming", "liveEnd"]);
		expect(subscriptionPlatformOf(sub(), [entry()]).features).not.toContain("liveStreaming");
	});

	it("特性顺序跟 FEATURE_KEYS 走,不跟描述符里写的顺序走", () => {
		const p = subscriptionPlatformOf(sub(), [
			entry({ supportedFeatures: ["liveEnd", "post", "liveStart"] }),
		]);
		expect(p.features).toEqual(["post", "liveStart", "liveEnd"]);
	});

	it("描述符没给 shortLabel / color:照样画得出,徽章退回 label 与认不出那档灰", () => {
		const p = subscriptionPlatformOf(sub(), [
			{
				key: "douyin",
				status: "running",
				descriptor: { label: "抖音", supportedFeatures: ["post"] },
			},
		]);
		expect(p.label).toBe("抖音");
		expect(p.shortLabel).toBeUndefined();
		expect(p.color).toBeUndefined();
	});

	it("停着:外观照样有(决策 41),但算不在场", () => {
		const p = subscriptionPlatformOf(sub(), [{ ...entry(), status: "disabled" }]);
		expect(p.label).toBe("抖音");
		expect(p.absent).toBe(false);
		expect(p.status).toBe("disabled");
	});

	it("没装:按来源键显示且不编造特性", () => {
		const p = subscriptionPlatformOf(sub("douyin"), []);
		expect(p.label).toBe("douyin");
		expect(p.absent).toBe(true);
		expect(p.features).toEqual([]);
	});

	it("装着但来源表里没有它(清单读不了):退回拓展的名字", () => {
		const p = subscriptionPlatformOf(sub(), []);
		expect(p.label).toBe("douyin");
		expect(p.absent).toBe(true);
	});

	it("两张表都没回来:不下结论", () => {
		const p = subscriptionPlatformOf(sub(), undefined);
		expect(p.absent).toBeUndefined();
		expect(p.label).toBe("douyin");
	});
});
