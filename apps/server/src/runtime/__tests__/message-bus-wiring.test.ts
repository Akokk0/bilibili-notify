/**
 * **真装配里,总线上异步监听者的 reject 经 logger 写出,过入口打码、进日志钩子**(接线守卫)。
 *
 * 接线剪断(总线造出来没接 `onHandlerError`)的症状是静默的:监听者出错退回 `console.error`,
 * 单测里总线本身全绿,只有面板日志页 / 归档里看不到这条。所以这里走真的 `createAppRuntime`:
 * 异步监听者 reject(错误里带 `SESSDATA=…`)后,`setLogHook` 收到一条 error 条目,里头没有明文。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { settingsSegment } from "../../bilibili/settings.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import type { LogEntry } from "../../ws/types.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";

let dataDir: string;
let runtime: AppRuntime;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-bus-wiring-"));
	runtime = createAppRuntime(
		BootstrapConfigSchema.parse({ dataDir, logLevel: "error" }),
		{ dataRoot: dataDir },
		{ integrationSettings: [settingsSegment] },
	);
});
afterEach(async () => {
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

describe("createAppRuntime 里的总线", () => {
	it("异步监听者 reject:经 logger 写出一条 error,钩子里的是打过码的", async () => {
		const seen: LogEntry[] = [];
		runtime.serviceCtx.setLogHook((e) => seen.push(e));
		runtime.bus.on("ready", (async () => {
			throw new Error("boom Bearer zzzzzzzz9");
		}) as unknown as () => void);

		runtime.bus.emit("ready");
		await new Promise((resolve) => setTimeout(resolve, 10));

		const entry = seen.find((e) => e.msg.includes("async handler"));
		expect(entry?.level).toBe("error");
		const text = JSON.stringify(entry);
		expect(text).toContain("boom Bearer ***");
		expect(text).not.toContain("zzzzzzzz9");
	});
});
