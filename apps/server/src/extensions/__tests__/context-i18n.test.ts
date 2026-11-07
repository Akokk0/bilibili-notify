import { logMessage } from "../../__tests__/support/log-message.js";
/**
 * `ctx.i18n`(ADR-0037 决策 14):拓展按当前语言取自己包里的译文。
 *
 * 钉「接上了」:取字走宿主合好的回落链(细节在 `locales.test.ts`)、语言真变了叫 `onChange`、
 * 收摊之后不再叫、没带译文的拓展照样有这一格。「只换口吻不转」由 `localeReaderOf` 的测试钉着。
 */

import type { ExtensionManifest, Logger } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
	extensionLocalesOf,
	noExtensionLocales,
} from "../../__tests__/support/extension-locales.js";
import { switchableLocale } from "../../__tests__/support/fixed-locale.js";
import { ignoredProblems } from "../../__tests__/support/ignored-problems.js";
import { integrationIo } from "../../__tests__/support/integration-io.js";
import { memoryStores } from "../../__tests__/support/memory-key-value-store.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createProblemTable, type ProblemChange } from "../../problems/problem-table.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { createExtensionContext } from "../context.js";
import type { ExtensionLocales } from "../locales.js";
import { createExtensionMounts } from "../mount.js";
import { createExtensionUpgrades } from "../upgrade.js";

const MANIFEST = {
	id: "demo",
	name: "示例",
	description: "测试用",
	version: "1.0.0",
	apiVersion: 1,
	contributes: { push: { label: "测试", shortLabel: "测", color: "#000000" } },
} as const satisfies ExtensionManifest;

function boot(
	locales: ExtensionLocales,
	initial: string,
	problems: Pick<
		ReturnType<typeof createProblemTable>,
		"report" | "resolve" | "clearReporter"
	> = ignoredProblems,
	logger: Logger = silentLogger,
) {
	const reader = switchableLocale(initial);
	const adapters = createPlatformAdapterRegistry();
	const runtime = createExtensionContext({
		...integrationIo(),
		id: "demo",
		manifest: MANIFEST,
		host: {
			logger,
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose() {},
			signal: new AbortController().signal,
			track: () => {},
		},
		loggerOf: () => logger,
		stores: { ...memoryStores(), redact() {} },
		problems,
		mounts: createExtensionMounts({ logger: silentLogger }),
		adapters,
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		settings: () => undefined,
		onSettingsChanged: () => ({ dispose() {} }),
		inbound: {},
		upgrades: createExtensionUpgrades(),
		locales,
		localeReader: reader,
	});
	return { reader, runtime, adapters, i18n: runtime.ctx.i18n };
}

const SAMPLE = extensionLocalesOf({
	"zh-CN": {
		"status.up": "已连接",
		"bots#one": "{count} 个机器人",
		"bots#other": "{count} 个机器人们",
	},
	en: { "status.up": "Connected", "bots#one": "{count} bot", "bots#other": "{count} bots" },
});

describe("ctx.i18n", () => {
	it("locale() 与 t 读当前语言,占位符照填", () => {
		const { i18n } = boot(
			extensionLocalesOf({ en: { hello: "Hi {who}" }, "zh-CN": { hello: "你好 {who}" } }),
			"en",
		);
		expect(i18n.locale()).toBe("en");
		expect(i18n.t("hello", { who: "Ann" })).toBe("Hi Ann");
	});

	it("语言换了 t 跟着换,onChange 叫一次", () => {
		const { i18n, reader } = boot(SAMPLE, "zh-CN");
		let calls = 0;
		i18n.onChange(() => calls++);
		expect(i18n.t("status.up")).toBe("已连接");

		reader.set("en");

		expect(calls).toBe(1);
		expect(i18n.locale()).toBe("en");
		expect(i18n.t("status.up")).toBe("Connected");
	});

	/**
	 * 拓展的回调是第三方代码:它抛了不许沿 `localeReader` → 总线 `config-changed` 冒出去 —— 那一发是
	 * 同步的,冒出去会掐断排在后面的监听,还会把「写设置」那一请求一起带走。只记一行带原话与口名的
	 * error,不重抛。
	 */
	it("onChange 回调抛了:切换不抛,后面的监听照收,记一行带原话的 error", () => {
		const lines: string[] = [];
		const logger: Logger = {
			info: () => {},
			warn: () => {},
			debug: () => {},
			error: (m, ...args) => lines.push(logMessage(m, args)),
		};
		const { i18n, reader } = boot(SAMPLE, "zh-CN", ignoredProblems, logger);
		const seen: string[] = [];
		i18n.onChange(() => {
			throw new Error("boom");
		});
		i18n.onChange(() => seen.push("after"));

		expect(() => reader.set("en")).not.toThrow();

		expect(seen).toEqual(["after"]);
		expect(lines.some((l) => l.includes("i18n.onChange") && l.includes("boom"))).toBe(true);
	});

	it("报问题时用的写者名按当前语言取清单名:换语言后再报跟着换", () => {
		const locales = noExtensionLocales();
		locales.files["zh-CN"] = { dict: {}, manifest: { name: "简中名" }, issues: [] };
		locales.files.en = { dict: {}, manifest: { name: "English name" }, issues: [] };
		const problems = createProblemTable({ logger: silentLogger });
		const { runtime, reader } = boot(locales, "zh-CN", problems);
		const changes: ProblemChange[] = [];
		problems.subscribe((c) => changes.push(c));

		runtime.ctx.reportProblem({ code: "x_y", message: "第一句" });
		reader.set("en");
		runtime.ctx.reportProblem({ code: "x_y", message: "second" });

		expect(changes.map((c) => c.writtenBy)).toEqual(["简中名", "English name"]);
	});

	it("登记的平台适配器,描述由宿主照清单推送那一口填,每次读按当前语言盖好译文", async () => {
		const locales = noExtensionLocales();
		locales.files["zh-CN"] = {
			dict: {},
			manifest: { contributes: { push: { label: "简中桥", shortLabel: "简" } } },
			issues: [],
		};
		locales.files.en = {
			dict: {},
			manifest: { contributes: { push: { label: "Test bridge", shortLabel: "TB" } } },
			issues: [],
		};
		const { runtime, reader, adapters: registry } = boot(locales, "zh-CN");
		runtime.ctx.registerPlatformAdapter({
			probe: async () => ({ ok: true, latencyMs: 0 }),
			start: () => {},
			stop: () => {},
			isAvailable: () => true,
			send: async () => ({ ok: true, latencyMs: 0 }),
			settingsSchema: z.object({}),
			listConnectionCandidates: async () => [],
		});
		expect(await runtime.registrationsSettled()).toEqual({ ok: true });
		const adapters = registry.list();
		expect(adapters.map((adapter) => adapter.descriptor())).toEqual([
			{ label: "简中桥", shortLabel: "简", color: "#000000", settingsFields: [] },
		]);

		reader.set("en");

		expect(adapters.map((adapter) => adapter.descriptor())).toEqual([
			{ label: "Test bridge", shortLabel: "TB", color: "#000000", settingsFields: [] },
		]);
	});

	it("收摊之后再换语言,onChange 不再叫", async () => {
		const { i18n, reader, runtime } = boot(SAMPLE, "zh-CN");
		let calls = 0;
		i18n.onChange(() => calls++);

		await runtime.dispose();
		reader.set("en");

		expect(calls).toBe(0);
	});

	it("onChange 交回的把手摘掉之后不再叫", () => {
		const { i18n, reader } = boot(SAMPLE, "zh-CN");
		let calls = 0;
		const handle = i18n.onChange(() => calls++);
		handle.dispose();
		reader.set("en");
		expect(calls).toBe(0);
	});

	it("回落链接上了:只带简中、当前是日文 → 出简中;简中也没有的句子落英文,都没有回键本身", () => {
		const { i18n } = boot(
			extensionLocalesOf({ "zh-CN": { a: "简中甲" }, en: { a: "English A", b: "English B" } }),
			"ja",
		);
		expect(i18n.t("a")).toBe("简中甲");
		expect(i18n.t("b")).toBe("English B");
		expect(i18n.t("nowhere")).toBe("nowhere");
	});

	it("单复数按当前语言挑", () => {
		const { i18n, reader } = boot(SAMPLE, "en");
		expect(i18n.t("bots", { count: 1 })).toBe("1 bot");
		expect(i18n.t("bots", { count: 3 })).toBe("3 bots");
		reader.set("zh-CN");
		expect(i18n.t("bots", { count: 1 })).toBe("1 个机器人们");
	});

	it("没带译文的拓展照样有 ctx.i18n:t 回键本身,locale() 照读", () => {
		const { i18n } = boot(noExtensionLocales(), "en");
		expect(i18n.locale()).toBe("en");
		expect(i18n.t("status.up")).toBe("status.up");
	});
});
