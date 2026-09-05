import {
	FEATURE_KEYS,
	type GlobalDefaults,
	type Logger,
	makeDefaultGlobalConfig,
	type ServiceContext,
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
