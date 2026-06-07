import { describe, expect, it } from "vitest";
import { ApiError, errorDetails, resolveApiBase } from "./client";

describe("resolveApiBase", () => {
	it("uses the AstrBot plugin API prefix when the page is served under the plugin path", () => {
		expect(
			resolveApiBase({
				locationPathname: "/astrbot_plugin_bilibili_notify/pages/dashboard/index.html",
			}),
		).toBe("/astrbot_plugin_bilibili_notify/api");
	});

	it("uses /api during local Vite development", () => {
		expect(resolveApiBase({ locationPathname: "/" })).toBe("/api");
	});

	it("detects the AstrBot plugin API prefix from the bundled script path", () => {
		expect(
			resolveApiBase({
				locationPathname: "/",
				currentScriptSrc: "/astrbot_plugin_bilibili_notify/pages/dashboard/assets/index.js",
			}),
		).toBe("/astrbot_plugin_bilibili_notify/api");
	});
});

describe("errorDetails", () => {
	it("summarizes validation issues from ApiError bodies", () => {
		const details = errorDetails(
			new ApiError(
				400,
				{ message: "配置不合法", issues: [{ path: ["defaults", "ai"], message: "bad" }] },
				"bad request",
			),
		);
		expect(details.summary).toBe("配置不合法");
		expect(details.detail).toContain("defaults.ai: bad");
	});
});
