import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";

export const BILIBILI_NOTIFY_INTERNALS_PROTOCOL = {
	name: "@bilibili-notify/koishi-internals",
	version: 1,
} as const;

const REQUIRED_INTERNALS_PROTOCOL = {
	minInclusive: 1,
	maxExclusive: 2,
} as const;

export interface BilibiliNotifyInternalsProtocolInfo {
	name: typeof BILIBILI_NOTIFY_INTERNALS_PROTOCOL.name;
	version: number;
	coreVersion: string;
}

export type BilibiliNotifyInternalsUnavailableReason =
	| "token-mismatch"
	| "api"
	| "push"
	| "store"
	| "registry";

export type BilibiliNotifyInternalsProbe<T> =
	| {
			ok: true;
			protocol: BilibiliNotifyInternalsProtocolInfo;
			internals: T;
	  }
	| {
			ok: false;
			protocol: BilibiliNotifyInternalsProtocolInfo;
			reason: BilibiliNotifyInternalsUnavailableReason;
	  };

export type BilibiliNotifyInternalsWithProtocol = object & {
	protocol?: {
		name?: unknown;
		version?: unknown;
		coreVersion?: unknown;
	};
};

export interface BilibiliNotifyCoreInternalsProvider<
	T extends BilibiliNotifyInternalsWithProtocol,
> {
	getInternals(token: symbol): T | null;
	probeInternals?(token: symbol): BilibiliNotifyInternalsProbe<T>;
}

const MISSING_REASON_LABELS: Record<BilibiliNotifyInternalsUnavailableReason, string> = {
	"token-mismatch": "内部访问令牌",
	api: "BilibiliAPI",
	push: "BilibiliPush",
	store: "SubscriptionStore",
	registry: "TargetRegistry",
};

export function formatBilibiliNotifyInternalsProtocolRange(): string {
	return `>=${REQUIRED_INTERNALS_PROTOCOL.minInclusive} <${REQUIRED_INTERNALS_PROTOCOL.maxExclusive}`;
}

function describeProtocol(protocol: BilibiliNotifyInternalsWithProtocol["protocol"]): string {
	if (!protocol) return "legacy token v1（未显式声明 protocol）";
	const name = typeof protocol.name === "string" ? protocol.name : "unknown-protocol";
	const version =
		typeof protocol.version === "number" || typeof protocol.version === "string"
			? `v${protocol.version}`
			: "version unknown";
	const coreVersion =
		typeof protocol.coreVersion === "string" && protocol.coreVersion
			? `core ${protocol.coreVersion}`
			: "core version unknown";
	return `${name} ${version}（${coreVersion}）`;
}

export interface InternalsProtocolRange {
	minInclusive: number;
	maxExclusive: number;
}

/**
 * 纯判定:version 是否落在 range(默认本插件 REQUIRED)。range 设计成显式可传,是为了
 * 让"未来某子插件把 REQUIRED bump 到排除 v1"这条演进分支能被单测锁住,而不必依赖
 * 改动模块常量才能验证。
 */
export function isInternalsVersionCompatible(
	version: number | undefined,
	range: InternalsProtocolRange = REQUIRED_INTERNALS_PROTOCOL,
): boolean {
	if (typeof version !== "number") return false;
	return version >= range.minInclusive && version < range.maxExclusive;
}

/** legacy core(能返回 internals 但未声明 protocol)按 v1 对待:仅当 range 仍接受 v1 才兼容。 */
export function isLegacyInternalsCompatible(
	range: InternalsProtocolRange = REQUIRED_INTERNALS_PROTOCOL,
): boolean {
	return isInternalsVersionCompatible(1, range);
}

function isProtocolCompatible(protocol: BilibiliNotifyInternalsWithProtocol["protocol"]): boolean {
	// 无条件把"无 protocol"当兼容,会在未来某子插件把 REQUIRED bump 到排除 v1 时,
	// 把真·旧 core 误判成兼容、拿 v1 shape 当新版用 —— 所以 legacy 也要过 range 判定。
	if (!protocol) return isLegacyInternalsCompatible();
	return (
		protocol.name === BILIBILI_NOTIFY_INTERNALS_PROTOCOL.name &&
		isInternalsVersionCompatible(
			typeof protocol.version === "number" ? protocol.version : undefined,
		)
	);
}

export function assertBilibiliNotifyInternalsProtocol<
	T extends BilibiliNotifyInternalsWithProtocol,
>(serviceName: string, internals: T): T {
	if (isProtocolCompatible(internals.protocol)) return internals;
	throw new Error(
		`${serviceName} 与 bilibili-notify 核心服务的 internals 协议不兼容：当前 ${describeProtocol(
			internals.protocol,
		)}，本插件需要 ${BILIBILI_NOTIFY_INTERNALS_PROTOCOL.name} ${formatBilibiliNotifyInternalsProtocolRange()}。请升级 koishi-plugin-bilibili-notify 或降级当前 BN 子插件到兼容版本；若升级后仍报错，请卸载所有 BN 插件后重新安装。`,
	);
}

function formatUnavailableMessage<T extends BilibiliNotifyInternalsWithProtocol>(
	serviceName: string,
	probe: Extract<BilibiliNotifyInternalsProbe<T>, { ok: false }>,
): string {
	if (probe.reason === "token-mismatch") {
		return `${serviceName} 无法通过 bilibili-notify 核心服务的内部访问令牌校验：core 与当前插件使用的 internals token 不一致（当前 ${describeProtocol(
			probe.protocol,
		)}）。请统一升级或重装 core/dynamic/live/ai 等 BN 插件到兼容版本。`;
	}
	return `${serviceName} 已找到 bilibili-notify 核心服务，但核心内部实例尚未就绪（缺少 ${MISSING_REASON_LABELS[probe.reason]}，当前 ${describeProtocol(
		probe.protocol,
	)}）。core 可能仍在启动或已经启动失败；请优先查看 bilibili-notify [module] 注册模块失败的上一条日志。`;
}

export function resolveBilibiliNotifyCoreInternals<T extends BilibiliNotifyInternalsWithProtocol>(
	serviceName: string,
	core: BilibiliNotifyCoreInternalsProvider<T>,
): T {
	if (typeof core.probeInternals === "function") {
		const probe = core.probeInternals(BILIBILI_NOTIFY_TOKEN);
		if (!probe.ok) throw new Error(formatUnavailableMessage(serviceName, probe));
		return assertBilibiliNotifyInternalsProtocol(serviceName, probe.internals);
	}
	const internals = core.getInternals(BILIBILI_NOTIFY_TOKEN);
	if (!internals) {
		throw new Error(
			`${serviceName} 已找到 bilibili-notify 核心服务，但核心内部实例尚未就绪或内部访问令牌不匹配：请先查看 bilibili-notify core 是否有启动失败日志；若升级后仍报错，请统一升级或重装所有 BN 插件。`,
		);
	}
	return assertBilibiliNotifyInternalsProtocol(serviceName, internals);
}

export function tryResolveBilibiliNotifyCoreInternals<
	T extends BilibiliNotifyInternalsWithProtocol,
>(
	serviceName: string,
	core: BilibiliNotifyCoreInternalsProvider<T> | null | undefined,
	onUnavailable?: (message: string) => void,
): T | null {
	if (!core) return null;
	try {
		return resolveBilibiliNotifyCoreInternals(serviceName, core);
	} catch (e) {
		// core 在线但运行期拿不到 internals(就绪→不就绪 / 热重载换成不兼容版本)。
		// 默认仍静默降级(不传 onUnavailable 时行为不变);传了则交调用方记 debug,
		// 让这条理论窗口不再无声。
		onUnavailable?.(e instanceof Error ? e.message : String(e));
		return null;
	}
}
