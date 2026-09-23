import {
	type ExtensionSubscription,
	type ExtraKey,
	FEATURE_KEYS,
	type GlobalDefaults,
	type Logger,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type ServiceContext,
	type Subscription,
} from "@bilibili-notify/internal";

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
	};
}

/**
 * 宿主必注入的三样(serviceCtx / defaults / muted)的单测基座。用例把它 spread 在前,
 * 需要的再覆盖(假时钟、特定 defaults、静音)。
 *
 * defaults 一次算好、每次都交同一个对象:每次推送都要调它,别每次重跑一遍整棵 zod parse;
 * 用例拿 `defaults()` 改一改来验闸门(关 feature / 设 quietHours)时,改动也得留得住。
 */
export function pushBase(): Pick<
	import("../bilibili-push").BilibiliPushOptions,
	"serviceCtx" | "defaults" | "muted"
> {
	const defaults = loopbackDefaults();
	return { serviceCtx: realTimerCtx(), defaults: () => defaults, muted: () => false };
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
 * 一条拓展订阅(ADR-0019 决策 9):没有 uid,身份是 `(extensionId, externalId)`。
 * 共有的那些字段(routing / extras / overrides …)跟着 B 站空订阅的出厂默认走。
 */
export function makeExtensionSub(opts: {
	id: string;
	externalId: string;
	extensionId?: string;
}): ExtensionSubscription {
	const {
		kind: _kind,
		uid: _uid,
		roastSchedule: _roast,
		specialUsers: _special,
		...common
	} = makeEmptySubscription({ id: opts.id, uid: "0" });
	return {
		...common,
		kind: "extension",
		id: opts.id,
		extensionId: opts.extensionId ?? "douyin",
		externalId: opts.externalId,
	};
}
