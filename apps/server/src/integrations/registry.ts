/**
 * 登记表:按键**认领**一件东西。集成(B 站、内置平台适配器、拓展)把自己的实现登进各张表,核心按键来查
 * (ADR-0025 决策 1)。用它的有拓展的 HTTP 挂载点与 WS upgrade 分发、订阅来源登记表;平台适配器那张表
 * 随它的第一个实现者建(3a)。要列全表(`entries()`)的读者今天只有会员档位读口。
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
export interface Registry<T> {
	/** 现在谁认领着这个 id。没人 = `undefined`:没装 / 没启用 / 刚被撤下都长这样。 */
	get(id: string): T | undefined;
	/** 认领一个 id;已经有主人时抛(那句话由建表时交的 `taken` 写)。 */
	claim(id: string, value: T): { dispose(): void };
	/** 全表,按认领先后(撤了的不在;撤了重登的排到最后)。要列全表的读者(会员档位读口)用它。 */
	entries(): Iterable<[string, T]>;
}

/** @param taken 已经有主人时那句异常 —— 每张表的说法不一样,由调用方给。 */
export function createRegistry<T>(taken: (id: string) => string): Registry<T> {
	const table = new Map<string, T>();
	return {
		get: (id) => table.get(id),
		entries: () => table.entries(),
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
