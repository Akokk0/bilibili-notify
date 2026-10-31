import { type ConfigScope, makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { expect, it } from "vite-plus/test";
import { timezoneReaderOf } from "../timezone-reader.js";

it("共同读源现读,只通知真变的globals,每份订阅独立去重并可回收", () => {
	const globals = makeDefaultGlobalConfig();
	globals.timezone = "UTC";
	const listeners = new Set<(scope: ConfigScope) => void>();
	const reader = timezoneReaderOf({
		getGlobals: () => globals,
		onChange(fn) {
			listeners.add(fn);
			return { dispose: () => void listeners.delete(fn) };
		},
	});
	const emit = (scope: ConfigScope) => {
		for (const fn of listeners) fn(scope);
	};
	expect(reader.timezone()).toBe("UTC");
	const first: string[] = [];
	const claim = reader.onTimezoneChanged(() => first.push(reader.timezone()));
	expect(first).toEqual([]);
	globals.timezone = "Asia/Kathmandu";
	expect(reader.timezone()).toBe("Asia/Kathmandu");
	emit("integration-settings");
	expect(first).toEqual([]);
	emit("globals");
	emit("globals");
	expect(first).toEqual(["Asia/Kathmandu"]);
	const second: string[] = [];
	const other = reader.onTimezoneChanged(() => second.push(reader.timezone()));
	globals.timezone = "UTC";
	emit("globals");
	expect(first).toEqual(["Asia/Kathmandu", "UTC"]);
	expect(second).toEqual(["UTC"]);
	claim.dispose();
	claim.dispose();
	globals.timezone = "Asia/Shanghai";
	emit("globals");
	expect(first).toEqual(["Asia/Kathmandu", "UTC"]);
	expect(second).toEqual(["UTC", "Asia/Shanghai"]);
	other.dispose();
	expect(listeners.size).toBe(0);
});
