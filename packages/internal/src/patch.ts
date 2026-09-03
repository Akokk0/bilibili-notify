/**
 * 配置 PATCH 线格式构造 —— **所有前端保存路径都必须经这里**。
 *
 * 纯函数模块,必须保持**零 import、零副作用**:它经
 * `@bilibili-notify/internal/patch` 子路径直供浏览器端(apps/web)
 * 运行时消费,不能把 zod 或任何 schema 模块拽进前端 bundle(同 `constants.ts`)。
 *
 * ## 为什么必须有这个东西
 *
 * 配置 PATCH 是 JSON Merge Patch(RFC 7386)语义,服务端 `config/store.ts` 的
 * deepMerge 实现了它:
 *
 * - **键不出现** = 「这个字段我没意见,别动」
 * - **显式 `null`** = 「删掉它」
 * - 其余 = 「设成这个值」
 *
 * 于是「关掉一个覆盖」在前端通常是把键从对象里删掉,可那样发出去等于**什么都
 * 没说** —— 请求 200、界面看着像保存成功,服务端却原样留着旧值,刷新回来开关又
 * 是开的。用户报的就是一句「关不掉」。
 *
 * 这个坑在本仓库反复复发过(卡片 per-kind 样式、模块日志等级、UP 名称/备注、
 * userAgent、master.targetId……),原因不是谁粗心,而是**每条保存路径各自手写
 * payload**:只要有人新写一条,就得重新记起这条语义。所以别再手写了 —— 挑好要
 * 下发的 scope,剩下的交给 {@link buildPatch}:它递归对比草稿与基线,任意深度上
 * 「草稿里没了而基线里有」的键都会自动变成显式 `null`。
 *
 * ## 用法
 *
 * ```ts
 * // 只下发本页真正编辑的 scope(下发全量会触发服务端的 enable-check 探针)
 * await api.patch("/api/globals", buildPatch(
 *   { defaults: { filters: draft.defaults.filters } },
 *   { defaults: { filters: base.defaults.filters } },
 * ));
 * ```
 */

/** 深度可空:任意层级的键都可能是 `null`(删除哨兵);数组整体当叶子。 */
export type DeepPatch<T> = T extends readonly unknown[]
	? T | null
	: T extends object
		? { [K in keyof T]?: DeepPatch<T[K]> | null }
		: T | null;

function isPlainObject(x: unknown): x is Record<string, unknown> {
	if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
	const proto = Object.getPrototypeOf(x);
	return proto === Object.prototype || proto === null;
}

/**
 * 递归 diff。两边都是 plain object 才往下走,其余(标量 / 数组 / 类型不对齐)一律
 * 整体当叶子 —— 数组不做逐元素 diff,服务端对数组也是整体替换。
 *
 * 值没变也照样下发,**不做「相同就省略」的优化**:省略等于「不改」,语义上确实
 * 等价,但一旦哪天 diff 判等出错就会变成静默丢改动。宁可多发几个字节。
 */
function diff(baseline: unknown, draft: unknown): unknown {
	// 草稿里没了:基线里有就发删除哨兵,基线里本来也没有就压根不提。
	if (draft === undefined) return baseline === undefined ? undefined : null;
	if (isPlainObject(baseline) && isPlainObject(draft)) {
		const out: Record<string, unknown> = {};
		for (const k of new Set([...Object.keys(baseline), ...Object.keys(draft)])) {
			const d = diff(baseline[k], draft[k]);
			if (d !== undefined) out[k] = d;
		}
		return out;
	}
	return draft;
}

/**
 * 把「草稿 vs 基线」编译成 PATCH 线格式:草稿里消失的键 → 显式 `null`,其余原样。
 *
 * `baseline` 必须是**服务端当前那一份**(GET 回来的值),不能拿草稿的初始快照凑数
 * —— 判断「这个键是不是被删了」靠的就是它。
 */
export function buildPatch<T extends object>(draft: T, baseline: T): DeepPatch<T> {
	return diff(baseline, draft) as DeepPatch<T>;
}
