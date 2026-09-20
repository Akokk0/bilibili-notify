/**
 * 「这坨东西是不是一个普通对象」——**只此一份**。
 *
 * 判据带原型检查:`JSON.parse` 出来的一定落在 `Object.prototype`(或 `null`)上,而数组、
 * `Date`、类实例都不是我们要往里递归合并的东西。从前站内各处自己写,写出了两种判据
 * (查不查原型链),而它们判的都是同一件事 —— 迁移与 patch 合并对同一坨老数据给不同
 * 答案,两边都不会红。
 *
 * ⚠️ **刻意不进 `util/index.ts`**:根入口有 `export * from "./util"`,挂进桶里就等于把一个
 * 内部判据变成 `@bilibili-notify/internal` 的对外 API。用的人从这条子路径直接 import。
 *
 * ⛔ **`patch.ts` 与 `template-defaults.ts` 那两份不共用这里**,各自留着自己的一份:那两个
 * 模块经子路径直供浏览器端,头上明写「必须保持**零 import**、零副作用」。为了省一份 15 行
 * 的判据去破那条约束不划算 —— 它们判的东西与这里逐字相同,改一处记得改那两处。
 */
export function isPlainObject(x: unknown): x is Record<string, unknown> {
	if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
	const proto = Object.getPrototypeOf(x);
	return proto === Object.prototype || proto === null;
}
