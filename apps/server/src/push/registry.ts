import type { Disposable, PlatformAdapter } from "@bilibili-notify/internal";

/**
 * 推送出口的**活注册表** —— adapter 矩阵的家(ADR-0012 决策 29)。
 *
 * 从前这是一个开机拼好的数组。拓展是后加载的、而且要能被拨开关加载 / 卸载,定死的数组
 * 两件事都干不了:两段式装配(先加载拓展再拼数组)会把「启用 / 停用不重启」作废,而往一个
 * 共享数组里 push 有一颗**只在开发版炸**的雷 —— dev 下拿到的是 devtools 包过一层的**另一
 * 份**,往原数组 push 的话开发版里根本看不见,两边都不报错。
 */
export interface PlatformAdapterRegistry {
	/**
	 * 注册一个出口,回一个撤下它的把手。
	 *
	 * 它认领的每一个分发键都得是空的,**占了就抛**:悄悄顶掉等于把别人的连接整个截走
	 * (一个拓展要是能声明 `"onebot"`,内置那条连接的推送就全走它了),而两边都不报错。
	 */
	register(adapter: PlatformAdapter): Disposable;
	/**
	 * 现在有哪些出口。
	 *
	 * 🔴 **在分发那一刻问**,别把结果存下来 —— 存一份就等于回到那个开机拼好的数组,
	 * 后注册的拓展对它永远不存在。
	 */
	list(): readonly PlatformAdapterView[];
}

/**
 * 登记表对外给的出口视图:**不含 `send`**,运行时也真的没有。
 *
 * 发送只许经 `TargetDispatcher`(出口咽喉,ADR-0024 决策 13);其余消费方(重连、销毁、
 * 能力探测)用不着它,也就拿不到它。同一个适配器每次 `list()` 回同一个视图对象。
 */
export type PlatformAdapterView = Omit<PlatformAdapter, "send">;

/** 登记表 → 带 `send` 的完整适配器。只有 {@link sendableAdapters} 能读;视图对外,这份不外露。 */
const fullListOf = new WeakMap<PlatformAdapterRegistry, () => readonly PlatformAdapter[]>();

/**
 * 带 `send` 的完整适配器 —— **全仓只许 `push/target-dispatcher.ts` 引它**(出口咽喉的守卫钉着)。
 * 同样在分发那一刻问,别存下来。
 */
export function sendableAdapters(registry: PlatformAdapterRegistry): readonly PlatformAdapter[] {
	const full = fullListOf.get(registry);
	if (!full) throw new Error("registry was not created by createPlatformAdapterRegistry");
	return full();
}

/** 摘掉 `send`。展开而不是逐个转发:可选方法有就有、没有就没有(同 devtools 的装饰器)。 */
function viewOf(adapter: PlatformAdapter): PlatformAdapterView {
	const { send: _send, ...view } = adapter;
	return view;
}

export function createPlatformAdapterRegistry(
	initial: readonly PlatformAdapter[] = [],
): PlatformAdapterRegistry {
	const adapters: PlatformAdapter[] = [];
	const keys = new Set<string>();

	function add(adapter: PlatformAdapter): void {
		for (const key of adapter.platforms) {
			if (keys.has(key)) throw new Error(`adapter for dispatch key "${key}" is already registered`);
		}
		for (const key of adapter.platforms) keys.add(key);
		adapters.push(adapter);
	}

	for (const adapter of initial) add(adapter);

	// 每个适配器只做一次视图:`list()` 在热路径上被反复问,而且两次问到的得是同一个对象。
	const views = new WeakMap<PlatformAdapter, PlatformAdapterView>();
	const viewFor = (adapter: PlatformAdapter): PlatformAdapterView => {
		let view = views.get(adapter);
		if (!view) {
			view = viewOf(adapter);
			views.set(adapter, view);
		}
		return view;
	};

	const registry: PlatformAdapterRegistry = {
		list: () => adapters.map(viewFor),
		register(adapter) {
			add(adapter);
			let removed = false;
			return {
				dispose() {
					if (removed) return;
					removed = true;
					const idx = adapters.indexOf(adapter);
					if (idx >= 0) adapters.splice(idx, 1);
					for (const key of adapter.platforms) keys.delete(key);
				},
			};
		},
	};
	fullListOf.set(registry, () => adapters);
	return registry;
}

/**
 * 在一张登记表上**派生**一张:注册转交给原表,`list()` 与派发器拿到的完整适配器都在问的那一刻
 * 按 `decorate` 现包(devtools 往出口上套能力注入就走这里)。
 *
 * 是个视图不是拷贝:拓展后注册进来的出口在派生表上照样看得见 —— 拷一份的话,开发版里它根本不存在,
 * 而生产是好的(ADR-0012 决策 29)。`decorate` 只见得到不含 `send` 的视图;派生出来的完整适配器
 * 用的是原来那个 `send`。包好的按原对象各记一份,同一个出口两次问到的是同一个对象。
 */
export function deriveAdapterRegistry(
	base: PlatformAdapterRegistry,
	decorate: (view: PlatformAdapterView) => PlatformAdapterView,
): PlatformAdapterRegistry {
	const decorated = new WeakMap<PlatformAdapterView, PlatformAdapterView>();
	const decoratedOf = (view: PlatformAdapterView): PlatformAdapterView => {
		let next = decorated.get(view);
		if (!next) {
			next = decorate(view);
			decorated.set(view, next);
		}
		return next;
	};
	const sendable = new WeakMap<PlatformAdapter, PlatformAdapter>();
	const derived: PlatformAdapterRegistry = {
		register: (adapter) => base.register(adapter),
		list: () => base.list().map(decoratedOf),
	};
	fullListOf.set(derived, () => {
		// 原表的完整表与视图表是同一时刻从同一个数组出的,顺序一一对应。
		const views = base.list();
		return sendableAdapters(base).map((full, i) => {
			let made = sendable.get(full);
			if (!made) {
				const view = views[i];
				if (!view) throw new Error("adapter registry views out of step with full adapters");
				made = { ...decoratedOf(view), send: full.send };
				sendable.set(full, made);
			}
			return made;
		});
	});
	return derived;
}
