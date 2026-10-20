/**
 * **真装配里,问题表建了、挂在运行时上,变了会在总线上发 `problems-changed`**(接线守卫)。
 *
 * 表自己的测试用的是替身 `onChanged`,证明不了 `bootstrap.ts` 里把它接到总线上:接漏了的症状是面板的问题框永远不刷新,
 * 而类型、单元测试全绿。所以这里走真的 `createAppRuntime`:报一条,等合并窗口过去,总线上收到 {@link PROBLEMS_CHANGED_COALESCE_MS}
 * 之后那一声,载荷只有报的人。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { settingsSegment } from "../../bilibili/settings.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { i18n } from "../../i18n/index.js";
import { PROBLEMS_CHANGED_COALESCE_MS } from "../../problems/problem-table.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";

let dataDir: string;
let runtime: AppRuntime;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-problems-wiring-"));
	runtime = createAppRuntime(
		BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }),
		{
			dataRoot: dataDir,
		},
		{ integrationSettings: [settingsSegment] },
	);
});
afterEach(async () => {
	i18n.set({ locale: "zh-CN", voice: "maid" });
	vi.useRealTimers();
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

describe("createAppRuntime 里的问题表", () => {
	// 验红:删掉 bootstrap.ts 里 `onChanged: … bus.emit("problems-changed", …)` 那一行,这条红。
	it("报一条问题:合并窗口过后总线上发一声 problems-changed,只带报的人", () => {
		vi.useFakeTimers();
		const seen: Array<{ reporter: string }> = [];
		runtime.bus.on("problems-changed", (change) => seen.push(change));

		runtime.problems.report({ reporter: "bilibili", code: "auth_lost", message: "登录失效" });
		runtime.problems.report({ reporter: "bilibili", code: "other", message: "又一条" });
		expect(seen).toEqual([]);

		vi.advanceTimersByTime(PROBLEMS_CHANGED_COALESCE_MS);
		expect(seen).toEqual([{ reporter: "bilibili" }]);
		expect(runtime.problems.list()).toHaveLength(2);
	});

	// 验红:剪掉 bootstrap.ts 里 `texts: { … }` 那一格,这条红。
	it("报一条读当前语言的取字函数:换语言之后表里当场是新语言的话", () => {
		i18n.set({ locale: "zh-CN", voice: "maid" });
		runtime.problems.report({
			reporter: "host",
			code: "locale_probe",
			message: () => `now:${i18n.state().locale}`,
		});
		expect(runtime.problems.list().map((p) => p.message)).toEqual(["now:zh-CN"]);

		i18n.set({ locale: "ja" });

		expect(runtime.problems.list().map((p) => p.message)).toEqual(["now:ja"]);
	});
});
