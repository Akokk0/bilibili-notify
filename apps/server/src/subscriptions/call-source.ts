import {
	type CreatorProfileReport,
	createSerialGate,
	fail,
	type Identity,
	type LiveStatusResult,
	type Logger,
	type Result,
	type SerialGate,
} from "@bilibili-notify/internal";
import { logText } from "../i18n/index.js";
import { LOOKUP_TIMEOUT_MS } from "../integrations/lookup-timeout.js";
import type { SourceRegistry } from "./registry.js";

export interface CallSourceOptions<R> {
	logger: Pick<Logger, "error">;
	sourceKey: string;
	/** 被调的是来源上的哪个成员(进错误日志与中止原因)。 */
	member: string;
	/** 最多等多久。 */
	timeoutMs: number;
	call(signal: AbortSignal): Promise<R>;
	/** 宿主不等了:回给调用方的那份失败。 */
	onTimeout(): R;
	/** 来源抛了:回给调用方的那份失败(原话只进错误日志)。 */
	onThrow(): R;
	/**
	 * 调用方这头要撤销这次调用(来源停用了、宿主关停了):传进来,中止时叫停来源手里的 signal 并立刻回
	 * `onAbort()`(不给就回 `onThrow()` 那份,但不记错误日志 —— 这不是来源的错)。
	 */
	signal?: AbortSignal;
	onAbort?(): R;
}

/**
 * 宿主调某个来源的外壳(failure-results 第 2 条:抛错只留给 bug,宿主在边界接住),搜人、查直播与查资料共用:
 * - 带超时的 `AbortSignal` 去调:宿主不等了就叫停来源手里的 signal,回 `onTimeout()`;
 * - 来源抛了:原话只进错误日志,回 `onThrow()`;
 * - 来源自己回的结果(含它回的失败)原样回,不改码不改话。
 *
 * 串行不在这里(见 {@link createSourceGates}):外壳只管一次调用的边界。
 */
export async function callSource<R>(opts: CallSourceOptions<R>): Promise<R> {
	const aborted = (): R => (opts.onAbort ?? opts.onThrow)();
	const external = opts.signal;
	// 调之前就已经被撤销了:不去问来源。
	if (external?.aborted) return aborted();
	const controller = new AbortController();
	let onExternalAbort: (() => void) | undefined;
	const cancelled = new Promise<R>((resolve) => {
		if (!external) return;
		onExternalAbort = () => {
			controller.abort(external.reason);
			resolve(aborted());
		};
		external.addEventListener("abort", onExternalAbort, { once: true });
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<R>((resolve) => {
		timer = setTimeout(() => {
			// 宿主不等了就叫它停:调用方那头已经是一句「超时」,它接着问平台只是白白多挨一次风控。
			controller.abort(
				new DOMException(
					`${opts.member} did not answer within ${opts.timeoutMs / 1000}s; the host stopped waiting`,
					"TimeoutError",
				),
			);
			resolve(opts.onTimeout());
		}, opts.timeoutMs);
	});
	const run = (async (): Promise<R> => {
		try {
			return await opts.call(controller.signal);
		} catch (err) {
			// 被撤销时来源常常因此抛出中止错误:那不是它的 bug,不记。
			if (external?.aborted) return aborted();
			opts.logger.error(
				logText("log.source.callFailed"),
				{ event: "source.call_failed", sourceKey: opts.sourceKey, member: opts.member },
				err,
			);
			return opts.onThrow();
		}
	})();
	try {
		return await Promise.race([run, timeout, cancelled]);
	} finally {
		clearTimeout(timer);
		if (external && onExternalAbort) external.removeEventListener("abort", onExternalAbort);
	}
}

/** 按来源键一道串行闸:同一个来源的调用一个接一个(来源实现按「同一来源串行调用」写)。 */
export interface SourceGates {
	run<T>(sourceKey: string, fn: () => Promise<T>): Promise<T>;
}

export function createSourceGates(): SourceGates {
	const gates = new Map<string, SerialGate>();
	return {
		run(sourceKey, fn) {
			let gate = gates.get(sourceKey);
			if (!gate) {
				gate = createSerialGate();
				gates.set(sourceKey, gate);
			}
			return gate.run(fn);
		},
	};
}

export interface FetchSourceLiveStatusDeps {
	sources: Pick<SourceRegistry, "get">;
	logger: Pick<Logger, "error">;
	gates: SourceGates;
	/** 最多等多久;默认 {@link LOOKUP_TIMEOUT_MS}(测试里给短的)。 */
	timeoutMs?: number;
}

interface SourceMemberFailures<R> {
	missing(): R;
	timeout(): R;
	thrown(): R;
	aborted(): R;
}

/** 在登记表里按身份找来源、过同一来源的串行闸,再交给带超时的 {@link callSource}。 */
function fetchSourceMember<R>(
	deps: {
		sources: Pick<SourceRegistry, "get">;
		logger: Pick<Logger, "error">;
		gates: SourceGates;
		timeoutMs?: number;
	},
	identity: Identity,
	member: string,
	call: ((signal: AbortSignal) => Promise<R>) | undefined,
	failures: SourceMemberFailures<R>,
	signal?: AbortSignal,
): Promise<R> {
	if (!call) return Promise.resolve(failures.missing());
	return deps.gates.run(identity.sourceKey, () =>
		callSource<R>({
			logger: deps.logger,
			sourceKey: identity.sourceKey,
			member,
			timeoutMs: deps.timeoutMs ?? LOOKUP_TIMEOUT_MS,
			call,
			signal,
			onAbort: failures.aborted,
			onTimeout: failures.timeout,
			onThrow: failures.thrown,
		}),
	);
}

/**
 * 宿主问某个来源「这个人此刻在不在播」:经 {@link callSource} 的外壳,同一来源串行。来源没实现 `fetchLiveStatus`
 * (或已不在册)、超时、抛错,都收成 `ok: false`,核心只记日志、跳过这一轮 —— 问题不归核心报。
 */
export function fetchSourceLiveStatus(
	deps: FetchSourceLiveStatusDeps,
	identity: Identity,
	/** 撤销这次调用(来源停用了、场次引擎关停了):在途的那次立刻回 `aborted`,来源手里的 signal 同时中止。 */
	signal?: AbortSignal,
): Promise<LiveStatusResult> {
	// 登记表的视图已把成员包成不丢 `this` 的转发,这里取出来直接调。
	const fetchLiveStatus = deps.sources.get(identity.sourceKey)?.fetchLiveStatus;
	return fetchSourceMember(
		deps,
		identity,
		"fetchLiveStatus",
		fetchLiveStatus && ((sourceSignal) => fetchLiveStatus(identity, sourceSignal)),
		{
			missing: () =>
				fail("unavailable", "the source is gone or does not implement fetchLiveStatus"),
			timeout: () => fail("timeout", "the source did not answer in time"),
			thrown: () => fail("unavailable", "the source threw"),
			aborted: () => fail("unavailable", "the call was cancelled by the host"),
		},
		signal,
	);
}

export interface FetchSourceProfileDeps {
	sources: Pick<SourceRegistry, "get">;
	logger: Pick<Logger, "error">;
	gates: SourceGates;
	/** 最多等多久;默认 {@link LOOKUP_TIMEOUT_MS}(测试里给短的)。 */
	timeoutMs?: number;
}

/**
 * 宿主问某个来源取一个人的资料:经 {@link callSource} 的外壳,与搜人、查直播共用同一来源的串行闸。
 * 来源不在册时按契约是必备成员,仍是 `unavailable`;超时、抛错也收成结果形状。
 */
export function fetchSourceProfile(
	deps: FetchSourceProfileDeps,
	identity: Identity,
	signal?: AbortSignal,
): Promise<Result<CreatorProfileReport>> {
	const fetchProfile = deps.sources.get(identity.sourceKey)?.fetchProfile;
	return fetchSourceMember(
		deps,
		identity,
		"fetchProfile",
		fetchProfile && ((sourceSignal) => fetchProfile(identity, sourceSignal)),
		{
			missing: () => fail("unavailable", "the source is gone or does not implement fetchProfile"),
			timeout: () => fail("timeout", "the source did not answer in time"),
			thrown: () => fail("unavailable", "the source threw"),
			aborted: () => fail("unavailable", "the call was cancelled by the host"),
		},
		signal,
	);
}
