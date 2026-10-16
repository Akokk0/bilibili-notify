import type { Json } from "@bilibili-notify/internal";

/**
 * 日志按值打码的登记册(ADR-0025 决策 9)。
 *
 * 各集成手上的密钥值(`secrets` 里每一段字符串、cookie 罐里每条 cookie 的值)一到手就登记进来,
 * 日志出口(`runtime/service-context.ts` 的 `emit`)先按登记的值把它们遮掉、再跑固定形状的那几条正则:
 * 不管值出现在 msg、字符串参数、对象参数还是 `Error` 里,也不管前面是不是写着 `SESSDATA=`。
 * 核心因此不再需要知道任何一家平台的 cookie 叫什么。
 *
 * - 登记按「集成 + 种类」分:`replace` 是**整批换**(`secrets` 一份、cookie 罐一份),换走的旧值不再遮;
 *   集成停下时 `clear` 掉它名下的。
 * - 少于 {@link MIN_REDACTED_LENGTH} 个字符的值不遮:太短的值(`"1"`、`"abc"`)几乎一定是普通文本的一部分,
 *   遮了日志就没法看。登录账号自己的 uid 不豁免 —— 它是 cookie 值,够长就照遮(字符串里按子串遮,
 *   参数里的数字按整值相等遮,见 {@link ValueRedactor.has})。
 * - 全在内存,不落盘。
 */

/** 少于这么多个字符的值不遮。 */
export const MIN_REDACTED_LENGTH = 8;

const MASK = "***";

export interface ValueRedactor {
	/** 把这个集成名下这一种登记的值整批换成 `values`(旧的不再遮;不够长的跳过)。 */
	replace(integrationKey: string, kind: string, values: Iterable<string>): void;
	/** 撤掉这个集成名下的登记:给了种类只撤那一种,不给撤全部。 */
	clear(integrationKey: string, kind?: string): void;
	/**
	 * 把登记过的值遮成 `***`;一个都没登记就原样返回。几个值互相重叠或包含时,命中的区间先合并再一次替换,
	 * 不会剩半截。
	 */
	scrub(text: string): string;
	/** `text` 整个就是某个登记过的值(给数字形态的参数用:十进制串恰好等于登记的值,只比整值,不比子串)。 */
	has(text: string): boolean;
}

export function createValueRedactor(): ValueRedactor {
	/** 集成 → 种类 → 值。 */
	const registered = new Map<string, Map<string, Set<string>>>();
	/** 所有登记的值(去重)。变一次重算一次。 */
	let all: Set<string> | undefined;

	function values(): Set<string> {
		if (all) return all;
		all = new Set();
		for (const kinds of registered.values()) {
			for (const set of kinds.values()) for (const value of set) all.add(value);
		}
		return all;
	}

	return {
		replace(integrationKey, kind, incoming) {
			const kept = new Set<string>();
			for (const value of incoming) if (value.length >= MIN_REDACTED_LENGTH) kept.add(value);
			let kinds = registered.get(integrationKey);
			if (kept.size === 0) {
				kinds?.delete(kind);
				if (kinds?.size === 0) registered.delete(integrationKey);
			} else {
				if (!kinds) {
					kinds = new Map();
					registered.set(integrationKey, kinds);
				}
				kinds.set(kind, kept);
			}
			all = undefined;
		},
		clear(integrationKey, kind) {
			if (kind === undefined) registered.delete(integrationKey);
			else {
				const kinds = registered.get(integrationKey);
				kinds?.delete(kind);
				if (kinds?.size === 0) registered.delete(integrationKey);
			}
			all = undefined;
		},
		scrub(text) {
			// 先在原文上找出每个值的所有命中区间(同一个值自己重叠的也找),再合并重叠的、一次替换:
			// 逐个值替换会让先遮的把后一个打断,剩半截。
			const hits: Array<[start: number, end: number]> = [];
			for (const needle of values()) {
				for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
					hits.push([at, at + needle.length]);
				}
			}
			if (hits.length === 0) return text;
			hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
			let out = "";
			let cursor = 0;
			let [start, end] = hits[0] as [number, number];
			const flush = (): void => {
				out += text.slice(cursor, start) + MASK;
				cursor = end;
			};
			for (const [s, e] of hits.slice(1)) {
				if (s < end) {
					if (e > end) end = e;
					continue;
				}
				flush();
				start = s;
				end = e;
			}
			flush();
			return out + text.slice(cursor);
		},
		has: (text) => values().has(text),
	};
}

/** 一个 JSON 值里的每一段字符串(递归走数组与对象;键名、数字、布尔、null 不收)。 */
export function stringLeaves(value: Json): string[] {
	if (typeof value === "string") return [value];
	if (value === null || typeof value !== "object") return [];
	const leaves: string[] = [];
	for (const inner of Array.isArray(value) ? value : Object.values(value)) {
		leaves.push(...stringLeaves(inner));
	}
	return leaves;
}
