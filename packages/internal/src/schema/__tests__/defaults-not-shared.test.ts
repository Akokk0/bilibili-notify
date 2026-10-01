/**
 * 每次解析、每次调工厂拿到的配置都得是独立的一份:两份之间不许共用任何对象 / 数组 / Map / Set。
 *
 * zod 4 的 `.default(值)` 只浅拷贝一层,默认值里嵌着的对象和数组会被之后每一次解析共用;
 * `{ ...DEFAULT_X }` 同理。谁原地改了其中一份(测试夹具就这么干过:改了一条的联网搜索开关,
 * 下一条用例拿到的「出厂配置」里它已经开着),出厂常量和之后解析出来的每一份都跟着变。
 * 所以带嵌套的默认值一律写成工厂 `.default(() => …)`。
 *
 * 这里不点名哪几条路径:整棵树并排走一遍,哪里共用了就报哪里 —— 以后新加的默认值同样拦得住。
 */

import { describe, expect, it } from "vite-plus/test";
import { FEATURE_KEYS } from "../../constants";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";
import { makeEmptySubscription, SubscriptionSchema } from "../subscriptions";

/** 值里能被原地改的容器,连同它在树里的路径。 */
function containers(value: unknown, path = "$", out = new Map<object, string>()) {
	if (typeof value !== "object" || value === null || out.has(value)) return out;
	out.set(value, path);
	if (value instanceof Map) {
		for (const [k, v] of value) containers(v, `${path}.get(${String(k)})`, out);
	} else if (value instanceof Set) {
		for (const v of value) containers(v, `${path}.<item>`, out);
	} else {
		for (const [k, v] of Object.entries(value)) containers(v, `${path}.${k}`, out);
	}
	return out;
}

/** b 里那些同一个引用也出现在 a 里的容器,按 b 里的路径列出来。 */
function sharedPaths(a: unknown, b: unknown): string[] {
	const inA = containers(a);
	return [...containers(b)].filter(([ref]) => inA.has(ref)).map(([, path]) => path);
}

const emptyRouting = () => Object.fromEntries(FEATURE_KEYS.map((k) => [k, [] as string[]]));

/** 盘上一条订阅的最小形状:带默认值的键(groups / extras / roastSchedule / specialUsers)都缺着。 */
const diskRow = (identity: { sourceKey: string; externalId: string }) => ({
	id: "11111111-1111-4111-8111-111111111111",
	identity,
	enabled: true,
	routing: emptyRouting(),
	overrides: {},
});

describe("出厂配置与解析结果不共用可变容器", () => {
	it("makeDefaultGlobalConfig 两次", () => {
		expect(sharedPaths(makeDefaultGlobalConfig(), makeDefaultGlobalConfig())).toEqual([]);
	});

	it("只有必填段的 globals.json 解析两次(其余段全走 schema 的默认值)", () => {
		const onlyRequired = () => {
			const { features, filters, schedule, templates, ai, cardStyle } =
				makeDefaultGlobalConfig().defaults;
			return {
				app: {},
				master: {},
				defaults: { features, filters, schedule, templates, ai, cardStyle },
			};
		};
		const a = GlobalConfigSchema.parse(onlyRequired());
		const b = GlobalConfigSchema.parse(onlyRequired());
		expect(sharedPaths(a, b)).toEqual([]);
	});

	it("makeEmptySubscription 两次", () => {
		const opts = {
			id: "11111111-1111-4111-8111-111111111111",
			identity: { sourceKey: "bilibili", externalId: "12345" },
		};
		expect(sharedPaths(makeEmptySubscription(opts), makeEmptySubscription(opts))).toEqual([]);
	});

	it.each([
		["B 站", { sourceKey: "bilibili", externalId: "12345" }],
		["拓展", { sourceKey: "douyin", externalId: "MS4wLjABAAAA-sec_uid" }],
	])("缺默认键的%s订阅解析两次", (_label, identity) => {
		const a = SubscriptionSchema.parse(diskRow(identity));
		const b = SubscriptionSchema.parse(diskRow(identity));
		expect(sharedPaths(a, b)).toEqual([]);
	});
});
