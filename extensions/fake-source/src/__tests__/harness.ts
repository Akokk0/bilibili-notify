import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
	Connection,
	CreatorCandidate,
	CreatorProfileReport,
	ExtensionContext,
	ExtensionI18n,
	ExtensionView,
	Identity,
	ImageRef,
	InboundMeta,
	InboundPrivateMessage,
	LiveStatusResult,
	PlatformAdapterContext,
	PlatformAdapterDef,
	Result,
	SourceContext,
	SourceDef,
	SourceHealth,
	SourceSubscriptionView,
} from "@bilibili-notify/extension";
import { neutralPlatformDescriptor } from "@bilibili-notify/extension";
import { activate } from "../index.js";

/** 三种上报的种类名 —— 与宿主那张表同一套词。 */
export type HeardKind = "post" | "live" | "profile";

/** 假源经 `ctx.report*` 报出去的一条,原样攒着(`value` 就是它交的那个对象)。 */
export interface HeardReport {
	kind: HeardKind;
	externalId: string;
	value: unknown;
}

/** 集成上下文、来源上下文与适配器上下文各自报 / 清问题的那一下。 */
export interface ProblemCall {
	layer: "extension" | "source" | "adapter";
	action: "report" | "resolve";
	value: {
		externalId?: string;
		connectionId?: string;
		code: string;
		message?: string;
		notify?: boolean;
		recoveryMessage?: string;
	};
}

/** 测试摆的一条订阅:假源只认外部 id 与开没开着(宿主的名单只列开着的,同一个人合成一条)。 */
export interface HarnessSub {
	externalId: string;
	enabled: boolean;
}

export interface BootOptions {
	/** 开机时适配器上下文里已有的连接。 */
	connections?: readonly Connection[];
	/** 演图库那头存不下:回一句原因就把这次 `storeImage` 回成 `invalid` 失败,回 `undefined` 就存下。 */
	refuseStore?: (bytes: Uint8Array) => string | undefined;
	/** 演图库那头慢:第 `index` 次(从 0 数)存图交回一个 Promise 就先等它(测两颗按钮交错着跑)。 */
	holdStore?: (index: number) => Promise<void> | undefined;
}

/** 适配器上下文收到的一条入站私聊。 */
export interface HeardInbound {
	msg: InboundPrivateMessage;
	meta: Pick<InboundMeta, "connectionId">;
}

/** 测试摆的一条假连接:归假源的适配器,默认开着、`fake-chat`、两格设置取默认。 */
export function fakeConnection(
	id: string,
	over: Partial<Pick<Connection, "platform" | "enabled" | "settings">> = {},
): Connection {
	const platform = over.platform ?? "fake-chat";
	const { platform: _platform, ...platformSnapshot } = neutralPlatformDescriptor(platform);
	return {
		id,
		name: `连接 ${id}`,
		enabled: true,
		adapterKey: "fake-source",
		platform,
		settings: { atAll: false, inboundFrom: "" },
		platformSnapshot,
		...over,
	};
}

/**
 * 手搭的适配器上下文:连接名单由测试摆,`setConnections` 模拟宿主「连接动过了」那一声;
 * 交上来的入站与问题上报原样攒着。
 */
export function fakeAdapterContext(
	initial: readonly Connection[] = [],
	onProblem: (call: ProblemCall) => void = () => {},
) {
	let connections = [...initial];
	const listeners = new Set<() => void>();
	const inbound: HeardInbound[] = [];
	const ctx = {
		connections: () => connections,
		onConnectionsChanged(fn: () => void) {
			listeners.add(fn);
			return {
				dispose() {
					listeners.delete(fn);
				},
			};
		},
		reportProblem: (value: ProblemCall["value"]) =>
			onProblem({ layer: "adapter", action: "report", value }),
		resolveProblem: (value: ProblemCall["value"]) =>
			onProblem({ layer: "adapter", action: "resolve", value }),
		inbound: {
			private: (msg: InboundPrivateMessage, meta: Pick<InboundMeta, "connectionId">) => {
				inbound.push({ msg, meta });
			},
			group: () => {},
		},
	} as unknown as PlatformAdapterContext;
	return {
		ctx,
		setConnections(next: readonly Connection[]) {
			connections = [...next];
			for (const fn of [...listeners]) fn();
		},
		inbound: () => [...inbound],
		listenerCount: () => listeners.size,
	};
}

type ActionHandler = (signal: AbortSignal) => void | Promise<void>;

/**
 * 假的 `ctx.i18n`:读包里真的 `locales/zh-CN.json`(宿主那套回落链与单复数不在这里重造),
 * 带 `count` 时取 `键#other`,占位符 `{名字}` 从 `values` 填。语言永远是简中。
 */
function zhCNI18n(): ExtensionI18n {
	const dict = JSON.parse(
		readFileSync(new URL("../../locales/zh-CN.json", import.meta.url), "utf8"),
	) as Record<string, unknown>;
	return {
		locale: () => "zh-CN",
		t(key, values) {
			const hit = values?.count === undefined ? dict[key] : dict[`${key}#other`];
			const text = typeof hit === "string" ? hit : key;
			return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
				const value = values?.[name];
				return value === undefined ? whole : String(value);
			});
		},
		onChange: () => ({ dispose() {} }),
	};
}

/** 图库认的引用长这样:`<sha256>.<png|jpg|gif|webp>`(与宿主 `IMAGE_REF_PATTERN` 同一个形状)。 */
export const IMAGE_REF_PATTERN = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 手搭的 ctx:只接假源真会碰的那几格,把它交出来的东西(来源定义、视图、动作、上报)攒下来给测试看。
 * 订阅名单由测试自己摆,`changeSubscriptions` 模拟宿主「订阅动过了」那一声。注册来源时当场 `start`
 * (宿主是异步登记,这里省掉那一等),`stop()` 模拟收摊。
 */
export function bootFakeSource(initial: readonly HarnessSub[] = [], opts: BootOptions = {}) {
	let subs = [...initial];
	let source: SourceDef | undefined;
	let adapterDef: PlatformAdapterDef | undefined;
	const adapterCtx = fakeAdapterContext(opts.connections, (call) => problemCalls.push(call));
	let view: (() => ExtensionView) | undefined;
	const listeners: (() => void)[] = [];
	const actions = new Map<string, ActionHandler>();
	const heard: HeardReport[] = [];
	const problemCalls: ProblemCall[] = [];
	/** 图库里存下的图:引用 → 字节。 */
	const stored = new Map<ImageRef, Uint8Array>();
	let storeCalls = 0;
	let statusChanges = 0;
	const noop = { dispose() {} };

	/** 宿主的名单:只列开着的,同一个人合成一条。 */
	function roster(): SourceSubscriptionView[] {
		const people = new Set(subs.filter((one) => one.enabled).map((one) => one.externalId));
		return [...people].map((externalId) => ({
			externalId,
			features: new Set(),
			monitorsLive: false,
		}));
	}

	const reporter = (kind: HeardKind) => (externalId: string, value: unknown) => {
		heard.push({ kind, externalId, value });
	};

	const problemReporter = (layer: ProblemCall["layer"]) => ({
		reportProblem(value: ProblemCall["value"]) {
			problemCalls.push({ layer, action: "report", value });
		},
		resolveProblem(value: ProblemCall["value"]) {
			problemCalls.push({ layer, action: "resolve", value });
		},
	});

	const sourceCtx = {
		subscriptions: roster,
		onSubscriptionsChanged(fn: () => void) {
			listeners.push(fn);
			return noop;
		},
		reportPost: reporter("post"),
		reportLive: reporter("live"),
		reportProfile: reporter("profile"),
		...problemReporter("source"),
		async storeImage(bytes: Uint8Array): Promise<Result<{ ref: ImageRef }>> {
			const index = storeCalls++;
			await opts.holdStore?.(index);
			const refused = opts.refuseStore?.(bytes);
			if (refused !== undefined) return { ok: false, code: "invalid", message: refused };
			// 与宿主一样按内容嗅探:不是位图(这里只认 png)存不下。
			if (!PNG_MAGIC.every((byte, i) => bytes[i] === byte)) {
				return { ok: false, code: "invalid", message: "不是图" };
			}
			const ref = `${createHash("sha256").update(bytes).digest("hex")}.png`;
			stored.set(ref, bytes);
			return { ok: true, ref };
		},
	} as unknown as SourceContext;

	const ctx = {
		id: "fake-source",
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		setTimeout: () => noop,
		setInterval: () => noop,
		onDispose() {},
		i18n: zhCNI18n(),
		...problemReporter("extension"),
		registerSource(def: SourceDef) {
			source = def;
			void def.start(sourceCtx);
			return noop;
		},
		registerPlatformAdapter(def: PlatformAdapterDef) {
			adapterDef = def;
			void def.start(adapterCtx.ctx);
			return {
				dispose() {
					void def.stop();
				},
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

	const adapter = (): PlatformAdapterDef => {
		if (!adapterDef) throw new Error("假源没注册平台适配器");
		return adapterDef;
	};

	const def = (): SourceDef => {
		if (!source) throw new Error("假源没注册订阅源");
		return source;
	};

	return {
		/** 搜人:原样交给假源登记的 `searchCreators`。 */
		searchCreators(
			query: string,
			signal: AbortSignal = new AbortController().signal,
		): Promise<Result<{ candidates: CreatorCandidate[] }>> {
			return def().searchCreators(query, signal);
		},
		/** 搜人,只要候选(失败就让测试红)。 */
		async candidates(query: string): Promise<CreatorCandidate[]> {
			const found = await def().searchCreators(query, new AbortController().signal);
			if (!found.ok) throw new Error(`搜人失败:${found.message}`);
			return found.candidates;
		},
		/** 拉取式资料。 */
		fetchProfile(
			identity: Identity,
			signal: AbortSignal = new AbortController().signal,
		): Promise<Result<CreatorProfileReport>> {
			const fetchProfile = def().fetchProfile;
			if (!fetchProfile) throw new Error("假源没实现 fetchProfile");
			return fetchProfile(identity, signal);
		},
		/** 拉取式直播状态。 */
		fetchLiveStatus(
			identity: Identity,
			signal: AbortSignal = new AbortController().signal,
		): Promise<LiveStatusResult> {
			const fetchLiveStatus = def().fetchLiveStatus;
			if (!fetchLiveStatus) throw new Error("假源没实现 fetchLiveStatus");
			return Promise.resolve(fetchLiveStatus(identity, signal));
		},
		/** 来源自报的一行健康状况。 */
		health(): SourceHealth {
			const health = def().health;
			if (!health) throw new Error("假源没实现 health");
			return health();
		},
		/** 宿主收摊:先叫来源的 `stop()`。 */
		async stop(): Promise<void> {
			await def().stop();
		},
		/** 注册上去的适配器定义(运行时的原样,含故意塞的不开的成员)。 */
		adapter,
		/** 摆新的连接名单并喊一声「连接动过了」。 */
		setConnections: adapterCtx.setConnections,
		/** 适配器上下文里此刻的连接 id。 */
		setConnectionIds: () => adapterCtx.ctx.connections().map((one) => one.id),
		/** 适配器上下文收到的入站私聊。 */
		inbound: adapterCtx.inbound,
		/** 适配器此刻订着几个「连接动过了」。 */
		connectionListeners: adapterCtx.listenerCount,
		/** 宿主收摊适配器:`stop()`。 */
		async stopAdapter(): Promise<void> {
			await adapter().stop();
		},
		/** 来源定义里登了哪些成员。 */
		members: () => Object.keys(def()).sort(),
		view(): ExtensionView {
			if (!view) throw new Error("假源没交视图");
			return view();
		},
		changeSubscriptions(next: readonly HarnessSub[]) {
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
		/** 集成上下文与来源上下文报 / 清问题的先后。 */
		problemCalls: () => [...problemCalls],
		/** 图库里某个引用对应的字节;没有就是 `undefined`。 */
		imageBytes: (ref: unknown): Uint8Array | undefined =>
			typeof ref === "string" ? stored.get(ref) : undefined,
		/** 图库每存下一张图时交回的那些引用,按次的先后。 */
		storedRefs: (): ImageRef[] => [...stored.keys()],
	};
}
