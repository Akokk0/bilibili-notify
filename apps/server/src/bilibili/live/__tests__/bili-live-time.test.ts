import { describe, expect, it } from "vite-plus/test";
import { biliLiveTimeToIso } from "../live-card-input";

/**
 * B 站 `live_time`(`yyyy-MM-dd HH:mm:ss`,**北京时间**、不带时区)→ ISO。
 *
 * 显式按 `+08:00` 读,与进程时区无关 —— 容器常常是 UTC,不能让开播多久随机器的时区漂。
 * 本文件在 `TZ=UTC` 与 `TZ=America/Los_Angeles` 下各跑一遍都得是绿的。
 */
describe("biliLiveTimeToIso", () => {
	it("北京时间换成 UTC 的 ISO(差 8 小时)", () => {
		expect(biliLiveTimeToIso("2026-09-13 20:00:00")).toBe("2026-09-13T12:00:00.000Z");
	});

	it("跨日:北京时间凌晨落在前一天的 UTC", () => {
		expect(biliLiveTimeToIso("2026-01-01 03:30:15")).toBe("2025-12-31T19:30:15.000Z");
	});

	it("解析不出的一律回 undefined", () => {
		expect(biliLiveTimeToIso("")).toBeUndefined();
		expect(biliLiveTimeToIso(undefined)).toBeUndefined();
		expect(biliLiveTimeToIso("0000-00-00 00:00:00")).toBeUndefined();
		expect(biliLiveTimeToIso("2026-13-45 10:00:00")).toBeUndefined();
		expect(biliLiveTimeToIso("2026-09-13T20:00:00")).toBeUndefined();
		expect(biliLiveTimeToIso("not a time")).toBeUndefined();
	});
});
