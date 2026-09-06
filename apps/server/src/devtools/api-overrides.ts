/**
 * 传给引擎的 `api` 外面套的一层 Proxy —— devtools 想让某个方法说谎时按方法名盖一下。
 *
 * 引擎拿到的是这个 Proxy,从头到尾不知道有这一层:没盖的方法原样透传,并且 **`this` 绑回
 * 真对象**(BilibiliAPI 是个类,方法里到处是 `this.`,裸取出来再调就丢了);盖了的方法拿到
 * 「真实现」作第一个参数,好在真结果上打补丁(假直播就是真房间信息 + `live_status: 1`),
 * 而不是从头编一份。
 *
 * 为什么是 Proxy 不是子类:引擎要的是「同一个对象」——ContentBuilder / 链接解析 / 卡片
 * 预览拿的都是它,子类得把上百个方法转发一遍,漏一个就是运行期 undefined。
 */

// biome-ignore lint/suspicious/noExplicitAny: 方法表按名字索引,参数形状由各方法自己说
type AnyFn = (...args: any[]) => any;
type MethodNames<T> = { [K in keyof T]: T[K] extends AnyFn ? K : never }[keyof T];

/** 盖上去的实现:第一个参数是绑好 `this` 的真实现,后面是原参数。 */
export type Override<T, K extends MethodNames<T>> = T[K] extends AnyFn
	? (real: T[K], ...args: Parameters<T[K]>) => ReturnType<T[K]>
	: never;

export interface OverridableApi<T extends object> {
	/** 交给引擎的那份。 */
	api: T;
	override<K extends MethodNames<T>>(method: K, impl: Override<T, K>): void;
	clear(method: MethodNames<T>): void;
	clearAll(): void;
}

export function overridableApi<T extends object>(real: T): OverridableApi<T> {
	const overrides = new Map<PropertyKey, AnyFn>();
	// 绑过的真方法记一份:每次 get 都新 bind 会让 `api.foo !== api.foo`,拿方法当 key 的会炸。
	const bound = new Map<PropertyKey, AnyFn>();

	function boundReal(prop: PropertyKey, fn: AnyFn): AnyFn {
		let b = bound.get(prop);
		if (!b) {
			b = fn.bind(real);
			bound.set(prop, b);
		}
		return b;
	}

	const api = new Proxy(real, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			const realFn = boundReal(prop, value as AnyFn);
			const fake = overrides.get(prop);
			return fake ? (...args: unknown[]) => fake(realFn, ...args) : realFn;
		},
	});

	return {
		api,
		override(method, impl) {
			overrides.set(method, impl as AnyFn);
		},
		clear(method) {
			overrides.delete(method);
		},
		clearAll() {
			overrides.clear();
		},
	};
}
