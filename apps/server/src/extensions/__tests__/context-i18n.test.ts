/**
 * `ctx.i18n`(ADR-0037 决策 14):拓展按当前语言取自己包里的译文。
 *
 * 钉「接上了」:取字走宿主合好的回落链(细节在 `locales.test.ts`)、语言真变了叫 `onChange`、
 * 收摊之后不再叫、没带译文的拓展照样有这一格。「只换口吻不转」由 `localeReaderOf` 的测试钉着。
 */

import type { ExtensionManifest } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
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
	apiVersion: 2,
	contributes: { push: { display: { label: "测试", shortLabel: "测", color: "#000000" } } },
} as const satisfies ExtensionManifest;

function boot(
	locales: ExtensionLocales,
	initial: string,
	problems: Pick<
		ReturnType<typeof createProblemTable>,
		"report" | "resolve" | "clearReporter"
	> = ignoredProblems,
) {
	const reader = switchableLocale(initial);
	const runtime = createExtensionContext({
		...integrationIo(),
		id: "demo",
		manifest: MANIFEST,
		host: {
			logger: silentLogger,
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose() {},
			signal: new AbortController().signal,
			track: () => {},
		},
		loggerOf: () => silentLogger,
		stores: { ...memoryStores(), redact() {} },
		problems,
		mounts: createExtensionMounts({ logger: silentLogger }),
		adapters: createPlatformAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		subscriptions: () => [],
		onSubscriptionsChanged: () => ({ dispose() {} }),
		settings: () => undefined,
		onSettingsChanged: () => ({ dispose() {} }),
		inbound: {},
		upgrades: createExtensionUpgrades(),
		locales,
		localeReader: reader,
	});
	return { reader, runtime, i18n: runtime.ctx.i18n };
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
