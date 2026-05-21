import { describe, expect, it } from "vitest";
import { resolveAppVersion } from "../health.js";

describe("resolveAppVersion", () => {
	it("APP_VERSION 已设置时原样返回", () => {
		expect(resolveAppVersion({ APP_VERSION: "v1.2.3" })).toBe("v1.2.3");
		expect(resolveAppVersion({ APP_VERSION: "dev-a331704" })).toBe("dev-a331704");
	});

	it("APP_VERSION 未设置时回退 dev", () => {
		expect(resolveAppVersion({})).toBe("dev");
	});

	it("APP_VERSION 为空串时回退 dev", () => {
		expect(resolveAppVersion({ APP_VERSION: "" })).toBe("dev");
	});
});
