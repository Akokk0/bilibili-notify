import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { settingsSegment } from "../bilibili/settings.js";
import type { BootstrapConfig } from "../config/schema.js";
import { CORE_SETTINGS_FILE } from "../config/store.js";
import { i18n } from "../i18n/index.js";
import type { ProblemChange } from "../problems/problem-table.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

// ---------------------------------------------------------------------------
// 接线:配置仓的「坏格表变了」通知要真的接到问题表上。把 `bootstrap.ts` 里那一格接线剪断,这里必红。
// ---------------------------------------------------------------------------

describe("核心设置坏格 → 问题表的接线", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-core-problem-wiring-"));
	});
	afterEach(async () => {
		i18n.set({ locale: "zh-CN", voice: "maid" });
		await rm(dataDir, { recursive: true, force: true });
	});

	function bootstrap(): BootstrapConfig {
		return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
	}

	async function putCore(mutate: (disk: Record<string, unknown>) => void): Promise<void> {
		const path = join(dataDir, ...CORE_SETTINGS_FILE);
		await mkdir(dirname(path), { recursive: true });
		const disk = structuredClone(makeDefaultGlobalSettings()) as unknown as Record<string, unknown>;
		mutate(disk);
		await writeFile(path, JSON.stringify(disk, null, 2), "utf8");
	}

	it.each([
		["en", "The value has an incorrect type for this setting."],
		["ja", "値の型が設定のルールに合っていません。"],
		["zh-TW", "值的型別不符合設定規則。"],
	] as const)(
		"%s:切换语言时坏格的安全原因一起更新,不重新报问题或改写原文",
		async (locale, reason) => {
			const raw = "secret-original-do-not-show";
			await putCore((disk) => {
				disk.history = raw;
			});
			const runtime = createAppRuntime(
				bootstrap(),
				{ dataRoot: dataDir },
				{ integrationSettings: [settingsSegment] },
			);
			try {
				i18n.set({ locale: "zh-CN", voice: "plain" });
				await runtime.configStore.load();
				const original = await readFile(join(dataDir, ...CORE_SETTINGS_FILE), "utf8");
				const before = runtime.problems.list()[0];
				expect(before?.message).toContain("值的类型不符合设置规则");
				const changes: ProblemChange[] = [];
				runtime.problems.subscribe((change) => changes.push(change));

				i18n.set({ locale, voice: "plain" });

				const listed = runtime.problems.list();
				expect(listed).toHaveLength(1);
				expect(listed[0]).toMatchObject({
					reporter: "core",
					code: "settings_invalid",
					since: before?.since,
				});
				expect(listed[0]?.message).toContain(reason);
				expect(listed[0]?.message).not.toContain("值的类型不符合设置规则");
				expect(listed[0]?.message).not.toContain(raw);
				expect(changes).toMatchObject([{ kind: "updated", reworded: true, notify: false }]);
				expect(await readFile(join(dataDir, ...CORE_SETTINGS_FILE), "utf8")).toBe(original);
			} finally {
				await runtime.dispose();
			}
		},
	);

	it("带坏格开机:load() 之后问题表里有核心的那一条,文案点名那一格", async () => {
		await putCore((disk) => {
			disk.history = "三十天";
		});
		const runtime = createAppRuntime(
			bootstrap(),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();

		const listed = runtime.problems.list().filter((p) => p.reporter === "core");
		expect(listed).toHaveLength(1);
		expect(listed[0]?.code).toBe("settings_invalid");
		expect(listed[0]?.message).toContain("history");
		await runtime.dispose();
	});

	it("没有坏格:问题表里没有这一条;面板改好保存后那一条随之清掉", async () => {
		await putCore(() => {});
		const clean = createAppRuntime(
			bootstrap(),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await clean.configStore.load();
		expect(clean.problems.list()).toEqual([]);
		await clean.dispose();

		await putCore((disk) => {
			disk.history = "三十天";
		});
		const runtime = createAppRuntime(
			bootstrap(),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		expect(runtime.problems.list()).toHaveLength(1);
		await runtime.configStore.patchGlobals({ history: { retentionDays: 7 } });
		expect(runtime.problems.list()).toEqual([]);
		await runtime.dispose();
	});
});
