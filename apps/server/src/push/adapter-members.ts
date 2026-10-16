import type { PlatformAdapter } from "@bilibili-notify/internal";

/**
 * `PlatformAdapter` 的全部成员名。`satisfies Record<keyof PlatformAdapter, true>` 把「接口多一个成员,
 * 这里要记得加」变成编译错 —— 视图、派生表、拓展包装、能力注入四处造「另一个适配器对象」都按这张表
 * 取成员,不再用对象展开(展开只带自有属性,class 写的适配器方法在原型上,会整个丢掉)。
 */
const ADAPTER_MEMBERS = {
	adapterKey: true,
	probe: true,
	start: true,
	stop: true,
	isAvailable: true,
	send: true,
	capabilities: true,
	probeCapabilities: true,
	settingsSchema: true,
	listConnectionCandidates: true,
	listAddressCandidates: true,
	connectionAuth: true,
} satisfies Record<keyof PlatformAdapter, true>;

const MEMBER_NAMES = Object.keys(ADAPTER_MEMBERS) as (keyof PlatformAdapter)[];

/**
 * 从一个适配器上按成员表取一份新对象,摘掉 `omit` 里的成员:函数成员一律 `bind` 回原对象
 * (class 写的方法吃 `this`,脱离实例调就丢状态),数据成员原样拷。原对象上没有的成员新对象上也没有
 * (可选方法有就有、没有就没有 —— 面板上「这个平台不支持」靠的正是方法不在)。
 *
 * 取的是**调用那一刻**的成员值;包装方想换掉某个成员,在返回值上覆盖即可(原来的已经 bind 好了,
 * 可以先读出来再覆盖)。
 */
export function pickAdapterMembers<
	S extends Partial<PlatformAdapter>,
	O extends keyof PlatformAdapter,
>(source: S, omit: readonly O[]): Omit<S, O> {
	const picked: Record<string, unknown> = {};
	for (const name of MEMBER_NAMES) {
		if ((omit as readonly string[]).includes(name)) continue;
		const value: unknown = source[name];
		if (value === undefined) continue;
		picked[name] = typeof value === "function" ? value.bind(source) : value;
	}
	return picked as Omit<S, O>;
}
