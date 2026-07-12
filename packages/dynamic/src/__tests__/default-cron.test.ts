import { DEFAULT_DYNAMIC_CRON } from "@bilibili-notify/internal";
import { CronTime } from "cron";
import { describe, expect, it } from "vite-plus/test";

/**
 * 默认 cron 表达式的守护测试。
 *
 * 为什么值得单独一个文件:`DynamicEngine.scheduleDynamicJob` 里 `new CronJob` 解析
 * 失败是**被 catch 的** —— 只 log 一行 error,然后动态检测**静默不启动**。也就是说
 * 默认值写坏了,typecheck / build 全绿,只在用户运行期表现为「一条动态都不推」。
 * 这里用真正驱动它的那个 cron 实现(而非 `z.string()` 的空校验)把默认值钉死。
 */
describe("DEFAULT_DYNAMIC_CRON", () => {
	const nextFew = (expr: string, count: number): Date[] => {
		const time = new CronTime(expr);
		const out: Date[] = [];
		let cursor = new Date("2026-07-12T10:00:05.000Z");
		for (let i = 0; i < count; i++) {
			cursor = time.getNextDateFrom(cursor).toJSDate();
			out.push(cursor);
		}
		return out;
	};

	it("能被 CronJob 背后的 cron 实现解析", () => {
		expect(() => new CronTime(DEFAULT_DYNAMIC_CRON)).not.toThrow();
	});

	it("每 2 分钟触发一次", () => {
		const [first, second, third] = nextFew(DEFAULT_DYNAMIC_CRON, 3);
		expect(second.getTime() - first.getTime()).toBe(120_000);
		expect(third.getTime() - second.getTime()).toBe(120_000);
	});

	it("落在整分钟的第 30 秒,而不是整分", () => {
		for (const at of nextFew(DEFAULT_DYNAMIC_CRON, 3)) {
			expect(at.getUTCSeconds()).toBe(30);
		}
	});
});
