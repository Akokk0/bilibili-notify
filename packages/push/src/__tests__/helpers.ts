import {
	AiWritingSettingsSchema,
	type DeliveryResult,
	type ExtraKey,
	FEATURE_KEYS,
	type FeatureKey,
	type GlobalDefaults,
	type Logger,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type NotificationPayload,
	type ServiceContext,
	type Subscription,
} from "@bilibili-notify/internal";
import type { PushRouter } from "../push-router";

/** 全部 noop 的 logger,各用例共用这一份。 */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** 全部 feature 开、无免扰时段 —— 只让 routing 说话的 defaults。 */
function loopbackDefaults(): GlobalDefaults {
	const g = makeDefaultGlobalConfig();
	for (const k of FEATURE_KEYS) g.defaults.features[k] = true;
	g.defaults.schedule.quietHours = [];
	return g.defaults;
}

/** 真实计时器的 ServiceContext:retry backoff 照常走时钟,dispose 即 clear。 */
function realTimerCtx(): ServiceContext {
	return {
		logger: silentLogger,
		setInterval: (fn, ms) => {
			const id = setInterval(fn, ms);
			return { dispose: () => clearInterval(id) };
		},
		setTimeout: (fn, ms) => {
			const id = setTimeout(fn, ms);
			id.unref?.();
			return { dispose: () => clearTimeout(id) };
		},
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
}

/**
 * 宿主必注入的四样(serviceCtx / defaults / muted / aiWriting)的单测基座。用例把它 spread 在前,
 * 需要的再覆盖(假时钟、特定 defaults、静音)。
 *
 * defaults 一次算好、每次都交同一个对象:每次推送都要调它,别每次重跑一遍整棵 zod parse;
 * 用例拿 `defaults()` 改一改来验闸门(关 feature / 设 quietHours)时,改动也得留得住。
 */
export function pushBase(): Pick<
	import("../push-router").PushRouterOptions,
	"serviceCtx" | "defaults" | "muted" | "aiWriting" | "timezone"
> {
	const defaults = loopbackDefaults();
	// 「AI 写正文」缺省全开、无例外:没有锚点带 AI 版时它不起作用,带了就全体目标挑 AI 版。
	const aiWriting = AiWritingSettingsSchema.parse({});
	return {
		serviceCtx: realTimerCtx(),
		timezone: () => "Asia/Shanghai",
		defaults: () => defaults,
		muted: () => false,
		aiWriting: () => aiWriting,
	};
}

/**
 * {@link pushBase} 加一本后台活的账:附加项(与 @全体 的落地回调)是 `push()` 返回之后在后台发的,
 * 经 `serviceCtx.track` 登记;用例发完附加项先 `await settled()` 再断言。
 */
export function trackedPushBase(): {
	base: ReturnType<typeof pushBase>;
	tracked: Promise<unknown>[];
	settled(): Promise<void>;
} {
	const base = pushBase();
	const tracked: Promise<unknown>[] = [];
	let done = 0;
	return {
		base: { ...base, serviceCtx: { ...base.serviceCtx, track: (task) => void tracked.push(task) } },
		tracked,
		settled: async () => {
			while (done < tracked.length) await tracked[done++];
		},
	};
}

/** 只有本体那一个锚点的推送;一条消息就是单元素序列。 */
export function pushMain(
	router: PushRouter,
	subscriptionId: string,
	feature: FeatureKey,
	messages: NotificationPayload | NotificationPayload[],
	options?: { allowAtAll?: false },
): Promise<DeliveryResult[]> {
	return router.push({
		subscriptionId,
		feature,
		...options,
		anchors: [{ role: "main", messages: Array.isArray(messages) ? messages : [messages] }],
	});
}

/** 只有一个附加项锚点的推送(没有本体,立即返回;发送在后台,等 `settled()`)。 */
export function pushExtra(
	router: PushRouter,
	subscriptionId: string,
	feature: FeatureKey,
	messages: NotificationPayload | NotificationPayload[],
	extra?: ExtraKey,
): Promise<DeliveryResult[]> {
	return router.push({
		subscriptionId,
		feature,
		anchors: [{ role: "extra", extra, messages: Array.isArray(messages) ? messages : [messages] }],
	});
}

/**
 * per-UP 的附加项默认值(ADR-0016):它住在 features 覆盖的 `extras` 里,推送层读的是
 * 全局 + per-UP 折叠后的那一份。用例写这一层,等于从前的 `sub.atAllDefaults.X = ...`。
 */
export function setExtraDefault(sub: Subscription, key: ExtraKey, on: boolean): void {
	const features = sub.overrides.features ?? {};
	sub.overrides.features = { ...features, extras: { ...features.extras, [key]: on } };
}

/**
 * 一条拓展来源的订阅(ADR-0021 决策 14):身份是 `(拓展 id, 外部 id)`,没有 B 站的 uid。
 * 其余字段(routing / extras / overrides …)跟着空订阅的出厂默认走。
 */
export function makeExtensionSub(opts: {
	id: string;
	externalId: string;
	extensionId?: string;
}): Subscription {
	return makeEmptySubscription({
		id: opts.id,
		identity: { sourceKey: opts.extensionId ?? "douyin", externalId: opts.externalId },
	});
}

/** 推送路由只用得到分发器的这五个方法,单测里的假实现也只交这五个。 */
export type FakeDispatcher = import("../push-router").PushRouterOptions["dispatcher"];
