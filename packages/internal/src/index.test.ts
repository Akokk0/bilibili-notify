import { describe, expect, it } from "vitest";
import { BILIBILI_NOTIFY_TOKEN } from "./index";

describe("BILIBILI_NOTIFY_TOKEN", () => {
	it("使用进程全局 Symbol,避免 duplicated internal 包 identity 不一致", () => {
		const key = "@bilibili-notify/internal/BILIBILI_NOTIFY_TOKEN/v1";

		expect(BILIBILI_NOTIFY_TOKEN).toBe(Symbol.for(key));
		expect(Symbol.keyFor(BILIBILI_NOTIFY_TOKEN)).toBe(key);
	});
});
