import { t as serverText } from "../i18n/index.js";
/**
 * 核心设置的坏格表 → 问题表里的那一条,以及那句话。
 *
 * 问题表的键是「报的人 + 关于哪条订阅 + code」,核心的坏格只放得下一条:几格坏了都写在这一条的文字里,
 * 格数变了再报只换文案、`since` 不动。不带 `notify`:坏格退默认是主人手改文件才会碰到的事,
 * 面板的问题框提示就够了,不私聊。文案集中在这一个文件,逻辑里不拼句子。
 *
 * 坏格分三类,各说各的:
 * - **单家的 AI 服务商**(`ai.providers.<id>`):那一家在内存里不在,别家与密钥照常,面板上看不到它、重存不了它;
 * - **别在面板上改的**:`ai` 整格、`ai.providers` 整张表、`ai.search`(面板上显示的是默认值,重存会换掉原来的内容);
 * - **其余的格**(含 `ai` 的其余子格):到面板改好保存就好(`ai` 的其余子格重存不碰密钥,
 *   由 `__tests__/store-invalid-settings.test.ts` 用真密钥袋钉着)。
 */

import type { Logger } from "@bilibili-notify/internal";
import type { ProblemTable } from "../problems/problem-table.js";
import {
	instanceIdOfEntry,
	type InvalidSettingEntry as StoredInvalidSettingEntry,
} from "./core-settings.js";

type InvalidSettingEntry = Pick<StoredInvalidSettingEntry, "path" | "issues">;

const KEY = { reporter: "core", code: "settings_invalid" } as const;

/** 文案里最多摊几格,多的写「等 N 格」。 */
const MAX_LISTED = 3;

/** 实例 id 带进文案时最多留几个字符,多的截断加省略号。 */
const MAX_ID_CHARS = 32;

/**
 * 实例 id 进文案:超过 32 个字符截断加「…」。按字形簇数(`Intl.Segmenter`),多字节字符 / 带修饰的表情不会被截出半个。
 * id 是盘上的键不是值,面板读设置时好的各家的 id 本来就原样下发;截断只为防主人把长串(比如误贴的密钥)写成键。
 */
export function shortenInstanceId(id: string): string {
	const graphemes = Array.from(
		new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(id),
	);
	if (graphemes.length <= MAX_ID_CHARS) return id;
	return `${graphemes
		.slice(0, MAX_ID_CHARS)
		.map((g) => g.segment)
		.join("")}…`;
}

/** 这一格是不是单家的 AI 服务商;是就回(截断过的)id。 */
const instanceLabelOf = (entry: InvalidSettingEntry): string | undefined => {
	const id = instanceIdOfEntry(entry.path);
	return id === undefined ? undefined : shortenInstanceId(id);
};

const isInstance = (entry: InvalidSettingEntry): boolean =>
	instanceIdOfEntry(entry.path) !== undefined;

/** 请别在面板上改的三种:`ai` 整格、`ai.providers` 整张表、`ai.search`。 */
const isHandsOff = (entry: InvalidSettingEntry): boolean => {
	const [head, sub] = entry.path;
	if (head !== "ai") return false;
	return (
		entry.path.length === 1 ||
		(entry.path.length === 2 && (sub === "providers" || sub === "search"))
	);
};

/** 重存会把密钥换掉的两种:`ai` 整格、`ai.providers` 整张表。`ai.search` 重存不丢袋里的键,丢的是原文里手写的明文。 */
const losesKeysOnResave = (entry: InvalidSettingEntry): boolean =>
	isHandsOff(entry) && entry.path[1] !== "search";

const cellName = (entry: InvalidSettingEntry): string => entry.path.join(".");

/** 原因取这一格第一条 issue 的话;单家的带上值规则里的字段名(`model：…`),字段名不是盘上的内容。 */
function reasonOf(entry: InvalidSettingEntry): string {
	const first = entry.issues[0];
	if (!first) return serverText("service.config.settings-problems.text.1");
	if (isInstance(entry) && first.path && first.path.length > 0) {
		return `${first.path.join(".")}：${first.message}`;
	}
	return first.message;
}

/** 一格在列表里的写法。`withPrefix`:单家的前面加「AI 服务商」(列表里还有别的格时才需要)。 */
function labelOf(entry: InvalidSettingEntry, withPrefix: boolean): string {
	const id = instanceLabelOf(entry);
	if (id === undefined) return `${cellName(entry)}（${reasonOf(entry)}）`;
	return `${withPrefix ? serverText("service.config.settings-problems.text.2") : ""}${id}（${reasonOf(entry)}）`;
}

/** 摊开前三格,多的写「等 N <单位>」。 */
function listed(
	entries: readonly InvalidSettingEntry[],
	withPrefix: boolean,
	unit: string,
): string {
	const shown = entries.slice(0, MAX_LISTED).map((e) => labelOf(e, withPrefix));
	if (entries.length > MAX_LISTED)
		shown.push(
			serverText("service.config.settings-problems.text.3", {
				value0: entries.length - MAX_LISTED,
				value1: unit,
			}),
		);
	return shown.join("；");
}

/** 问题条目里的那句话(女仆口吻)。不带原文:原文可能是主人手写进去的明文 key。 */
export function settingsInvalidMessage(entries: readonly InvalidSettingEntry[]): string {
	const instances = entries.filter(isInstance);
	if (instances.length === entries.length) return instancesOnlyMessage(instances);
	const unit =
		instances.length > 0
			? serverText("service.config.settings-problems.text.4")
			: serverText("service.config.settings-problems.text.5");
	const single = entries.length === 1;
	const count = single
		? serverText("service.config.settings-problems.text.6", { value0: unit })
		: serverText("service.config.settings-problems.text.7", {
				value0: entries.length,
				value1: unit,
			});
	const these = single
		? serverText("service.config.settings-problems.text.8")
		: serverText("service.config.settings-problems.text.9");
	// 有单家的:不能笼统说「先按默认值在跑」(单家是「先当它不在」),这句话挪到各类的补救里分开说。
	const lead =
		instances.length > 0
			? serverText("service.config.settings-problems.text.10", {
					value0: count,
					value1: listed(entries, true, unit),
				})
			: serverText("service.config.settings-problems.text.11", {
					value0: count,
					value1: listed(entries, false, unit),
				});
	return serverText("service.config.settings-problems.text.12", {
		value0: lead,
		value1: remedyOf(entries, these),
	});
}

/** 只有单家坏:不带「处」「格」,直接说几家。 */
function instancesOnlyMessage(instances: readonly InvalidSettingEntry[]): string {
	const single = instances.length === 1;
	const count = single
		? serverText("service.config.settings-problems.text.13")
		: serverText("service.config.settings-problems.text.14", { count: instances.length });
	return (
		serverText("service.config.settings-problems.text.16", {
			value0: count,
			value1: listed(instances, false, serverText("service.config.settings-problems.text.15")),
		}) +
		serverText("service.config.settings-problems.text.19", {
			value0: instancesRemedy(
				instances.length,
				single
					? serverText("service.config.settings-problems.text.17")
					: serverText("service.config.settings-problems.text.18"),
			),
		})
	);
}

const editFile = () => serverText("service.config.settings-problems.text.20");

/**
 * 单家的怎么修:别家照常用、面板上照常改(写口 `ai.providers` 的别家照存,见 store-invalid-settings 的 N3);
 * 密钥还在、改好文件重启它就回来(N4);面板上看不到它、新加同 id 的会被拒收(N11);
 * 在用的正是它时 AI 先停着(引擎读不到那一家,按「没配齐」停,不换家)。
 */
function instancesRemedy(count: number, those: string): string {
	const pron =
		count === 1
			? serverText("service.config.settings-problems.text.21")
			: serverText("service.config.settings-problems.text.22");
	const inUse =
		count === 1
			? serverText("service.config.settings-problems.text.23")
			: serverText("service.config.settings-problems.text.24");
	return (
		serverText("service.config.settings-problems.text.25", { value0: those, value1: pron }) +
		serverText("service.config.settings-problems.text.26", { value0: those, value1: pron }) +
		serverText("service.config.settings-problems.text.27", { value0: pron }) +
		serverText("service.config.settings-problems.text.28", { value0: inUse })
	);
}

/**
 * 怎么修,三类各说各的(次序:别在面板上改的、其余的格、单家的)。别在面板上改的不能引主人去面板重存:
 * 面板上显示的是默认值,保存会把那一格里原来的内容换掉 —— `ai` 整格与 `ai.providers` 整张表还连同加密袋里的 key。
 */
function remedyOf(entries: readonly InvalidSettingEntry[], these: string): string {
	const handsOff = entries.filter(isHandsOff);
	const instances = entries.filter(isInstance);
	const plainCount = entries.length - handsOff.length - instances.length;
	const pieces: string[] = [];

	if (handsOff.length > 0) {
		const only = handsOff.length === entries.length;
		const one = handsOff.length === 1;
		const aiThese = only
			? one
				? serverText("service.config.settings-problems.text.29")
				: serverText("service.config.settings-problems.text.30")
			: one
				? serverText("service.config.settings-problems.text.31")
				: serverText("service.config.settings-problems.text.32");
		const thatCell =
			only && handsOff.length === 1
				? serverText("service.config.settings-problems.text.33")
				: serverText("service.config.settings-problems.text.34");
		const lost = handsOff.some(losesKeysOnResave)
			? serverText("service.config.settings-problems.text.35")
			: serverText("service.config.settings-problems.text.36");
		pieces.push(
			serverText("service.config.settings-problems.text.37", { value0: aiThese }) +
				serverText("service.config.settings-problems.text.38", {
					value0: thatCell,
					value1: lost,
					value2: editFile(),
				}),
		);
	}
	if (plainCount > 0) {
		if (handsOff.length === 0 && instances.length === 0) {
			pieces.push(
				serverText("service.config.settings-problems.text.39", { value0: these }) +
					serverText("service.config.settings-problems.text.40"),
			);
		} else {
			pieces.push(serverText("service.config.settings-problems.text.41"));
		}
	}
	if (instances.length > 0) {
		pieces.push(
			instancesRemedy(
				instances.length,
				instances.length === 1
					? serverText("service.config.settings-problems.text.42")
					: serverText("service.config.settings-problems.text.43"),
			),
		);
	}
	return pieces.join("");
}

/**
 * 面板新加的一家 AI 服务商,id 撞上设置文件里读不懂的那一家:这次保存拒收,逐格原因就是这句话。
 * 面板挑 id 时看不见坏着的那一家,所以会撞;这句话是第 4 期之前主人在面板上唯一能看到「有一家读不懂」的地方。
 */
export function brokenInstanceIdTakenMessage(id: string): string {
	return (
		serverText("service.config.settings-problems.text.44", { value0: shortenInstanceId(id) }) +
		serverText("service.config.settings-problems.text.45")
	);
}

/** 日志里每格一段:路径与原因,不带原文。 */
function logLine(entries: readonly InvalidSettingEntry[]): string {
	const instances = entries.filter(isInstance);
	const cells = entries
		.map((e) => (isInstance(e) ? `AI 服务商 ${labelOf(e, false)}` : labelOf(e, false)))
		.join("；");
	if (instances.length === 0) {
		return `[config] 核心设置有 ${entries.length} 格读不懂,先按默认值在跑,盘上原文没动:${cells}`;
	}
	return `[config] 核心设置有 ${entries.length} 处读不懂(坏的 AI 服务商先当它不在,别格先按默认值在跑),盘上原文没动:${cells}`;
}

/** `ai` 请别在面板上改的格被隔离:原文里若手写了明文 key,它没被上提、还留在文件里。 */
const AI_PLAINTEXT_NOTE =
	"[config] ai 的格被隔离了:那一格里如果手写了明文 key,它还留在 core.json 里(没进加密袋),改对那一格后下次开机才会上提;" +
	"别在面板里重存这一格:面板上显示的是默认值,保存会把这一格原来的内容(含手写的明文 key,整格 / 整张表的还有加密袋里存着的 key)一起换掉,请改文件再重启";

/** 单家被隔离:那一家里手写的明文 key 同理。 */
const INSTANCE_PLAINTEXT_NOTE =
	"[config] 有 AI 服务商被隔离了:这一家里如果手写了明文 key,它还留在 core.json 里(没进加密袋),改对之后下次开机才会上提";

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
	if (entries.some(isHandsOff)) logger.warn(AI_PLAINTEXT_NOTE);
	if (entries.some(isInstance)) logger.warn(INSTANCE_PLAINTEXT_NOTE);
	problems.report({ ...KEY, message: () => settingsInvalidMessage(entries) });
}
