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
	/**
	 * 每个方法名一份**稳定的**包装:取几次都是同一个函数,盖着 / 没盖 / 摘掉都一样 ——
	 * 引擎里拿方法当 key、或者构造时就把 `this.api.foo` 存下来的地方,靠的就是这条。
	 * 盖没盖是包装在**调用时**去查的,不烤在取出来的那一刻;否则先存了引用、后来才盖的
	 * 场景永远打不到那份引用。
	 *
	 * 记住包装对应的是哪份真方法:真对象上的方法被换掉了(测试里 mock、热替换),缓存跟着换,
	 * 不然会一直回旧的那份绑定。
	 */
	const wrappers = new Map<PropertyKey, { fn: AnyFn; wrapper: AnyFn }>();

	function wrapperFor(prop: PropertyKey, fn: AnyFn): AnyFn {
		const hit = wrappers.get(prop);
		if (hit && hit.fn === fn) return hit.wrapper;
		const realFn = fn.bind(real);
		const wrapper: AnyFn = (...args: unknown[]) => {
			const fake = overrides.get(prop);
			return fake ? fake(realFn, ...args) : realFn(...args);
		};
		wrappers.set(prop, { fn, wrapper });
		return wrapper;
	}

	const api = new Proxy(real, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return wrapperFor(prop, value as AnyFn);
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
