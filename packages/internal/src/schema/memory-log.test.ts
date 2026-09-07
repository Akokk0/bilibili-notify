/**
 * `app.memoryLog` —— 内存自检打印的开关(2026-09-07 主人定案:改成开关、默认关)。
 *
 * 之前它默认开着、靠环境变量 `BN_MEMORY_PROBE_SECONDS=0` 才关得掉;现在是系统页上的一个
 * Toggle。守两条:老 globals.json 缺字段照样能读(独立端启动时 parse 失败是直接挂的),
 * 补出来的默认值是 **false**。
 */

import { describe, expect, it } from "vite-plus/test";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "./globals";

describe("app.memoryLog", () => {
	it("老 globals.json 没有这个字段 → 解析成功,补成 false", () => {
		const g = makeDefaultGlobalConfig() as unknown as { app: Record<string, unknown> };
		delete g.app.memoryLog;
		const parsed = GlobalConfigSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.app.memoryLog).toBe(false);
	});

	it("全新安装默认关", () => {
		expect(makeDefaultGlobalConfig().app.memoryLog).toBe(false);
	});

	it("拨开了就保持 true", () => {
		const g = makeDefaultGlobalConfig();
		g.app.memoryLog = true;
		expect(GlobalConfigSchema.parse(g).app.memoryLog).toBe(true);
	});
});
