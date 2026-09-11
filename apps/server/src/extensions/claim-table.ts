/**
 * 按 id **认领**一件东西的小表 —— HTTP 挂载点与 WS upgrade 分发用的是同一张。
 *
 * 三条规矩合起来才成立,而它们全是「不这么写就静默出错」的那种:
 * ① **一个 id 一个主人** —— 已经有人认领就抛:两个主人的分发没法讲道理;
 * ② **撤下只撤自己那一行** —— 重挂过之后 dispose 一个**旧**把手,不该把新主人踢掉
 *    (停用 → 启用之间那一瞬正是这个形状);
 * ③ 撤下之后可以**重来** —— 拨开关即热装卸走的就是这条。
 *
 * 两处各写一份的话,哪天只在一处补了 ②,另一处的症状是「拨一下开关,那个拓展的
 * WS 就再也连不上了」,而没有任何一行报错。
 */
export interface ClaimTable<T> {
	/** 现在谁认领着这个 id。没人 = `undefined`:没装 / 没启用 / 刚被撤下都长这样。 */
	get(id: string): T | undefined;
	/** 认领一个 id;已经有主人时抛(那句话由建表时交的 `taken` 写)。 */
	claim(id: string, value: T): { dispose(): void };
}

/** @param taken 已经有主人时那句异常 —— 每张表的说法不一样,由调用方给。 */
export function createClaimTable<T>(taken: (id: string) => string): ClaimTable<T> {
	const table = new Map<string, T>();
	return {
		get: (id) => table.get(id),
		claim(id, value) {
			if (table.has(id)) throw new Error(taken(id));
			table.set(id, value);
			return {
				dispose() {
					if (table.get(id) === value) table.delete(id);
				},
			};
		},
	};
}
