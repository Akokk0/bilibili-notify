/**
 * 单元测试 — koishi/dynamic 的 SubItemView 折算(sub-view.ts)。
 *
 * 核心不变量:
 *   - resolveDynamicFeature 走「per-UP override ?? DEFAULT_FEATURE_FLAGS.dynamic」
 *     两层折叠,与 koishi/live 同模式;per-UP 的 false 不被默认 true 吃掉
 *     (live 端 restartPush bug 同源,这里前置守卫)。
 *   - subToDynamicView 把 cardStyle override 折成 customCardStyle 启停结构,
 *     未覆盖时 enable:false,与 dynamic-service 旧实现行为对齐。
 *   - storeToDynamicView 跳过 enabled=false 的订阅。
 */

import {
	DEFAULT_FEATURE_FLAGS,
	makeEmptySubscription,
	type Subscription,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { resolveDynamicFeature, storeToDynamicView, subToDynamicView } from "../sub-view";

function makeSub(overrides: Subscription["overrides"] = {}): Subscription {
	const sub = makeEmptySubscription({ id: "00000000-0000-4000-8000-000000000000", uid: "123" });
	sub.overrides = overrides;
	return sub;
}

describe("resolveDynamicFeature", () => {
	it("无 per-UP override → 走 DEFAULT_FEATURE_FLAGS.dynamic", () => {
		expect(resolveDynamicFeature(makeSub())).toBe(DEFAULT_FEATURE_FLAGS.dynamic);
	});

	it("per-UP features.dynamic=true → 返回 true", () => {
		expect(resolveDynamicFeature(makeSub({ features: { dynamic: true } }))).toBe(true);
	});

	it("per-UP features.dynamic=false → 返回 false(不被默认真值吃掉)", () => {
		// 关键回归守卫:`??` 作用在原始 override 上,false 是显式值,应保留。
		expect(resolveDynamicFeature(makeSub({ features: { dynamic: false } }))).toBe(false);
	});

	it("per-UP features 存在但未声明 dynamic → 仍走 DEFAULT", () => {
		expect(resolveDynamicFeature(makeSub({ features: { live: false } }))).toBe(
			DEFAULT_FEATURE_FLAGS.dynamic,
		);
	});
});

describe("subToDynamicView", () => {
	it("无 cardStyle override → customCardStyle.enable:false", () => {
		const view = subToDynamicView(makeSub());
		expect(view.uid).toBe("123");
		expect(view.uname).toBe("123");
		expect(view.dynamic).toBe(DEFAULT_FEATURE_FLAGS.dynamic);
		expect(view.customCardStyle).toEqual({ enable: false });
	});

	it("有 cardStyle override → customCardStyle.enable:true 并带颜色", () => {
		const view = subToDynamicView(
			makeSub({ cardStyle: { cardColorStart: "#abc", cardColorEnd: "#def" } }),
		);
		expect(view.customCardStyle).toEqual({
			enable: true,
			cardColorStart: "#abc",
			cardColorEnd: "#def",
		});
	});

	it("partial cardStyle(只给 cardColorStart)→ customCardStyle.cardColorEnd 为 undefined", () => {
		// CardStylePartial 允许任一字段缺省;subToDynamicView 不强制完整。
		// 下游 dynamic-engine 把 cardColorEnd 当 optional 消费,不破坏类型。
		const view = subToDynamicView(makeSub({ cardStyle: { cardColorStart: "#abc" } }));
		expect(view.customCardStyle).toEqual({
			enable: true,
			cardColorStart: "#abc",
			cardColorEnd: undefined,
		});
	});

	it("per-UP features.dynamic=false 同时传入 cardStyle → dynamic 取 false,customCardStyle 仍 enable", () => {
		const view = subToDynamicView(
			makeSub({
				features: { dynamic: false },
				cardStyle: { cardColorStart: "#111", cardColorEnd: "#222" },
			}),
		);
		expect(view.dynamic).toBe(false);
		expect(view.customCardStyle).toEqual({
			enable: true,
			cardColorStart: "#111",
			cardColorEnd: "#222",
		});
	});
});

describe("storeToDynamicView", () => {
	it("跳过 enabled=false 的订阅", () => {
		const a = makeSub();
		a.uid = "1";
		const b = makeSub();
		b.uid = "2";
		b.enabled = false;
		const view = storeToDynamicView({ list: () => [a, b] });
		expect(Object.keys(view)).toEqual(["1"]);
		expect(view["1"].uid).toBe("1");
	});
});
