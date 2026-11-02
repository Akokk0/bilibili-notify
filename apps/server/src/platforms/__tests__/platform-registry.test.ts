import {
	PLATFORM_REGISTRY,
	platformDescriptor,
	WEBHOOK_PLATFORMS,
} from "../platform-descriptors.js";

/**
 * 平台注册表与它的两份**投影**。
 *
 * `WEBHOOK_PLATFORMS` 本该直接从注册表算出来,写成手打的元组只有一个原因:`z.enum` 要求
 * 可枚举的字面量元组,`.filter()` 出来的数组给不出那个类型。
 *
 * 代价就是它会漂 —— 注册表里加一档走 webhook 的新平台、忘了往元组里补一格,
 * 连接照样存得下、面板照样画得出,只有「它算不算 webhook 那一族」在两处说得不一样。
 * 这条用例把两边钉在一起:任何一边单独动都会红。
 *
 * (`atAll` / `inbound` 两列已经从注册表搬走,改由适配器回答,见服务端的 adapter-capabilities 测试。)
 */

import { PlatformSnapshotSchema } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { builtinCandidatesFor } from "../builtin-candidates.js";

const templatePlatforms = Object.keys(PLATFORM_REGISTRY) as Array<keyof typeof PLATFORM_REGISTRY>;
const platformsWhere = (pick: (p: (typeof templatePlatforms)[number]) => boolean) =>
	templatePlatforms.filter(pick).sort();

it("列候选时读取当前语言，既有快照不随下一次读取改变", () => {
	const state = i18n.state();
	i18n.set({ locale: "zh-CN", voice: "plain" });
	const before = builtinCandidatesFor("qq-official")[0];
	expect(before?.platform.label).toBe("QQ 官方机器人");
	i18n.set({ locale: "en" });
	const translate = vi
		.spyOn(i18n.state(), "t")
		.mockImplementation((key) =>
			key === "platforms.candidates.qq.label"
				? "Official bot"
				: key === "platforms.candidates.qq.group"
					? "Group identifier"
					: String(key),
		);
	try {
		const after = builtinCandidatesFor("qq-official")[0];
		expect(after?.name).toBe("Official bot");
		expect(after?.platform.addressNouns.group).toBe("Group identifier");
		expect(before?.platform.label).toBe("QQ 官方机器人");
	} finally {
		translate.mockRestore();
		i18n.set({ locale: state.locale, voice: state.voice });
	}
});

describe("注册表的投影", () => {
	it("WEBHOOK_PLATFORMS 就是注册表里默认走 webhook 连的那些", () => {
		expect([...WEBHOOK_PLATFORMS].sort()).toEqual(
			platformsWhere((p) => PLATFORM_REGISTRY[p].adapterKey === "webhook"),
		);
	});
});

describe("注册表自身", () => {
	it("每个平台都有适配器键,且只有三个内置键", () => {
		// `adapterKey` 是「谁来处理这个平台的连接」的答案;空串或拼错都会让连接落不到任何适配器。
		for (const p of templatePlatforms) {
			expect(["onebot", "qq-official", "webhook"]).toContain(PLATFORM_REGISTRY[p].adapterKey);
		}
	});

	it("每一行去掉 adapterKey 之后就是一份合法的平台快照", () => {
		for (const p of templatePlatforms) {
			const { adapterKey: _adapterKey, ...snapshot } = PLATFORM_REGISTRY[p];
			expect(PlatformSnapshotSchema.safeParse(snapshot).success, p).toBe(true);
		}
	});

	it("会话目标的平台要给得出会话种类,单向终点的只有一档", () => {
		for (const p of templatePlatforms) {
			const { targetKind, scopes } = PLATFORM_REGISTRY[p];
			expect(scopes.length).toBeGreaterThan(0);
			if (targetKind === "endpoint") expect(scopes.length).toBe(1);
		}
	});
});

describe("平台注册表的 adapterKey —— 这个平台归哪个适配器管", () => {
	const cases: ReadonlyArray<readonly [string, string]> = [
		["onebot", "onebot"],
		["qq-official", "qq-official"],
		["feishu", "webhook"],
		["dingtalk", "webhook"],
		["wecom", "webhook"],
		["generic", "webhook"],
	];

	it.each(cases)("平台 %s → %s", (platform, key) => {
		expect(platformDescriptor(platform)?.adapterKey).toBe(key);
	});

	it("六个模板平台一个不漏", () => {
		expect(cases.map(([platform]) => platform).sort()).toEqual(
			Object.keys(PLATFORM_REGISTRY).sort(),
		);
	});

	it("认不出的平台没有适配器键", () => {
		expect(platformDescriptor("telegram")).toBeUndefined();
	});
});
