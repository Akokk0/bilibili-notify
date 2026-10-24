/**
 * 从拓展交上来的对象上**按成员名表**取一份新对象:函数成员一律 `bind` 回原对象(class 写的方法吃 `this`,
 * 脱离实例调就丢状态),数据成员原样拷;原对象上没有(或是 `undefined`)的成员新对象上也没有。
 *
 * 为什么按表取而不是展开:展开只带自有属性,class 写的拓展方法在原型上会整个丢掉;而且表之外的成员
 * (没对拓展开放的口)带了也不该活 —— 契约的宽度是不可逆的。推送适配器(`push/adapter-members.ts`)与订阅源
 * (`extensions/extension-source.ts`)各有各的成员表,取法共用这一处。
 *
 * 取的是**调用那一刻**的成员值。
 */
export function pickBoundMembers(
	source: object,
	names: readonly string[],
): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	for (const name of names) {
		const value: unknown = (source as Record<string, unknown>)[name];
		if (value === undefined) continue;
		picked[name] = typeof value === "function" ? value.bind(source) : value;
	}
	return picked;
}
