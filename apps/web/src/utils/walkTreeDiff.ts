/**
 * walkTreeDiff —— 递归对比两棵 plain-object 树,按叶子级别输出 FieldDiff[]。
 *
 * 设计契约:
 * - 数组当叶子整体比较,不递归 index。理由:dashboard 的 PATCH body 语义就是
 *   整数组替换(blockKeywords / quietHours / specialUsers 等),逐元素 diff 与
 *   后端语义不匹配,灵动岛 diff 行展示整个新旧数组更直观。
 * - plain object 才递归:`Object.getPrototypeOf(x) === Object.prototype`。Date /
 *   Map / 自定义类等当叶子比较(dashboard 配置树没有这些)。
 * - 路径用 "." 连接,与 FIELD_LABELS 的 dot-keys 对齐(`liveStreaming.streamingIntervalHours`)。
 * - leaf 相等用 Object.is(NaN === NaN; 0 !== -0,但配置树里不会出现 -0)。
 * - undefined 与 missing key 视为相同(无 diff);null 视作实义值,跟 undefined
 *   不等。理由:PATCH body 用 undefined 表示「不改」,null 表示「显式置空」,
 *   两者语义不同。
 * - 缺一边的字段:当 onlyOnLeft → newValue=undefined;onlyOnRight → oldValue
 *   =undefined。
 * - section 不在本函数内填,由调用方从 FIELD_LABELS lookup 后注入(本函数不
 *   耦合字典 — pure data 函数,好测好复用)。
 */

export interface FieldDiff {
	/** dot-path 字段路径(与 FIELD_LABELS key 对齐)。 */
	code: string;
	/** 旧值(baseline)。 */
	oldValue: unknown;
	/** 新值(draft)。 */
	newValue: unknown;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
	if (x === null || typeof x !== "object") return false;
	const proto = Object.getPrototypeOf(x);
	return proto === Object.prototype || proto === null;
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (!leafEqual(a[i], b[i])) return false;
	}
	return true;
}

/** 叶子比较:数组逐元素递归 leafEqual;plain object 直接 JSON.stringify 兜底
 * (本函数仅在「数组中的对象」场景被调用,不会无限递归)。其他走 Object.is。
 *
 * 已知 corner case(audit R3):数组元素里的对象走 JSON.stringify,会把
 * `{b:undefined}` 与 `{}` 视作相等(`JSON.stringify` 跳过 undefined),但主路径
 * 下 `{b:null}` vs `{b:undefined}` 视作不等。dashboard 配置树的数组元素从未
 * 出现过 undefined(全是 string 或浅对象如 {start,end} / {uid,kinds}),所以
 * 这种差异不会触发。若将来 schema 引入 nullable 字段在数组元素里,需要考虑
 * 替换为显式 walk 而非 JSON 兜底。 */
function leafEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) && Array.isArray(b)) return arraysEqual(a, b);
	if (isPlainObject(a) && isPlainObject(b)) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	return false;
}

export function walkTreeDiff(before: unknown, after: unknown, path = ""): FieldDiff[] {
	// 叶子层:任一侧非 plain object 就 leafEqual 比较 + 输出 diff(若不等)
	if (!isPlainObject(before) || !isPlainObject(after)) {
		// 双 undefined / 双 missing 走不到这里(顶层调用至少一侧是 object 才有意义),
		// 兜底:若一侧 undefined 而另一侧也 undefined,Object.is 命中无 diff
		if (leafEqual(before, after)) return [];
		// 注意:path === "" 表示顶层就是 leaf(不太可能,但兜底)
		return [{ code: path || "(root)", oldValue: before, newValue: after }];
	}

	const acc: FieldDiff[] = [];
	const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
	for (const k of keys) {
		const subPath = path ? `${path}.${k}` : k;
		const bv = before[k];
		const av = after[k];

		// 双 undefined / 一侧 missing 一侧 undefined:无 diff
		if (bv === undefined && av === undefined) continue;

		// 数组:叶子整体比较(不递归 index),无论一侧为非数组也走 leaf 路径
		if (Array.isArray(bv) || Array.isArray(av)) {
			if (!leafEqual(bv, av)) {
				acc.push({ code: subPath, oldValue: bv, newValue: av });
			}
			continue;
		}

		// 两侧都是 plain object → 递归
		if (isPlainObject(bv) && isPlainObject(av)) {
			acc.push(...walkTreeDiff(bv, av, subPath));
			continue;
		}

		// 一侧 plain object 一侧 leaf(包括 undefined / null / 标量):整体当 leaf
		// 对比。配置 schema 里这种情况通常发生在「from undefined → 整段对象」
		// (add per-UP override 时),用户视角期待看到「整段开启」而非展开成 N 条。
		if (!leafEqual(bv, av)) {
			acc.push({ code: subPath, oldValue: bv, newValue: av });
		}
	}
	return acc;
}
