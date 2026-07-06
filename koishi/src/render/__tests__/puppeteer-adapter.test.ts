/**
 * 回归守护 —— image 卫星包吸收进 core 后,puppeteer 从必需依赖降级为可选依赖。
 * 未装 puppeteer 时 `page()` 必须清晰地 reject(而不是访问 undefined 崩溃),
 * 这样下游 packages/live room-helpers/room-session 既有的 try/catch 才能接住,
 * 自然退化成纯文字;装了 puppeteer 时必须原样透传。
 */

import type { Context } from "koishi";
import { describe, expect, it, vi } from "vite-plus/test";
import { adaptPuppeteer } from "../puppeteer-adapter";

describe("adaptPuppeteer", () => {
	it("ctx.puppeteer 缺失时 page() 清晰 reject,不抛未捕获异常", async () => {
		const ctx = {} as Context;
		const adapter = adaptPuppeteer(ctx);

		await expect(adapter.page()).rejects.toThrow(/puppeteer/);
	});

	it("ctx.puppeteer 存在时透传其 page() 结果", async () => {
		const fakePage = { marker: "page" };
		const ctx = {
			puppeteer: { page: vi.fn().mockResolvedValue(fakePage) },
		} as unknown as Context;
		const adapter = adaptPuppeteer(ctx);

		await expect(adapter.page()).resolves.toBe(fakePage);
	});

	it("现取 ctx.puppeteer——puppeteer 晚装上后,下一次调用自动生效", async () => {
		const ctx = {} as Context;
		const adapter = adaptPuppeteer(ctx);

		await expect(adapter.page()).rejects.toThrow(/puppeteer/);

		const fakePage = { marker: "late" };
		// biome-ignore lint/suspicious/noExplicitAny: 测试内模拟晚注入
		(ctx as any).puppeteer = { page: vi.fn().mockResolvedValue(fakePage) };

		await expect(adapter.page()).resolves.toBe(fakePage);
	});
});
