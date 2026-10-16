import { describe, expect, it } from "vite-plus/test";
import { neutralPlatformDescriptor } from "../platform-descriptor";
import { neutralPlatformSnapshot } from "../schema/targets";

describe("neutralPlatformDescriptor", () => {
	it("中性描述:platform 原样,其余与 neutralPlatformSnapshot 逐格相等", () => {
		expect(neutralPlatformDescriptor("telegram")).toEqual({
			platform: "telegram",
			label: "telegram",
			shortLabel: "telegram",
			color: "#94a3b8",
			targetKind: "session",
			scopes: ["group", "private", "channel"],
			addressNouns: {},
		});
		for (const platform of ["telegram", "onebot", "x"]) {
			const { platform: kept, ...rest } = neutralPlatformDescriptor(platform);
			expect(kept).toBe(platform);
			expect(rest).toEqual(neutralPlatformSnapshot(platform));
		}
	});

	it("每次造一份新的 —— 改一份不连累下一份", () => {
		const a = neutralPlatformDescriptor("telegram");
		a.scopes.push("private");
		expect(neutralPlatformDescriptor("telegram").scopes).toEqual(["group", "private", "channel"]);
	});
});
