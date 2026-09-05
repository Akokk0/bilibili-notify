/**
 * 有容量上限的「最近碰过」表。
 *
 * Map 按插入序遍历,每次 set 先 delete 再 set,最久没碰的永远在最前 —— 满了就丢它。
 * 容量是上限不是触发点:满了照样能装,只是装一个丢一个。
 *
 * 两处在用:链接解析的冷却表 / 群额度表(谁都能触发,不能越涨越慢),历史仓「还能被
 * 追加的行」(一行只在一次推送的生命周期里开着,留个上限兜住长跑实例)。
 */
export class RecencyTable<V> {
	private readonly map = new Map<string, V>();
	constructor(private readonly cap: number) {}
	get(key: string): V | undefined {
		return this.map.get(key);
	}
	set(key: string, value: V): void {
		this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > this.cap) {
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) this.map.delete(oldest);
		}
	}
}
