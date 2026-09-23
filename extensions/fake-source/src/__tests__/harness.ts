import type {
	Disposable,
	ExtensionContext,
	ExtensionOwnSubscription,
	ExtensionView,
	SubscriptionSourceDef,
} from "@bilibili-notify/extension";
import { activate } from "../index.js";

/** 五种上报的种类名 —— 与宿主那张表同一套词。 */
export type HeardKind = "post" | "liveStart" | "liveEnd" | "liveStatus" | "profile";

/** 假源经 `handle.report*` 报出去的一条,原样攒着(`value` 就是它交的那个对象)。 */
export interface HeardReport {
	kind: HeardKind;
	externalId: string;
	value: unknown;
}

export interface BootOptions {
	/**
	 * 演宿主拒收:回一句原因就把这条上报 reject 掉(拓展拿到的是带这句话的错),回 `undefined` 就收下。
	 * 拒掉的不进 {@link HeardReport} 那一串 —— 与宿主一样,拒了就是没收。
	 */
	refuse?: (report: HeardReport) => string | undefined;
	/** 演宿主那头慢:交回一个 Promise 就先等它再收(测两颗按钮交错着跑)。 */
	hold?: (report: HeardReport) => Promise<void> | undefined;
}

type ActionHandler = (signal: AbortSignal) => void | Promise<void>;

/**
 * 手搭的 ctx:只接假源真会碰的那几格,把它交出来的东西(解析门、视图、动作、上报)攒下来给测试看。
 * 订阅名单由测试自己摆,`changeSubscriptions` 模拟宿主「订阅动过了」那一声。
 */
export function bootFakeSource(
	initial: readonly ExtensionOwnSubscription[] = [],
	opts: BootOptions = {},
) {
	let subs = [...initial];
	let source: SubscriptionSourceDef | undefined;
	let view: (() => ExtensionView) | undefined;
	const listeners: (() => void)[] = [];
	const actions = new Map<string, ActionHandler>();
	const heard: HeardReport[] = [];
	let statusChanges = 0;
	const noop: Disposable = { dispose() {} };

	/** 宿主那头的 `report*`:核完就回(这里不核,只按 `refuse` 演拒收)。 */
	const reporter =
		(kind: HeardKind) =>
		async (externalId: string, value: unknown): Promise<void> => {
			const report = { kind, externalId, value };
			await opts.hold?.(report);
			const reason = opts.refuse?.(report);
			if (reason !== undefined) throw new Error(`BN 拒收这条 ${kind} 上报:${reason}`);
			heard.push(report);
		};

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
				reportPost: reporter("post"),
				reportLiveStart: reporter("liveStart"),
				reportLiveEnd: reporter("liveEnd"),
				reportLiveStatus: reporter("liveStatus"),
				reportProfile: reporter("profile"),
			};
		},
		publishView(fn: () => ExtensionView) {
			view = fn;
		},
		statusChanged() {
			statusChanges += 1;
		},
		// 与宿主同一条规矩:同一个名字接两次当场抛。
		onAction(name: string, handler: ActionHandler) {
			if (actions.has(name)) throw new Error(`动作 ${name} 接了两次`);
			actions.set(name, handler);
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
		/** 面板按一下那颗动作钮:原样等 handler 回来(它抛的就是面板收到的原话)。 */
		async press(name: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
			const handler = actions.get(name);
			if (!handler) throw new Error(`假源没接动作 ${name}`);
			await handler(signal);
		},
		/** 假源在 `activate` 里接了哪些动作。 */
		actionNames: () => [...actions.keys()],
		/** 宿主收下的上报,按报的先后。 */
		reports: () => [...heard],
	};
}
