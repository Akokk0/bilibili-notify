/**
 * 核心设置的坏格表 → 问题表里的那一条:文案、对表、日志。
 * 问题表用真的 `createProblemTable`,只看 `list()` 与订阅到的变化,不 mock 它。
 */

import type { Logger } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { createProblemTable, type ProblemChange } from "../../problems/problem-table.js";
import type { InvalidSettingEntry } from "../core-settings.js";
import { settingsInvalidMessage, syncSettingsProblem } from "../settings-problems.js";

function entry(path: string[], reason: string, raw: unknown = "原文"): InvalidSettingEntry {
	return {
		path,
		issues: [{ message: reason }, { message: "第二条不该出现" }],
		raw,
		missing: false,
	};
}

function mkLogger(): Logger {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function mkTable() {
	const logger = mkLogger();
	const table = createProblemTable({ logger });
	const changes: ProblemChange[] = [];
	table.subscribe((c) => changes.push(c));
	return { table, changes, logger };
}

describe("settingsInvalidMessage", () => {
	it("只有一格:写「有一格」「把这一格」,原因取第一条 issue 的话", () => {
		const text = settingsInvalidMessage([entry(["history"], "Invalid input")]);
		expect(text).toContain("有一格女仆读不懂");
		expect(text).toContain("history（Invalid input）");
		expect(text).toContain("把这一格改成想要的样子");
		expect(text).not.toContain("第二条不该出现");
		expect(text).toContain("config/settings/core.json");
	});

	it("两格:写格数、两格都在、用代码路径", () => {
		const text = settingsInvalidMessage([
			entry(["history"], "A 原因"),
			entry(["ai", "providers"], "B 原因"),
		]);
		expect(text).toContain("有 2 格女仆读不懂");
		expect(text).toContain("history（A 原因）；ai.providers（B 原因）");
		expect(text).toContain("把这几格改成想要的样子");
		expect(text).toContain("一个字没动");
	});

	it("最多摊三格,多的写「等 N 格」", () => {
		const entries = ["a", "b", "c", "d", "e"].map((k) => entry([k], `${k} 原因`));
		const text = settingsInvalidMessage(entries);
		expect(text).toContain("有 5 格");
		expect(text).toContain("a（a 原因）；b（b 原因）；c（c 原因）；等 2 格");
		expect(text).not.toContain("d（");
	});

	it("恰好三格:全摊,不写「等」", () => {
		const text = settingsInvalidMessage(["a", "b", "c"].map((k) => entry([k], k)));
		expect(text).not.toContain("等 ");
	});

	it("不承诺「原样保存就清掉」,也不带原文", () => {
		const text = settingsInvalidMessage([entry(["history"], "x", "sk-SECRET-RAW")]);
		expect(text).not.toContain("原样保存");
		expect(text).not.toContain("sk-SECRET-RAW");
	});
});

describe("syncSettingsProblem", () => {
	const key = { reporter: "core", code: "settings_invalid" };

	it("一格坏:表里一条,不带 notify", () => {
		const { table, changes, logger } = mkTable();
		syncSettingsProblem(table, [entry(["history"], "R")], logger);
		const listed = table.list();
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject(key);
		expect(listed[0]?.message).toContain("history（R）");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.kind).toBe("opened");
		expect(changes[0]?.notify).toBe(false);
	});

	it("两格:仍是一条,文案里两格都在;格数变了再报只换文案", () => {
		const { table, changes, logger } = mkTable();
		syncSettingsProblem(table, [entry(["history"], "R1")], logger);
		const since = table.list()[0]?.since;
		syncSettingsProblem(
			table,
			[entry(["history"], "R1"), entry(["ai", "providers"], "R2")],
			logger,
		);
		const listed = table.list();
		expect(listed).toHaveLength(1);
		expect(listed[0]?.message).toContain("history（R1）");
		expect(listed[0]?.message).toContain("ai.providers（R2）");
		expect(listed[0]?.since).toBe(since);
		expect(changes.map((c) => c.kind)).toEqual(["opened", "updated"]);
		expect(changes.every((c) => c.notify === false)).toBe(true);
	});

	it("清到零:表里没有了,且不补「已恢复」", () => {
		const { table, changes, logger } = mkTable();
		syncSettingsProblem(table, [entry(["history"], "R")], logger);
		syncSettingsProblem(table, [], logger);
		expect(table.list()).toEqual([]);
		expect(changes.at(-1)).toMatchObject({ kind: "closed", notify: false });
	});

	it("本来就没有、也没有坏格:什么都不发生", () => {
		const { table, changes, logger } = mkTable();
		syncSettingsProblem(table, [], logger);
		expect(changes).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("warn 日志逐格带路径与原因,不带原文", () => {
		const { table, logger } = mkTable();
		syncSettingsProblem(
			table,
			[entry(["history"], "R1", "sk-SECRET-RAW"), entry(["mutedUntil"], "R2")],
			logger,
		);
		// 问题表自己也往同一个 logger 记它收到的话(那是问题条目的文案,另有断言),这里只看配置这边的那几行。
		const lines = vi
			.mocked(logger.warn)
			.mock.calls.map((c) => String(c[0]))
			.filter((l) => l.startsWith("[config]"))
			.join("\n");
		expect(lines).toContain("history");
		expect(lines).toContain("R1");
		expect(lines).toContain("mutedUntil");
		expect(lines).toContain("R2");
		expect(lines).not.toContain("sk-SECRET-RAW");
		expect(lines).not.toContain("一个字没动");
	});

	it("ai 的格被隔离:日志里加一句「手写的明文 key 还留在文件里」;别的格不加", () => {
		const { table, logger } = mkTable();
		syncSettingsProblem(table, [entry(["history"], "R")], logger);
		expect(
			vi
				.mocked(logger.warn)
				.mock.calls.map((c) => String(c[0]))
				.join("\n"),
		).not.toContain("明文 key");

		const ai = mkTable();
		syncSettingsProblem(ai.table, [entry(["ai", "providers"], "R")], ai.logger);
		expect(
			vi
				.mocked(ai.logger.warn)
				.mock.calls.map((c) => String(c[0]))
				.join("\n"),
		).toContain("明文 key");
		const whole = mkTable();
		syncSettingsProblem(whole.table, [entry(["ai"], "R")], whole.logger);
		expect(
			vi
				.mocked(whole.logger.warn)
				.mock.calls.map((c) => String(c[0]))
				.join("\n"),
		).toContain("明文 key");
	});
});
