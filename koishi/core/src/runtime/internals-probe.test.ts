import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { buildInternalsProbe, CORE_INTERNALS_PROTOCOL } from "./internals-probe";

type ProbeArgs = Parameters<typeof buildInternalsProbe>[0];

// 四件套用空对象占位 —— probe 只做 truthy 判定，不触碰实例方法。
const ready = {
	token: BILIBILI_NOTIFY_TOKEN,
	api: {},
	push: {},
	store: {},
	registry: {},
} as unknown as ProbeArgs;

function reasonOf(args: ProbeArgs): string {
	const probe = buildInternalsProbe(args);
	if (probe.ok) throw new Error("expected probe to be unavailable");
	return probe.reason;
}

describe("buildInternalsProbe", () => {
	it("四件套齐全且 token 正确 → ok，并回传 core protocol 与各实例", () => {
		const probe = buildInternalsProbe(ready);
		expect(probe.ok).toBe(true);
		if (!probe.ok) throw new Error("unreachable");
		expect(probe.internals.protocol).toBe(CORE_INTERNALS_PROTOCOL);
		expect(probe.internals.protocol.name).toBe("@bilibili-notify/koishi-internals");
		expect(probe.internals.protocol.version).toBe(1);
		expect(probe.internals.api).toBe(ready.api);
		expect(probe.internals.registry).toBe(ready.registry);
	});

	it("token 不匹配优先于四件套缺失 → reason token-mismatch", () => {
		// 同时缺 api/store，但 token 错应先短路
		expect(reasonOf({ ...ready, token: Symbol("other"), api: null, store: null })).toBe(
			"token-mismatch",
		);
	});

	it("按 api → push → store → registry 顺序短路报缺失项", () => {
		expect(reasonOf({ ...ready, api: null, store: null })).toBe("api");
		expect(reasonOf({ ...ready, push: null, registry: null })).toBe("push");
		expect(reasonOf({ ...ready, store: null })).toBe("store");
		expect(reasonOf({ ...ready, registry: null })).toBe("registry");
	});

	it("不可用时仍回传 core protocol 供诊断文案使用", () => {
		const probe = buildInternalsProbe({ ...ready, api: null });
		expect(probe.protocol).toBe(CORE_INTERNALS_PROTOCOL);
	});
});
