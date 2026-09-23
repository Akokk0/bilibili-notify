import type {
	Disposable,
	ExtensionContext,
	ExtensionOwnSubscription,
	ExtensionView,
	SubscriptionSourceDef,
} from "@bilibili-notify/extension";
import { activate } from "../index.js";

/**
 * 手搭的 ctx:只接假源真会碰的那几格,把它交出来的东西(解析门、视图)攒下来给测试看。
 * 订阅名单由测试自己摆,`changeSubscriptions` 模拟宿主「订阅动过了」那一声。
 */
export function bootFakeSource(initial: readonly ExtensionOwnSubscription[] = []) {
	let subs = [...initial];
	let source: SubscriptionSourceDef | undefined;
	let view: (() => ExtensionView) | undefined;
	const listeners: (() => void)[] = [];
	let statusChanges = 0;
	const noop: Disposable = { dispose() {} };

	const ctx = {
		id: "fake-source",
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		setTimeout: () => noop,
		setInterval: () => noop,
		onDispose() {},
		registerSubscriptionSource(def: SubscriptionSourceDef) {
			source = def;
			return {
				subscriptions: () => subs,
				onSubscriptionsChanged(fn: () => void) {
					listeners.push(fn);
					return noop;
				},
			};
		},
		publishView(fn: () => ExtensionView) {
			view = fn;
		},
		statusChanged() {
			statusChanges += 1;
		},
	} as unknown as ExtensionContext;

	activate(ctx);

	return {
		lookup(query: string, signal: AbortSignal = new AbortController().signal) {
			if (!source) throw new Error("假源没注册订阅源");
			return source.lookup(query, signal);
		},
		view(): ExtensionView {
			if (!view) throw new Error("假源没交视图");
			return view();
		},
		changeSubscriptions(next: readonly ExtensionOwnSubscription[]) {
			subs = [...next];
			for (const fn of listeners) fn();
		},
		statusChanges: () => statusChanges,
	};
}
