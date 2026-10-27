import type {
	Disposable,
	PlatformAdapter,
	PlatformAdapterContext,
} from "@bilibili-notify/internal";
import { stopQuietly } from "../integrations/stop-quietly.js";
import { errorMessageOf } from "../util/error-message.js";
import { pickAdapterMembers } from "./adapter-members.js";

/**
 * 推送出口的**活注册表** —— adapter 矩阵的家(ADR-0012 决策 29)。
 *
 * 从前这是一个开机拼好的数组。拓展是后加载的、而且要能被拨开关加载 / 卸载,定死的数组
 * 两件事都干不了:两段式装配(先加载拓展再拼数组)会把「启用 / 停用不重启」作废,而把
 * 某一刻的结果存下来的消费方,后注册的拓展对它永远不存在 —— 两边都不报错。
 */
export interface PlatformAdapterRegistry {
	/**
	 * 注册一个出口并启动它(`adapter.start(ctx)`),回一个撤下它的把手;把手 `dispose()` 摘掉它、
	 * 放键,再调 `adapter.stop()`(不等它;抛了 / 失败了用 `ctx.logger.warn` 记一行,不往外抛)。
	 * `start` 抛了:键与表里那一项撤掉,错原样抛出去 —— 登记失败不留半个适配器。
	 *
	 * 它的适配器键得是空的,**占了就抛**:悄悄顶掉等于把别人的连接整个截走
	 * (一个拓展要是能声明 `"onebot"`,内置那条连接的推送就全走它了),而两边都不报错。
	 */
	register(adapter: PlatformAdapter, ctx: PlatformAdapterContext): Disposable;
	/**
	 * 现在有哪些出口。
	 *
	 * 🔴 **在分发那一刻问**,别把结果存下来 —— 存一份就等于回到那个开机拼好的数组,
	 * 后注册的拓展对它永远不存在。
	 */
	list(): readonly PlatformAdapterView[];
	/**
	 * 登记成功与撤下之后各叫一次(登记失败、重复撤下不叫)。「哪些适配器在场」会变宽变窄的消费方
	 * (按适配器规则判连接设置里哪格是机密)靠它重算,不用在每个登记点手补。回调里再登记 / 撤下不受保护,别这么干。
	 */
	onChange(fn: () => void): Disposable;
}

/**
 * 登记表对外给的出口视图:**不含 `send` / `start` / `stop`**,运行时也真的没有。
 *
 * 发送只许经 `TargetDispatcher`(出口咽喉,ADR-0024 决策 13);启停只归登记表(登记即 `start`、
 * 注销即 `stop`);其余消费方(能力探测之类)用不着它们,也就拿不到。
 * 同一个适配器每次 `list()` 回同一个视图对象。
 */
export type PlatformAdapterView = Omit<PlatformAdapter, "send" | "start" | "stop">;

/** 带 `send` 的适配器 —— 不含 `start` / `stop`(启停只归登记表,派发器用不着)。 */
type SendableAdapter = Omit<PlatformAdapter, "start" | "stop">;

/** 登记表 → 带 `send` 的完整适配器。只有 {@link sendableAdapters} 能读;视图对外,这份不外露。 */
const fullListOf = new WeakMap<PlatformAdapterRegistry, () => readonly SendableAdapter[]>();

/**
 * 带 `send` 的完整适配器 —— **全仓只许 `push/target-dispatcher.ts` 引它**(出口咽喉的守卫钉着)。
 * 同样在分发那一刻问,别存下来。
 */
export function sendableAdapters(registry: PlatformAdapterRegistry): readonly SendableAdapter[] {
	const full = fullListOf.get(registry);
	if (!full) throw new Error("registry was not created by createPlatformAdapterRegistry");
	return full();
}

/** 摘掉 `send` / `start` / `stop`。按成员表取、方法 bind 回原实例:class 写的适配器照样读得到自己的状态。 */
function viewOf(adapter: PlatformAdapter): PlatformAdapterView {
	return pickAdapterMembers(adapter, ["send", "start", "stop"]);
}

export function createPlatformAdapterRegistry(): PlatformAdapterRegistry {
	const adapters: PlatformAdapter[] = [];
	const keys = new Set<string>();

	function add(adapter: PlatformAdapter): void {
		const key = adapter.adapterKey;
		if (keys.has(key)) throw new Error(`adapter for dispatch key "${key}" is already registered`);
		keys.add(key);
		adapters.push(adapter);
	}

	function remove(adapter: PlatformAdapter): void {
		const idx = adapters.indexOf(adapter);
		if (idx >= 0) adapters.splice(idx, 1);
		keys.delete(adapter.adapterKey);
	}

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

	const listeners = new Set<() => void>();
	const notify = (): void => {
		for (const fn of [...listeners]) fn();
	};

	const registry: PlatformAdapterRegistry = {
		list: () => adapters.map(viewFor),
		onChange(fn) {
			listeners.add(fn);
			return { dispose: () => void listeners.delete(fn) };
		},
		register(adapter, ctx) {
			add(adapter);
			try {
				adapter.start(ctx);
			} catch (err) {
				// 登记失败不留半个适配器:键放掉、表里摘掉,错原样抛出去。
				remove(adapter);
				throw err;
			}
			notify();
			let removed = false;
			return {
				dispose() {
					if (removed) return;
					removed = true;
					remove(adapter);
					notify();
					stopQuietly(
						() => adapter.stop(),
						(err) =>
							ctx.logger.warn(`[adapter] ${adapter.adapterKey} stop 失败: ${errorMessageOf(err)}`),
					);
				},
			};
		},
	};
	fullListOf.set(registry, () => adapters);
	return registry;
}
