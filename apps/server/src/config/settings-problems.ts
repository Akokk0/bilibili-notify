/**
 * 核心设置的坏格表 → 问题表里的那一条,以及那句话。
 *
 * 问题表的键是「报的人 + 关于哪条订阅 + code」,核心的坏格只放得下一条:几格坏了都写在这一条的文字里,
 * 格数变了再报只换文案、`since` 不动。不带 `notify`:坏格退默认是主人手改文件才会碰到的事,
 * 面板的问题框提示就够了,不私聊。文案集中在这一个文件,逻辑里不拼句子。
 */

import type { Logger } from "@bilibili-notify/internal";
import type { ProblemTable } from "../problems/problem-table.js";
import type { InvalidSettingEntry } from "./core-settings.js";

const KEY = { reporter: "core", code: "settings_invalid" } as const;

/** 文案里最多摊几格,多的写「等 N 格」。 */
const MAX_LISTED = 3;

const cellName = (entry: InvalidSettingEntry): string => entry.path.join(".");

/** 原因取这一格第一条 issue 的话。 */
const reasonOf = (entry: InvalidSettingEntry): string => entry.issues[0]?.message ?? "格式不对";

/** 问题条目里的那句话(女仆口吻)。不带原文:原文可能是主人手写进去的明文 key。 */
export function settingsInvalidMessage(entries: readonly InvalidSettingEntry[]): string {
	const single = entries.length === 1;
	const listed = entries.slice(0, MAX_LISTED).map((e) => `${cellName(e)}（${reasonOf(e)}）`);
	if (entries.length > MAX_LISTED) listed.push(`等 ${entries.length - MAX_LISTED} 格`);
	const count = single ? "有一格" : `有 ${entries.length} 格`;
	const these = single ? "这一格" : "这几格";
	return (
		`主人，设置文件里${count}女仆读不懂，先按默认值在跑了：${listed.join("；")}。` +
		`文件里原来写的女仆一个字没动。${remedyOf(entries, these)}`
	);
}

const isAiCell = (entry: InvalidSettingEntry): boolean => entry.path[0] === "ai";

const EDIT_FILE = "请改好 config/settings/core.json 里对应的那一格再重启。";

/**
 * 怎么修。`ai` 的格不能引主人去面板重存:面板上显示的是默认值,保存会把那一格里原来的内容连同加密袋里的 key 一起换掉。
 */
function remedyOf(entries: readonly InvalidSettingEntry[], these: string): string {
	const aiCount = entries.filter(isAiCell).length;
	if (aiCount === 0) {
		return (
			`到面板把${these}改成想要的样子保存一下就好；` +
			"想找回原来写的，改好 config/settings/core.json 里对应的那一格再重启。"
		);
	}
	const only = aiCount === entries.length;
	const aiThese = only ? (aiCount === 1 ? "这一格" : "这几格") : "那几格";
	const thatCell = only && aiCount === 1 ? "这一格" : "那一格";
	const aiPart =
		`ai 开头的${aiThese}请别在面板上改：面板上现在看不到原来的内容，` +
		`在面板保存会把${thatCell}里原来的东西连同存着的密钥一起换掉；${EDIT_FILE}`;
	return only ? aiPart : `${aiPart}其余的到面板改成想要的样子保存一下就好。`;
}

/** 日志里每格一段:路径与原因,不带原文。 */
function logLine(entries: readonly InvalidSettingEntry[]): string {
	const cells = entries.map((e) => `${cellName(e)}（${reasonOf(e)}）`).join("；");
	return `[config] 核心设置有 ${entries.length} 格读不懂,先按默认值在跑,盘上原文没动:${cells}`;
}

/** `ai` 的格(整格或子格)在坏格里:原文里若手写了明文 key,它没被上提、还留在文件里。 */
const AI_PLAINTEXT_NOTE =
	"[config] ai 的格被隔离了:那一格里如果手写了明文 key,它还留在 core.json 里(没进加密袋),改对那一格后下次开机才会上提;" +
	"别在面板里重存这一格:面板上显示的是默认值,保存会把这一格原来的内容连同加密袋里存着的 key 一起换掉,请改文件再重启";

/**
 * 把当前的坏格表对到问题表:有条目就报(同一条,只换文案),空了就清且不补「已恢复」。
 * 每次有条目时记一行 warn(逐格路径与原因,不带原文)。
 */
export function syncSettingsProblem(
	problems: ProblemTable,
	entries: readonly InvalidSettingEntry[],
	logger: Logger,
): void {
	if (entries.length === 0) {
		problems.resolve(KEY, { notify: false });
		return;
	}
	logger.warn(logLine(entries));
	if (entries.some((e) => e.path[0] === "ai")) logger.warn(AI_PLAINTEXT_NOTE);
	problems.report({ ...KEY, message: settingsInvalidMessage(entries) });
}
