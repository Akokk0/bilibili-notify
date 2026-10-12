/**
 * **运行时上的大航海徽章图是晚填的**(接线守卫;3a-33,造的地方 3a-40 起在组装根 `compose.ts`)。
 *
 * 徽章图由 `compose.ts` 造好、登记成图库的「来源声明的图」,再经 `attachGuardIcons` 交给运行时;抓图、
 * 名单、清扫那几条在 `__tests__/compose.test.ts`「大航海徽章图」里钉。这里只钉运行时这一头:
 * 交进来之前读 `runtime.guardIcons` 要响亮地抛(装配次序的 bug),交进来之后读到的就是那一份。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { GuardIcons } from "../../bilibili/live/guard-icons.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";

let dataDir: string;
let runtime: AppRuntime | undefined;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-guard-icons-wiring-"));
	runtime = createAppRuntime(
		BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }),
		{ dataRoot: dataDir },
		{ integrationSettings: [] },
	);
});
afterEach(async () => {
	await runtime?.dispose();
	runtime = undefined;
	await rm(dataDir, { recursive: true, force: true });
});

describe("AppRuntime.guardIcons 晚填", () => {
	// 验红:把 `bootstrap.ts` 里 `get guardIcons()` 的抛删掉(没填也往外交),这条红。
	it("attachGuardIcons 之前读它会抛", () => {
		expect(() => runtime?.guardIcons).toThrow("attachGuardIcons");
	});

	// 验红:`attachGuardIcons` 不记下交进来的那一份,这条红。
	it("attachGuardIcons 之后读到的就是交进来的那一份", () => {
		const icons: GuardIcons = { ensure: async () => {}, iconOf: () => undefined, refs: () => [] };
		runtime?.attachGuardIcons(icons);
		expect(runtime?.guardIcons).toBe(icons);
	});
});
