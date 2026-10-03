/**
 * 守卫 13 前半:以特性键 / 附加项键 / 卡种做键的记录全部钉进迁移清单(`../keyed-records.ts`)。
 *
 * 两部分:
 * 1. 判定函数(`./keyed-record-finder.ts`)的样例 —— 判据本身也会写错,一条永远判 OK 的规则跟没有一样,所以先用样例
 *    钉住每种认法、每种包装和反例;
 * 2. 守卫本体:(a) 判定函数在四个存盘的根上找出来的 = 清单,两头都核;(b) 清单里归设置 / 订阅那一族的每一条,用冻住的
 *    0.x 词表摆满旧键、跑那一族的 1.0 步骤,核对出来的键;(c) 归某一片、还没做的条目逐条列出。
 *
 * 限制:
 * - 判定函数只看下面 `ROOTS` 登记的四个根。将来**多一个存盘的根**(新开一个仓、新存一份用这几套词表做键的数据),
 *   判定函数发现不了没登记的新仓,要自己把它的 schema 加进 `ROOTS`;
 * - 历史行今天那一格是 `kind`(推送种类 `PushKind`,自成一套词表),不在这几套里,判定函数找不到、清单也不写。⑬f 把它改成
 *   特性键的值以后,(a) 会自然要求补一条(那一格是 `z.enum` 当值用);
 * - 行为核对(b)只摆得进纯对象键的路径(没有 `[]` / `*`),遇到会直接抛,到时候扩展 `placeAt`。
 */

import {
	CardSkinManifestSchema,
	GlobalConfigSchema,
	HistoryEntrySchema,
	SubscriptionSchema,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { isPlainObject } from "../files.js";
import {
	KEYED_RECORD_ENTRIES,
	KEYED_VOCABULARIES,
	type KeyedRecordEntry,
	type KeyedRecordRoot,
	type KeyedVocabulary,
} from "../keyed-records.js";
import { ZERO_GLOBAL_LIVE_FACTS } from "../live-split.js";
import { migrateGlobalsToCurrent } from "../settings.js";
import { toCurrentRow } from "../subscriptions.js";
import { ZERO_EXTRA_KEYS, ZERO_FEATURE_KEYS } from "../zero-vocabulary.js";
import { findKeyedRecords, type Vocabulary } from "./keyed-record-finder.js";
import { makeZeroGlobals, zeroBiliRow, zeroExtensionRow } from "./zero-fixtures.js";

// ── 判定函数的样例 ──────────────────────────────────────────────────────────────

const COLORS: Vocabulary<"Color"> = { name: "Color", keys: ["red", "green", "blue"] };
const SIZES: Vocabulary<"Size"> = { name: "Size", keys: ["s", "m", "l"] };
/** 词表有包含关系:`Size` ⊂ `BigSize`。 */
const BIG_SIZES: Vocabulary<"BigSize"> = { name: "BigSize", keys: ["s", "m", "l", "xl"] };

const objectOf = (keys: readonly string[]) =>
	z.object(Object.fromEntries(keys.map((key) => [key, z.boolean()])));
const enumOf = (keys: readonly string[]) => z.enum(keys as [string, ...string[]]);
const colorsObject = () => objectOf(COLORS.keys);

function find(schema: z.ZodType) {
	return findKeyedRecords(schema, [COLORS, SIZES]);
}

describe("判定函数:认法", () => {
	it("object:形状键包含整套词表就算,多出别的键也算,路径用 . 连", () => {
		const schema = z.object({
			a: z.object({ b: z.object({ ...colorsObject().shape, extras: z.string() }) }),
		});
		expect(find(schema)).toEqual([{ path: "a.b", vocabulary: "Color" }]);
	});

	it("object:根自己命中时路径是空串", () => {
		expect(find(colorsObject())).toEqual([{ path: "", vocabulary: "Color" }]);
	});

	it("object:只重合一部分不算", () => {
		expect(find(z.object({ inner: objectOf(["red", "green"]) }))).toEqual([]);
	});

	it("record / partialRecord:键是枚举、取值集合等于词表才算", () => {
		const schema = z.object({
			full: z.record(enumOf(COLORS.keys), z.string()),
			partial: z.partialRecord(enumOf(SIZES.keys), z.string()),
		});
		expect(find(schema)).toEqual([
			{ path: "full", vocabulary: "Color" },
			{ path: "partial", vocabulary: "Size" },
		]);
	});

	it("record:取值不同、只是子集或超集、键是 string 都不算", () => {
		const schema = z.object({
			other: z.record(enumOf(["x", "y", "z"]), z.string()),
			subset: z.record(enumOf(["red", "green"]), z.string()),
			superset: z.record(enumOf(["red", "green", "blue", "alpha"]), z.string()),
			free: z.record(z.string(), z.string()),
		});
		expect(find(schema)).toEqual([]);
	});

	it("record:值里再嵌词表记录,路径经 *;键 schema 本身不会再报一遍枚举", () => {
		const schema = z.object({ byId: z.record(z.string(), colorsObject()) });
		expect(find(schema)).toEqual([{ path: "byId.*", vocabulary: "Color" }]);
		expect(find(z.object({ m: z.record(enumOf(COLORS.keys), colorsObject()) }))).toEqual([
			{ path: "m", vocabulary: "Color" },
			{ path: "m.*", vocabulary: "Color" },
		]);
	});

	it("enum:取值集合等于词表算「当值用」,与顺序无关;取值不同不算", () => {
		const schema = z.object({
			shuffled: enumOf(["blue", "red", "green"]),
			other: enumOf(["red", "green", "yellow"]),
			subset: enumOf(["red", "green"]),
		});
		expect(find(schema)).toEqual([{ path: "shuffled", vocabulary: "Color" }]);
	});

	it("数组元素用 []", () => {
		const schema = z.object({
			list: z.array(z.object({ pick: enumOf(COLORS.keys) })),
			grid: z.array(z.array(colorsObject())),
		});
		expect(find(schema)).toEqual([
			{ path: "list[].pick", vocabulary: "Color" },
			{ path: "grid[][]", vocabulary: "Color" },
		]);
	});

	it("一个对象同时含两套互不相干的词表:各报一条", () => {
		const schema = z.object({
			both: z.object({ ...colorsObject().shape, ...objectOf(SIZES.keys).shape }),
		});
		expect(find(schema)).toEqual([
			{ path: "both", vocabulary: "Color" },
			{ path: "both", vocabulary: "Size" },
		]);
	});

	it("词表有包含关系时,形状同时包含两套的对象只报最大的那套", () => {
		const schema = z.object({
			big: objectOf(BIG_SIZES.keys),
			small: objectOf(SIZES.keys),
		});
		expect(findKeyedRecords(schema, [SIZES, BIG_SIZES])).toEqual([
			{ path: "big", vocabulary: "BigSize" },
			{ path: "small", vocabulary: "Size" },
		]);
	});
});

describe("判定函数:穿透包装", () => {
	const inner = colorsObject();
	const full = { red: true, green: true, blue: true };
	const wrappers: Array<[string, z.ZodType]> = [
		["optional", inner.optional()],
		["nullable", inner.nullable()],
		["default", inner.default(full)],
		["prefault", inner.prefault(full)],
		["nonoptional", inner.optional().nonoptional()],
		["catch", inner.catch(full)],
		["readonly", inner.readonly()],
		["promise", z.promise(inner)],
		["success", z.success(inner)],
	];

	it.each(wrappers)("%s", (_name, wrapped) => {
		expect(find(z.object({ w: wrapped }))).toEqual([{ path: "w", vocabulary: "Color" }]);
	});

	it("transform / pipe / preprocess:两头都走", () => {
		const schema = z.object({
			transformed: inner.transform((value) => value),
			piped: z.string().pipe(enumOf(COLORS.keys)),
			preprocessed: z.preprocess((value) => value, inner),
		});
		expect(find(schema)).toEqual([
			{ path: "transformed", vocabulary: "Color" },
			{ path: "piped", vocabulary: "Color" },
			{ path: "preprocessed", vocabulary: "Color" },
		]);
	});

	it("refine / superRefine 不改节点形状", () => {
		const schema = z.object({
			refined: inner.refine(() => true),
			superRefined: inner.superRefine(() => {}),
		});
		expect(find(schema)).toEqual([
			{ path: "refined", vocabulary: "Color" },
			{ path: "superRefined", vocabulary: "Color" },
		]);
	});

	it("lazy 穿透;自引用的 schema 不会死循环,别的位置照样找得到", () => {
		const Tree: z.ZodType = z.object({
			colors: colorsObject(),
			kids: z.array(z.lazy(() => Tree)),
		});
		expect(find(z.object({ lazily: z.lazy(() => inner) }))).toEqual([
			{ path: "lazily", vocabulary: "Color" },
		]);
		expect(find(Tree)).toEqual([{ path: "colors", vocabulary: "Color" }]);
	});

	it("union 的各支都看(含 discriminatedUnion)", () => {
		const schema = z.object({
			plain: z.union([colorsObject(), enumOf(SIZES.keys), z.string()]),
			tagged: z.discriminatedUnion("kind", [
				z.object({ kind: z.literal("a"), colors: colorsObject() }),
				z.object({ kind: z.literal("b"), sizes: objectOf(SIZES.keys) }),
			]),
		});
		expect(find(schema)).toEqual([
			{ path: "plain", vocabulary: "Color" },
			{ path: "plain", vocabulary: "Size" },
			{ path: "tagged.colors", vocabulary: "Color" },
			{ path: "tagged.sizes", vocabulary: "Size" },
		]);
	});

	it("同一路径从两条通道到达只报一次", () => {
		// `pipe` 的两端、`union` 的两支都能走到同一个枚举。
		const schema = z.object({
			piped: z.string().pipe(enumOf(COLORS.keys)).pipe(enumOf(COLORS.keys)),
			either: z.union([enumOf(COLORS.keys), enumOf(COLORS.keys)]),
		});
		expect(find(schema)).toEqual([
			{ path: "piped", vocabulary: "Color" },
			{ path: "either", vocabulary: "Color" },
		]);
	});

	it("认不得的节点类型直接抛:宁可红,也不静默漏", () => {
		const schema = z.object({ pair: z.tuple([z.string(), z.string()]) });
		expect(() => find(schema)).toThrow(/tuple.*pair/);
	});
});

// ── 守卫 ────────────────────────────────────────────────────────────────────────

const ROOTS = {
	GlobalConfig: GlobalConfigSchema,
	Subscription: SubscriptionSchema,
	HistoryEntry: HistoryEntrySchema,
	CardSkinManifest: CardSkinManifestSchema,
} satisfies Record<KeyedRecordRoot, z.ZodType>;

const VOCABULARIES = (Object.keys(KEYED_VOCABULARIES) as KeyedVocabulary[]).map(
	(name): Vocabulary<KeyedVocabulary> => ({ name, keys: KEYED_VOCABULARIES[name] }),
);

const lineOf = ({
	root,
	path,
	vocabulary,
}: Pick<KeyedRecordEntry, "root" | "path" | "vocabulary">) =>
	`${root} ${path || "<根>"} [${vocabulary}]`;

/** 判定函数在四个根上找出来的,一条一行。 */
function foundLines(): string[] {
	return (Object.entries(ROOTS) as Array<[KeyedRecordRoot, z.ZodType]>).flatMap(([root, schema]) =>
		findKeyedRecords(schema, VOCABULARIES).map(({ path, vocabulary }) =>
			lineOf({ root, path, vocabulary }),
		),
	);
}

describe("守卫 13 前半:以特性键 / 附加项键 / 卡种做键的记录都在迁移清单里", () => {
	it("判定函数在四个根上找出来的 = 清单,两头都核", () => {
		const found = foundLines();
		const listed = KEYED_RECORD_ENTRIES.map(lineOf);
		expect({
			"schema 里有、清单没登记": found.filter((line) => !listed.includes(line)),
			"清单里有、schema 里找不到": listed.filter((line) => !found.includes(line)),
		}).toEqual({ "schema 里有、清单没登记": [], "清单里有、schema 里找不到": [] });
	});

	it("清单里没有重复条目", () => {
		const listed = KEYED_RECORD_ENTRIES.map(lineOf);
		expect(listed.filter((line, i) => listed.indexOf(line) !== i)).toEqual([]);
	});
});

// ── (b) 行为核对 ────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

/** 冻住的 0.x 词表。归设置 / 订阅的条目必须在这里有一份旧的;没有(如卡种)说明那一条还轮不到行为核对。 */
const ZERO_VOCABULARIES: Partial<Record<KeyedVocabulary, readonly string[]>> = {
	FeatureKey: ZERO_FEATURE_KEYS,
	ExtraKey: ZERO_EXTRA_KEYS,
};

const SUB_ID = "33333333-3333-4333-8333-333333333333";

interface Family {
	/** 这一族的条目所在的根。 */
	root: KeyedRecordRoot;
	/** 能跑的 0.x 输入(每次现造,用例会就地改它)。 */
	inputs(): Array<[label: string, input: Obj]>;
	/** 跑这一族的 1.0 步骤 —— 迁移自己用的那一条,不是守卫另拼的一串。 */
	run(input: Obj): unknown;
}

const FAMILIES: Record<"settings" | "subscription", Family> = {
	settings: {
		root: "GlobalConfig",
		inputs: () => [["设置", makeZeroGlobals()]],
		run: migrateGlobalsToCurrent,
	},
	subscription: {
		root: "Subscription",
		inputs: () => [
			["B 站订阅", zeroBiliRow({ id: SUB_ID, uid: "123" })],
			["拓展订阅", zeroExtensionRow({ id: SUB_ID, extensionId: "demo", externalId: "x" })],
		],
		run: (row) => toCurrentRow(row, ZERO_GLOBAL_LIVE_FACTS),
	},
};

function segmentsOf(path: string): string[] {
	if (/\[\]|\*/.test(path)) {
		throw new Error(`行为核对摆不进路径 ${path}:里面有数组元素或 record 的值,先扩展 placeAt`);
	}
	return path.split(".");
}

function getAt(value: unknown, path: string): unknown {
	let cursor = value;
	for (const segment of segmentsOf(path)) {
		if (!isPlainObject(cursor)) return undefined;
		cursor = cursor[segment];
	}
	return cursor;
}

/** 在 `path` 上摆一个对象:缺的中间层补成空对象,那一格上原有的别的键留着,`fill` 的键盖上去。 */
function placeAt(base: Obj, path: string, fill: Obj): void {
	const segments = segmentsOf(path);
	let cursor = base;
	for (const segment of segments.slice(0, -1)) {
		const next = cursor[segment];
		if (isPlainObject(next)) cursor = next;
		else cursor = cursor[segment] = {};
	}
	const last = segments[segments.length - 1] as string;
	const existing = cursor[last];
	cursor[last] = { ...(isPlainObject(existing) ? existing : {}), ...fill };
}

/** 每个 0.x 键放一个独一无二的值:迁完在哪个新键里找得到它,就说明那个键「有对应的新键」。 */
const markerOf = (zeroKey: string) => `ZERO:${zeroKey}`;

function migratedKeysProblems(entry: KeyedRecordEntry, family: Family, input: Obj) {
	const { handledBy } = entry;
	if (handledBy.kind === "pending") throw new Error("pending 的条目不做行为核对");
	const zeroPath = handledBy.zeroPath ?? entry.path;
	const live = KEYED_VOCABULARIES[entry.vocabulary];
	const zero = ZERO_VOCABULARIES[entry.vocabulary];
	if (!zero) {
		throw new Error(
			`${entry.vocabulary} 没有冻住的 0.x 词表:到 zero-vocabulary.ts 补一份,再登记进 ZERO_VOCABULARIES`,
		);
	}
	const retired = zero.filter((key) => !live.includes(key));

	// 那一格上 0.x 本来就带的、不属于词表的键(如特性开关旁边的 `extras`)留着,不算「不认识」。
	const before = getAt(input, zeroPath);
	const companions = isPlainObject(before)
		? Object.keys(before).filter((k) => !zero.includes(k))
		: [];
	// 值用数组:直播拆键只认数组形的目标表,这样 `routing.liveStart` 的拷贝也会真跑。
	placeAt(input, zeroPath, Object.fromEntries(zero.map((key) => [key, [markerOf(key)]])));

	const migrated = family.run(input);
	const out = getAt(migrated, entry.path);
	if (!isPlainObject(out)) {
		return { 迁完这一格不是对象: [`${entry.path}: ${JSON.stringify(out)}`] };
	}
	const outKeys = Object.keys(out);
	// 只认活词表里的键:值还留在旧键下面,不算「有对应的新键」。
	const carriesMarker = (key: string) =>
		Object.entries(out).some(
			([outKey, value]) =>
				live.includes(outKey) && Array.isArray(value) && value.includes(markerOf(key)),
		);
	return {
		出来的键不在活词表里: outKeys.filter(
			(key) => !live.includes(key) && !companions.includes(key) && !retired.includes(key),
		),
		"0.x 的旧键还在": outKeys.filter((key) => retired.includes(key)),
		"0.x 的键没有对应的新键(值没落进活词表里的键)": zero.filter((key) => !carriesMarker(key)),
		"0.x 的旧路径还留着":
			zeroPath !== entry.path && getAt(migrated, zeroPath) !== undefined ? [zeroPath] : [],
	};
}

const NO_PROBLEMS = {
	出来的键不在活词表里: [],
	"0.x 的旧键还在": [],
	"0.x 的键没有对应的新键(值没落进活词表里的键)": [],
	"0.x 的旧路径还留着": [],
};

describe("守卫 13 前半 (b):归设置 / 订阅那一族的记录,0.x 的旧键迁完一个不剩", () => {
	const handled = KEYED_RECORD_ENTRIES.filter((entry) => entry.handledBy.kind !== "pending");

	it("两族各有条目(免得过滤写错、一条用例都没跑)", () => {
		expect(new Set(handled.map((entry) => entry.handledBy.kind))).toEqual(
			new Set(["settings", "subscription"]),
		);
	});

	for (const entry of handled) {
		const kind = entry.handledBy.kind as "settings" | "subscription";
		const family = FAMILIES[kind];
		for (const [label, input] of family.inputs()) {
			it(`${lineOf(entry)}(${label})`, () => {
				expect(entry.root, "条目归的那一族和它所在的根对不上").toBe(family.root);
				expect(migratedKeysProblems(entry, family, input)).toEqual(NO_PROBLEMS);
			});
		}
	}
});

// ── (c) 归某一片、还没做 ────────────────────────────────────────────────────────

describe("守卫 13 前半 (c):归某一片、还没做的条目", () => {
	it("逐条列出来、标明归哪一片;那一片落地时把条目挪去设置 / 订阅那一族(或删掉),再改这里", () => {
		const pending = KEYED_RECORD_ENTRIES.flatMap((entry) =>
			entry.handledBy.kind === "pending" ? [`${lineOf(entry)} → ${entry.handledBy.slice}`] : [],
		);
		expect(pending).toEqual([
			"GlobalConfig defaults.cardStyleByKind [CardKind] → ㉔",
			"Subscription overrides.cardStyleByKind [CardKind] → ㉔",
			"CardSkinManifest variablesByKind [CardSkinKind] → ㉔",
			"CardSkinManifest cards [CardSkinKind] → ㉔",
		]);
	});
});
