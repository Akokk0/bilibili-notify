import { describe, expect, it } from "vite-plus/test";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";

describe("core settings validation rejects invalid values at stable paths", () => {
	it.each([
		[{ logging: { levels: { constructor: "info" } } }, ["logging", "levels", "constructor"]],
		[{ update: { mirrors: ["http://mirror.invalid"] } }, ["update", "mirrors", 0]],
		[
			{ marketplace: { sources: [{ id: "test", url: "http://market.invalid" }] } },
			["marketplace", "sources", 0, "url"],
		],
		[{ timezone: "not-a-timezone" }, ["timezone"]],
	])("rejects invalid settings at the same path: %j", (patch, path) => {
		const result = GlobalConfigSchema.safeParse({ ...makeDefaultGlobalConfig(), ...patch });
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues[0]?.path).toEqual(path);
		expect(result.error.issues[0]?.message).not.toBe("");
	});
});
