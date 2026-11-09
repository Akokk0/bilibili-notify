import { logText } from "../i18n/index.js";
/**
 * 连接探测:宿主按自己的时钟,定时问每条启用的连接「通不通」,把结果写回连接的 `probeState`,
 * 断了、好了记进问题表。
 *
 * 后台这一轮只调适配器的 `probe`(没有副作用,不发消息),所以面板不用主人逐条点「测试」,
 * 圆点也反映实况。探测自己有时钟,是宿主一侧按职责起名的长期部件,放在 `push/`,
 * 因为连接、派发、适配器都在这里。
 *
 * 节奏与写盘的规矩:
 * - 每 60 秒一轮,每条连接各自探、一轮里并行;同一条连接上一次还没探完就跳过它这一次。
 * - 连续两次探不通才算断;中间通过一次,失败的计数清零。计数只在内存里。
 * - 只在状态变了才写盘(今天每轮都写会让订了连接变更的适配器每轮对一次账);
 *   所以后台写下的 `lastCheckedAt` 是「状态变的那一刻」,手动探测每次都写,它是最近一次写入的时刻。
 * - `rate_limited` 是对端活着、只是被限流:不算失败也不算通,状态与计数都不动。
 *
 * 报问题的规矩(记在连接所属适配器名下,关于这条连接):
 * - 连续两次探不通就报「连不上」;探通了就清(缺省通知,通知器只对真私聊过的补「已恢复」)。
 * - 只有「运行中断了」才私聊:这次中断开始时,这条连接自从开机或改设置之后通过过,
 *   且主人的私聊目标不走这条连接(走的话发不出去),且探不通的码不是主人去动手才会好的那两种
 *   (`not_configured` / `not_found`)。私聊与否在这次中断开始时定下,中断里不翻。
 * - 停用的连接清掉它的问题且不补「已恢复」;适配器不在场的连接不探、不报。
 *
 * 手动「测试」只算恢复、不算失败:探通了当场清问题,不通只写盘、不加失败次数 ——
 * 主人正盯着面板,连点两次「测试」不该凑出一条私聊。
 */

import {
	type Connection,
	type ConnectionCapabilities,
	type ConnectionProbeState,
	fail,
	type Logger,
	type PlatformAdapter,
	type ProbeResult,
	type ServiceContext,
	type TargetDispatcher,
} from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";
import type { ProblemTable } from "../problems/problem-table.js";
import { resolveSettings, settingsIssueMessage } from "./connection-settings.js";

/** 后台每轮探测的间隔。 */
const CONNECTION_PROBE_INTERVAL_MS = 60 * 1000;
/** 单次连通探测的限时。契约里 `probe` 不收 `signal`,到点只是宿主不再等,适配器那边的请求不会被取消。 */
const CONNECTION_PROBE_TIMEOUT_MS = 30 * 1000;
/** 连续这么多次探不通才算断。 */
const FAILURES_BEFORE_UNREACHABLE = 2;
/** 宿主替连接报「连不上」用的问题码。 */
const UNREACHABLE_CODE = "connection_unreachable";
/** 宿主替连接报「设置不合法」用的问题码。 */
const SETTINGS_INVALID_CODE = "connection_settings_invalid";
/** 这两种码是「要主人去动手才会好」(接入没了、没配好),等是等不好的:只进表,不私聊。 */
const NEEDS_OWNER_ACTION_CODES: ReadonlySet<string> = new Set(["not_configured", "not_found"]);

export interface ConnectionProbeEngineOptions {
	/** 现读整张连接表 —— 只留给本来就要全表的 `checkSettings` / `probeAll`,每轮各一次。 */
	getConnections(): readonly Connection[];
	/** 现读一条连接(含盘上的 `probeState`):按 id 查的走这里,别拿整表再 find。 */
	getConnection(connectionId: string): Connection | undefined;
	/** 探连通与能力用派发器现成的三个口。 */
	dispatcher: Pick<
		TargetDispatcher,
		"probeConnection" | "connectionCapabilities" | "probeConnectionCapabilities"
	>;
	/** 只换探测状态那一格(宿主独写)。 */
	recordProbeState(connectionId: string, state: ConnectionProbeState): Promise<unknown>;
	/** 问题表的写口:宿主替连接报与清。 */
	problems: Pick<ProblemTable, "report" | "resolve">;
	/** 主人私聊目标走的是哪条连接(没设主人就没有)。每次现读。 */
	masterConnectionId(): string | undefined;
	/** 这个适配器键此刻在不在场(拓展停了就不在);在场的交出它的设置规则。每次现读。 */
	adapterOf(adapterKey: string): Pick<PlatformAdapter, "settingsSchema"> | undefined;
	serviceCtx: Pick<ServiceContext, "signal" | "track">;
	logger: Logger;
	intervalMs?: number;
}

export interface ConnectionProbeEngine {
	/**
	 * 探一条连接并顺路补探能力。`manual`(主人点「测试」):结果每次都写盘,
	 * 通了当场清问题,不通不算进失败次数,被限流(`rate_limited`)什么都不动。不带 `manual` 只回结果、不写任何东西。
	 */
	probe(connectionId: string, options?: { manual?: boolean }): Promise<ProbeResult>;
	/**
	 * 只对一遍各连接的设置合不合适配器的规则、记账(不合法的报、好了的清),不探测。
	 * 连接变更时调它,新填的设置不用等下一轮;不能在这里触发探测 —— 探测写回 `probeState`
	 * 会再发一次连接变更,那是死循环。同一句不会重复报。
	 */
	checkSettings(): void;
	/** 停掉定时器。 */
	dispose(): void;
}

/** 任一格能力还停在「未探测」。 */
function hasUnknownCapability(capabilities: ConnectionCapabilities | undefined): boolean {
	if (!capabilities) return false;
	return Object.values(capabilities).some((support) => support.state === "unknown");
}

/** 一次还开着的「连不上」。 */
interface Outage {
	reporter: string;
	/** 这次中断开始时定下,中断里不翻。 */
	notify: boolean;
	/** 上一次报上去的整句,原因没变就不再报。 */
	message?: string;
}

export function createConnectionProbeEngine(
	opts: ConnectionProbeEngineOptions,
): ConnectionProbeEngine {
	const { dispatcher, serviceCtx, logger: log } = opts;
	/** 每条连接此刻在途的一次探测(含写盘)。 */
	const inFlight = new Set<string>();
	/** 每条连接连续探不通的次数。 */
	const failures = new Map<string, number>();
	/** 自从开机或改设置之后通过过的连接。 */
	const hasBeenUp = new Set<string>();
	/** 每条连接设置的指纹,变了就当主人动过手。 */
	const fingerprints = new Map<string, string>();
	/** 还开着的「连不上」。 */
	const outages = new Map<string, Outage>();
	/** 还开着的「设置不合法」。 */
	const invalid = new Map<string, { reporter: string; message: string }>();

	/** 只罩连通探测这一次调用,不罩顺路补探的能力 —— 通的连接补探能力慢一点不该被当成超时。 */
	async function probeReachability(connectionId: string): Promise<ProbeResult> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<ProbeResult>((resolve) => {
			timer = setTimeout(
				() => resolve(fail("timeout", t("connection.probe.timeout"))),
				CONNECTION_PROBE_TIMEOUT_MS,
			);
			timer.unref?.();
		});
		try {
			return await Promise.race([dispatcher.probeConnection(connectionId), timedOut]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * 健康探测 + 顺路补探能力:连上那一刻没探到(反向 ws 的 bot 是后来才连入的)、或探的
	 * 时候没连上,能力会停在「未探测」;开机、每分钟、主人点「测试」都从这儿再给一次机会。
	 * 只补「未探测」的,已经有答案的不重探 —— 那是 reconcile 的事。
	 */
	async function probeWithCapabilities(connectionId: string): Promise<ProbeResult> {
		const result = await probeReachability(connectionId);
		// 连都连不上的连接,能力必然也探不出来 —— 再问一次只是白等满一整个超时。
		// (`unsupported` 是「没有探测协议」,不是连不上,不在此列。)
		if (!result.ok && result.code !== "unsupported") return result;
		if (hasUnknownCapability(dispatcher.connectionCapabilities(connectionId))) {
			await dispatcher.probeConnectionCapabilities(connectionId);
		}
		return result;
	}

	/** 盘上此刻的状态:每次现读一条,不信一轮开头拿的快照。 */
	const connectionOf = (connectionId: string) => opts.getConnection(connectionId);
	const statusOnDisk = (connectionId: string) => connectionOf(connectionId)?.probeState?.status;

	const outageKey = (connectionId: string, reporter: string) => ({
		reporter,
		about: { connectionId },
		code: UNREACHABLE_CODE,
	});

	/** 探通了:清掉这条连接开着的「连不上」。 */
	function closeOutage(connectionId: string, options?: { notify?: boolean }): void {
		const outage = outages.get(connectionId);
		if (!outage) return;
		outages.delete(connectionId);
		const key = outageKey(connectionId, outage.reporter);
		if (options) opts.problems.resolve(key, options);
		else opts.problems.resolve(key);
	}

	/** 连续两次探不通:开一条(或原因变了换文案)。 */
	function openOutage(connection: Connection, failure: { code: string; message: string }): void {
		let outage = outages.get(connection.id);
		if (!outage) {
			outage = {
				reporter: connection.adapterKey,
				notify:
					hasBeenUp.has(connection.id) &&
					opts.masterConnectionId() !== connection.id &&
					!NEEDS_OWNER_ACTION_CODES.has(failure.code),
			};
			outages.set(connection.id, outage);
		}
		const reason = failure.message;
		const wording = () => t("problem.connection.unreachable", { name: connection.name, reason });
		const message = wording();
		if (outage.message === message) return;
		outage.message = message;
		opts.problems.report({
			...outageKey(connection.id, outage.reporter),
			message: wording,
			notify: outage.notify,
			recoveryMessage: () => t("problem.connection.recovered", { name: connection.name }),
		});
	}

	async function recordState(connectionId: string, state: ConnectionProbeState): Promise<void> {
		await opts.recordProbeState(connectionId, state);
	}

	async function probeOne(connection: Connection): Promise<void> {
		const connectionId = connection.id;
		if (inFlight.has(connectionId)) return;
		inFlight.add(connectionId);
		try {
			const result = await probeWithCapabilities(connectionId);
			// 探不了的连接(如 webhook):记成 `unsupported`(不是通也不是不通),已经是它的不再写。
			if (!result.ok && result.code === "unsupported") {
				failures.delete(connectionId);
				if (statusOnDisk(connectionId) === "unsupported") return;
				await recordState(connectionId, {
					status: "unsupported",
					lastCheckedAt: new Date().toISOString(),
				});
				return;
			}
			// 被限流 = 对端活着:不算失败也不算通,状态与计数都不动。
			if (!result.ok && result.code === "rate_limited") {
				warnRateLimited(connectionId, result.message);
				return;
			}
			if (result.ok) {
				failures.delete(connectionId);
				hasBeenUp.add(connectionId);
				closeOutage(connectionId);
				if (statusOnDisk(connectionId) === "reachable") return;
				await recordState(connectionId, {
					status: "reachable",
					lastCheckedAt: new Date().toISOString(),
					latencyMs: result.latencyMs,
				});
				return;
			}
			const count = (failures.get(connectionId) ?? 0) + 1;
			failures.set(connectionId, count);
			if (count < FAILURES_BEFORE_UNREACHABLE) return;
			// 设置不合法的连接,派发器探测必回 `not_configured`:那已经由「设置不合法」那一条说了,
			// 不再另报一条「连不上」(`probeState` 照旧记成不通并带原话)。
			if (!invalid.has(connectionId)) openOutage(connection, result);
			if (statusOnDisk(connectionId) === "unreachable") return;
			// 失败的原话填进 `message`,码不落盘。
			await recordState(connectionId, {
				status: "unreachable",
				lastCheckedAt: new Date().toISOString(),
				message: result.message,
			});
		} catch (e) {
			log.warn(logText("log.probe.updateFailed"), { connectionId, stage: "background", error: e });
		} finally {
			inFlight.delete(connectionId);
		}
	}

	const warnRateLimited = (connectionId: string, message: string): void =>
		log.warn(logText("log.probe.rateLimited"), { connectionId, message });

	/** 主人点「测试」:每次都写盘;通了当场清问题,不通不加失败次数;被限流则什么都不动。 */
	async function settleManual(connectionId: string, result: ProbeResult): Promise<void> {
		// 被限流 = 对端活着:与后台一样,状态、计数、问题都不动,只把结果回给面板。
		if (!result.ok && result.code === "rate_limited") {
			warnRateLimited(connectionId, result.message);
			return;
		}
		const checkedAt = new Date().toISOString();
		try {
			if (result.ok) {
				failures.delete(connectionId);
				hasBeenUp.add(connectionId);
				closeOutage(connectionId);
				await recordState(connectionId, {
					status: "reachable",
					lastCheckedAt: checkedAt,
					latencyMs: result.latencyMs,
				});
			} else if (result.code === "unsupported") {
				await recordState(connectionId, { status: "unsupported", lastCheckedAt: checkedAt });
			} else {
				await recordState(connectionId, {
					status: "unreachable",
					lastCheckedAt: checkedAt,
					message: result.message,
				});
			}
		} catch (e) {
			log.warn(logText("log.probe.updateFailed"), { connectionId, stage: "manual", error: e });
		}
	}

	async function probe(connectionId: string, options?: { manual?: boolean }): Promise<ProbeResult> {
		const result = await probeWithCapabilities(connectionId);
		if (options?.manual) await settleManual(connectionId, result);
		return result;
	}

	/** 这条连接不探了(停用、适配器不在场):它的计数、「连上过」、开着的问题都丢。 */
	function forget(connectionId: string): void {
		failures.delete(connectionId);
		hasBeenUp.delete(connectionId);
		fingerprints.delete(connectionId);
		closeOutage(connectionId, { notify: false });
	}

	/** 设置好了(或这条连接不再适用):清掉「设置不合法」,不补「已恢复」。 */
	function clearInvalid(connectionId: string): void {
		const entry = invalid.get(connectionId);
		if (!entry) return;
		invalid.delete(connectionId);
		opts.problems.resolve(
			{ reporter: entry.reporter, about: { connectionId }, code: SETTINGS_INVALID_CODE },
			{ notify: false },
		);
	}

	function checkSettings(): void {
		const connections = opts.getConnections();
		for (const connection of connections) {
			const adapter = connection.enabled ? opts.adapterOf(connection.adapterKey) : undefined;
			const resolved = adapter && resolveSettings(adapter.settingsSchema, connection.settings);
			if (!resolved || resolved.ok) {
				clearInvalid(connection.id);
				continue;
			}
			const wording = () =>
				t("problem.connection.settingsInvalid", {
					name: connection.name,
					reason: settingsIssueMessage(resolved.issues ?? []),
				});
			const message = wording();
			if (invalid.get(connection.id)?.message === message) continue;
			invalid.set(connection.id, { reporter: connection.adapterKey, message });
			// 只留一条:设置不合法了,先前开着的「连不上」没有意义了。
			closeOutage(connection.id, { notify: false });
			opts.problems.report({
				reporter: connection.adapterKey,
				about: { connectionId: connection.id },
				code: SETTINGS_INVALID_CODE,
				message: wording,
				notify: false,
			});
		}
		// 删掉的连接:关于它的问题宿主已经清了,这里只丢自己的账。
		const known = new Set(connections.map((c) => c.id));
		for (const id of invalid.keys()) if (!known.has(id)) invalid.delete(id);
	}

	async function probeAll(): Promise<void> {
		// 关停一开始就不再起新的一轮:登记进 track 之后不能靠预算硬等它。
		if (serviceCtx.signal.aborted) return;
		checkSettings();
		const connections = opts.getConnections();
		const toProbe: Connection[] = [];
		for (const connection of connections) {
			if (!connection.enabled || !opts.adapterOf(connection.adapterKey)) {
				forget(connection.id);
				continue;
			}
			// 设置变了就当主人动过手:失败的计数与「连上过」从头来,此后断了只进表。
			const fingerprint = JSON.stringify(connection.settings);
			const previous = fingerprints.get(connection.id);
			if (previous !== undefined && previous !== fingerprint) {
				failures.delete(connection.id);
				hasBeenUp.delete(connection.id);
			}
			fingerprints.set(connection.id, fingerprint);
			toProbe.push(connection);
		}
		// 删掉的连接:关于它的问题宿主已经清了(`clearConnection`),这里只丢自己的账。
		const known = new Set(connections.map((c) => c.id));
		for (const id of outages.keys()) if (!known.has(id)) outages.delete(id);
		for (const id of failures.keys()) if (!known.has(id)) failures.delete(id);
		for (const id of hasBeenUp) if (!known.has(id)) hasBeenUp.delete(id);
		for (const id of fingerprints.keys()) if (!known.has(id)) fingerprints.delete(id);
		await Promise.all(toProbe.map((c) => probeOne(c)));
	}

	// 引擎起来先探一轮,之后按定时器轮询。
	// 探测结果经 recordProbeState 写回连接表:登记进 track,关停等这笔写交进 config 写道。
	const trackProbe = (): void => {
		serviceCtx.track(probeAll().catch((e) => log.warn(logText("log.probe.failed"), { error: e })));
	};
	trackProbe();
	const timer = setInterval(trackProbe, opts.intervalMs ?? CONNECTION_PROBE_INTERVAL_MS);
	// 别让定时器拖住进程退出。
	timer.unref?.();

	return {
		probe,
		checkSettings,
		dispose: () => clearInterval(timer),
	};
}
