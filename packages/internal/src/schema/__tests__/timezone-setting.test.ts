/**
 * 核心设置的 `timezone` 一格(ADR-0021 决策 43):老配置缺了由默认补,合法值原样留,
 * 不认的写法过不了。期望值写死成 IANA 名与那句报错,不照实现再算。
 */

import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_TIMEZONE } from "../../timezone";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";

const withSettings = (extra: Record<string, unknown>) => ({
	...(makeDefaultGlobalConfig() as unknown as Record<string, unknown>),
	...extra,
});

describe("timezone 在核心设置里", () => {
	it("老 core.json 没有这一格 → 解析后是 Asia/Shanghai", () => {
		const old = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete old.timezone;
		const parsed = GlobalConfigSchema.safeParse(old);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.timezone).toBe("Asia/Shanghai");
	});

	it("全新安装的出厂设置里就是 Asia/Shanghai", () => {
		expect(makeDefaultGlobalConfig().timezone).toBe("Asia/Shanghai");
		expect(DEFAULT_TIMEZONE).toBe("Asia/Shanghai");
	});

	it("合法值原样保留", () => {
		expect(GlobalConfigSchema.parse(withSettings({ timezone: "America/New_York" })).timezone).toBe(
			"America/New_York",
		);
	});

	it("不认得的时区过不了,报错说清要写什么", () => {
		const parsed = GlobalConfigSchema.safeParse(withSettings({ timezone: "Mars/Base" }));
		expect(parsed.success).toBe(false);
		const issue = parsed.error?.issues.find((candidate) => candidate.path[0] === "timezone");
		expect(issue?.message).toBe("不是认得的时区名，要写 IANA 名，比如 Asia/Shanghai");
	});
});
