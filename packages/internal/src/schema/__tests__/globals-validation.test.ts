import { describe, expect, it } from "vite-plus/test";
import { GlobalSettingsSchema, makeDefaultGlobalSettings } from "../globals";

describe("core settings validation rejects invalid values at stable paths", () => {
	it("图片放行范围默认关闭,接受 IPv4/IPv6 CIDR 并拒绝非法范围", () => {
		expect(makeDefaultGlobalSettings().network).toEqual({ imageAllowedCidrs: [] });
		const base = makeDefaultGlobalSettings();
		expect(
			GlobalSettingsSchema.parse({
				...base,
				network: { imageAllowedCidrs: ["198.18.0.0/16", "fd00::/8"] },
			}).network.imageAllowedCidrs,
		).toEqual(["198.18.0.0/16", "fd00::/8"]);
		const invalid = GlobalSettingsSchema.safeParse({
			...base,
			network: { imageAllowedCidrs: ["127.0.0.1/99"] },
		});
		expect(invalid.success).toBe(false);
		if (!invalid.success)
			expect(invalid.error.issues[0]?.path).toEqual(["network", "imageAllowedCidrs", 0]);
	});
	it.each([
		[{ logging: { levels: { constructor: "info" } } }, ["logging", "levels", "constructor"]],
		[{ update: { mirrors: ["http://mirror.invalid"] } }, ["update", "mirrors", 0]],
		[
			{ marketplace: { sources: [{ id: "test", url: "http://market.invalid" }] } },
			["marketplace", "sources", 0, "url"],
		],
		[{ timezone: "not-a-timezone" }, ["timezone"]],
	])("rejects invalid settings at the same path: %j", (patch, path) => {
		const result = GlobalSettingsSchema.safeParse({ ...makeDefaultGlobalSettings(), ...patch });
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues[0]?.path).toEqual(path);
		expect(result.error.issues[0]?.message).not.toBe("");
	});
});
