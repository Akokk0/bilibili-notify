/**
 * 核心设置的坏格表 → 问题表里的那一条:文案、对表、日志。
 * 问题表用真的 `createProblemTable`,只看 `list()` 与订阅到的变化,不 mock 它。
 */

import type { Logger } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { createProblemTable, type ProblemChange } from "../../problems/problem-table.js";
import type { InvalidSettingEntry } from "../core-settings.js";
import {
	brokenInstanceIdTakenMessage,
	settingsInvalidMessage,
	shortenInstanceId,
	syncSettingsProblem,
} from "../settings-problems.js";

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
			entry(["mutedUntil"], "B 原因"),
		]);
		expect(text).toContain("有 2 格女仆读不懂");
		expect(text).toContain("history（A 原因）；mutedUntil（B 原因）");
		expect(text).toContain("把这几格改成想要的样子");
		expect(text).toContain("一个字没动");
		expect(text).not.toContain("别在面板上改");
	});

	it("只有 ai 的格坏:先说改文件再重启,明说别在面板上改,不引主人去面板保存", () => {
		const text = settingsInvalidMessage([entry(["ai", "providers"], "B 原因")]);
		expect(text).toBe(
			"主人，设置文件里有一格女仆读不懂，先按默认值在跑了：ai.providers（B 原因）。" +
				"文件里原来写的女仆一个字没动。" +
				"ai 开头的这一格请别在面板上改：面板上现在看不到原来的内容，在面板保存会把这一格里原来的东西连同存着的密钥一起换掉；" +
				"请改好 config/settings/core.json 里对应的那一格再重启。",
		);
		expect(text).not.toContain("改成想要的样子");
	});

	it("ai 的几格都坏(整格与子格):用「这几格」", () => {
		const text = settingsInvalidMessage([entry(["ai"], "A"), entry(["ai", "search"], "B")]);
		expect(text).toContain("ai 开头的这几格请别在面板上改");
		expect(text).not.toContain("改成想要的样子");
	});

	it("ai 的格与别的格都坏:ai 的别在面板改、其余的到面板改", () => {
		const text = settingsInvalidMessage([
			entry(["history"], "A 原因"),
			entry(["ai", "providers"], "B 原因"),
			entry(["ai", "search"], "C 原因"),
		]);
		expect(text).toBe(
			"主人，设置文件里有 3 格女仆读不懂，先按默认值在跑了：history（A 原因）；ai.providers（B 原因）；ai.search（C 原因）。" +
				"文件里原来写的女仆一个字没动。" +
				"ai 开头的那几格请别在面板上改：面板上现在看不到原来的内容，在面板保存会把那一格里原来的东西连同存着的密钥一起换掉；" +
				"请改好 config/settings/core.json 里对应的那一格再重启。" +
				"其余的到面板改成想要的样子保存一下就好。",
		);
	});

	it("超过三格摊不下时,ai 的格排在后面也照样识别", () => {
		const entries = [
			...["a", "b", "c", "d"].map((k) => entry([k], k)),
			entry(["ai", "providers"], "P"),
		];
		const text = settingsInvalidMessage(entries);
		expect(text).toContain("等 2 格");
		expect(text).toContain("别在面板上改");
		expect(text).toContain("其余的到面板");
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

/** 单家 AI 服务商的坏格:路径三段,原因带值规则里的字段名;原文故意放一个看着像密钥的值。 */
function inst(id: string, field: string, reason: string): InvalidSettingEntry {
	return {
		path: ["ai", "providers", id],
		issues: [{ path: field.split("."), message: reason }, { message: "第二条不该出现" }],
		raw: { apiKey: "sk-SECRET-RAW" },
		missing: false,
	};
}

const EDIT_THE_FILE = "请改好 config/settings/core.json 里 ai.providers 下的";

describe("settingsInvalidMessage:单家 AI 服务商(成品整句)", () => {
	it("只有一家坏", () => {
		const text = settingsInvalidMessage([
			inst("deepseek", "model", "Invalid input: expected string, received number"),
		]);
		expect(text).toBe(
			"主人，设置文件里有一家 AI 服务商女仆读不懂：deepseek（model：Invalid input: expected string, received number）。" +
				"文件里原来写的女仆一个字没动。" +
				"这一家先当它不在，别家照常用、在面板上照常改；存着的密钥也还在，" +
				`${EDIT_THE_FILE}这一家再重启，它就回来了。` +
				"面板上现在看不到它；这时候在面板上新加同一家服务商，可能会存不进去，保存条上会说明原因。" +
				"要是女仆平时用的正好是这一家，AI 会先停着。",
		);
		expect(text).not.toContain("sk-SECRET-RAW");
		expect(text).not.toContain("第二条不该出现");
	});

	it("几家都坏", () => {
		const text = settingsInvalidMessage([
			inst("deepseek", "model", "R1"),
			inst("openrouter", "vision.apiKey", "R2"),
		]);
		expect(text).toBe(
			"主人，设置文件里有 2 家 AI 服务商女仆读不懂：deepseek（model：R1）；openrouter（vision.apiKey：R2）。" +
				"文件里原来写的女仆一个字没动。" +
				"这几家先当它们不在，别家照常用、在面板上照常改；存着的密钥也还在，" +
				`${EDIT_THE_FILE}这几家再重启，它们就回来了。` +
				"面板上现在看不到它们；这时候在面板上新加同一家服务商，可能会存不进去，保存条上会说明原因。" +
				"要是女仆平时用的正好是其中一家，AI 会先停着。",
		);
	});

	it("超过三家:摊三家,多的写「等 N 家」", () => {
		const text = settingsInvalidMessage(
			["a", "b", "c", "d", "e"].map((k) => inst(k, "model", `${k}原因`)),
		);
		expect(text).toContain(
			"有 5 家 AI 服务商女仆读不懂：a（model：a原因）；b（model：b原因）；c（model：c原因）；等 2 家。",
		);
		expect(text).not.toContain("d（");
	});

	it("单家与普通格混着", () => {
		const text = settingsInvalidMessage([
			entry(["history"], "A 原因"),
			inst("deepseek", "model", "B 原因"),
		]);
		expect(text).toBe(
			"主人，设置文件里有 2 处女仆读不懂：history（A 原因）；AI 服务商 deepseek（model：B 原因）。" +
				"文件里原来写的女仆一个字没动。" +
				"其余的到面板改成想要的样子保存一下就好。" +
				"那一家先当它不在，别家照常用、在面板上照常改；存着的密钥也还在，" +
				`${EDIT_THE_FILE}那一家再重启，它就回来了。` +
				"面板上现在看不到它；这时候在面板上新加同一家服务商，可能会存不进去，保存条上会说明原因。" +
				"要是女仆平时用的正好是这一家，AI 会先停着。",
		);
	});

	it("单家与 ai.search 混着:search 别在面板上改,而且说的是原文里手写的 key 会没,不是袋里的", () => {
		const text = settingsInvalidMessage([
			inst("deepseek", "model", "B 原因"),
			entry(["ai", "search"], "C 原因"),
		]);
		expect(text).toBe(
			"主人，设置文件里有 2 处女仆读不懂：AI 服务商 deepseek（model：B 原因）；ai.search（C 原因）。" +
				"文件里原来写的女仆一个字没动。" +
				"ai 开头的那一格请别在面板上改：面板上现在看不到原来的内容，" +
				"在面板保存会把那一格里原来的东西换掉，手写在里面、还没存进加密袋的 key 也会一起没了；" +
				"请改好 config/settings/core.json 里对应的那一格再重启。" +
				"那一家先当它不在，别家照常用、在面板上照常改；存着的密钥也还在，" +
				`${EDIT_THE_FILE}那一家再重启，它就回来了。` +
				"面板上现在看不到它；这时候在面板上新加同一家服务商，可能会存不进去，保存条上会说明原因。" +
				"要是女仆平时用的正好是这一家，AI 会先停着。",
		);
	});

	it("超过三处且单家排在后面:照样摊三处、单家的话照样在", () => {
		const text = settingsInvalidMessage([
			...["a", "b", "c"].map((k) => entry([k], k)),
			inst("deepseek", "model", "R"),
			inst("openrouter", "model", "R"),
		]);
		expect(text).toContain("有 5 处女仆读不懂：a（a）；b（b）；c（c）；等 2 处。");
		expect(text).toContain("那几家先当它们不在");
		expect(text).toContain("AI 会先停着");
	});
});

describe("settingsInvalidMessage:ai 的格分两类(成品整句)", () => {
	it("ai.search 单独坏:别在面板上改,不说「连同密钥」(重存不丢袋里的键)", () => {
		expect(settingsInvalidMessage([entry(["ai", "search"], "S")])).toBe(
			"主人，设置文件里有一格女仆读不懂，先按默认值在跑了：ai.search（S）。" +
				"文件里原来写的女仆一个字没动。" +
				"ai 开头的这一格请别在面板上改：面板上现在看不到原来的内容，" +
				"在面板保存会把这一格里原来的东西换掉，手写在里面、还没存进加密袋的 key 也会一起没了；" +
				"请改好 config/settings/core.json 里对应的那一格再重启。",
		);
	});

	it.each([
		"enabled",
		"persona",
		"dynamicPrompt",
		"liveSummaryPrompt",
		"activeProfile",
		"activePreset",
		"presets",
		"chat",
	])("ai.%s 坏:与普通格同一句,到面板改好保存", (sub) => {
		expect(settingsInvalidMessage([entry(["ai", sub], "R")])).toBe(
			`主人，设置文件里有一格女仆读不懂，先按默认值在跑了：ai.${sub}（R）。` +
				"文件里原来写的女仆一个字没动。" +
				"到面板把这一格改成想要的样子保存一下就好；" +
				"想找回原来写的，改好 config/settings/core.json 里对应的那一格再重启。",
		);
	});

	it("整格与整张表(上面已有整句的两种)仍说「连同存着的密钥」", () => {
		expect(settingsInvalidMessage([entry(["ai"], "R")])).toContain("连同存着的密钥一起换掉");
		expect(settingsInvalidMessage([entry(["ai", "providers"], "R")])).toContain(
			"连同存着的密钥一起换掉",
		);
	});
});

describe("shortenInstanceId", () => {
	it("正好 32 个字符:原样", () => {
		expect(shortenInstanceId("a".repeat(32))).toBe("a".repeat(32));
	});
	it("33 个字符:留 32 个加省略号", () => {
		expect(shortenInstanceId("a".repeat(33))).toBe(`${"a".repeat(32)}…`);
	});
	it("多字节字符:按字符数,不截出半个", () => {
		expect(shortenInstanceId("你".repeat(32))).toBe("你".repeat(32));
		expect(shortenInstanceId("你".repeat(33))).toBe(`${"你".repeat(32)}…`);
		const emoji = shortenInstanceId("😀".repeat(40));
		expect(emoji).toBe(`${"😀".repeat(32)}…`);
		expect(emoji).not.toMatch(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
		);
	});
	it("带连接符的组合表情算一个字符", () => {
		const family = "👨‍👩‍👧";
		expect(shortenInstanceId(family.repeat(32))).toBe(family.repeat(32));
		expect(shortenInstanceId(family.repeat(33))).toBe(`${family.repeat(32)}…`);
	});
	it("进了问题条目的话与日志:超长的 id 被截断,完整的不出门", () => {
		const long = `sk-${"x".repeat(60)}`;
		const text = settingsInvalidMessage([inst(long, "model", "R")]);
		expect(text).toContain(`${long.slice(0, 32)}…（model：R）`);
		expect(text).not.toContain(long);
		const { table, logger } = mkTable();
		syncSettingsProblem(table, [inst(long, "model", "R")], logger);
		const lines = vi
			.mocked(logger.warn)
			.mock.calls.map((c) => String(c[0]))
			.join("\n");
		expect(lines).toContain(`${long.slice(0, 32)}…`);
		expect(lines).not.toContain(long);
	});
});

describe("syncSettingsProblem 交进表的话", () => {
	it("交的是取字函数(换语言或口吻时表重跑它),现取的字就是整句", () => {
		const report = vi.fn();
		syncSettingsProblem(
			{ report, resolve: vi.fn() } as never,
			[entry(["history"], "X")],
			mkLogger(),
		);
		expect(report).toHaveBeenCalledTimes(1);
		const message = report.mock.calls[0]?.[0].message;
		expect(typeof message).toBe("function");
		expect(message()).toBe(settingsInvalidMessage([entry(["history"], "X")]));
	});
});

describe("brokenInstanceIdTakenMessage", () => {
	it("女仆口吻的整句,id 超长同样截断", () => {
		expect(brokenInstanceIdTakenMessage("mid")).toBe(
			"主人，这个 id（mid）被设置文件里读不懂的那一家 AI 服务商占着，女仆这次没有保存。" +
				"请改好 config/settings/core.json 里 ai.providers 下的这一家再重启；不想要它了，就在文件里把它删掉再重启。",
		);
		expect(brokenInstanceIdTakenMessage("x".repeat(40))).toContain(`${"x".repeat(32)}…`);
	});
});

describe("syncSettingsProblem 的日志:单家", () => {
	const linesOf = (logger: Logger) =>
		vi
			.mocked(logger.warn)
			.mock.calls.map((c) => String(c[0]))
			.filter((l) => l.startsWith("[config]"));

	it("单家:一行带「AI 服务商 id（字段：原因）」,另有单家的明文 key 提醒;不带原文、不带整格那句", () => {
		const { table, logger } = mkTable();
		syncSettingsProblem(table, [inst("deepseek", "model", "R")], logger);
		const lines = linesOf(logger);
		expect(lines[0]).toBe(
			"[config] 核心设置有 1 处读不懂(坏的 AI 服务商先当它不在,别格先按默认值在跑),盘上原文没动:AI 服务商 deepseek（model：R）",
		);
		expect(lines[1]).toBe(
			"[config] 有 AI 服务商被隔离了:这一家里如果手写了明文 key,它还留在 core.json 里(没进加密袋),改对之后下次开机才会上提",
		);
		expect(lines).toHaveLength(2);
		const all = lines.join("\n");
		expect(all).not.toContain("sk-SECRET-RAW");
		expect(all).not.toContain("别在面板里重存");
	});

	it("ai 的其余子格(persona)坏:没有明文 key 的提醒", () => {
		const { table, logger } = mkTable();
		syncSettingsProblem(table, [entry(["ai", "persona"], "R")], logger);
		expect(linesOf(logger).join("\n")).not.toContain("明文 key");
	});

	it("单家与 ai.search 一起:两种提醒都有", () => {
		const { table, logger } = mkTable();
		syncSettingsProblem(
			table,
			[inst("deepseek", "model", "R"), entry(["ai", "search"], "S")],
			logger,
		);
		const all = linesOf(logger).join("\n");
		expect(all).toContain("别在面板里重存这一格");
		expect(all).toContain("这一家里如果手写了明文 key");
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
		const aiLines = vi
			.mocked(ai.logger.warn)
			.mock.calls.map((c) => String(c[0]))
			.join("\n");
		expect(aiLines).toContain("明文 key");
		expect(aiLines).toContain("别在面板里重存这一格");
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
