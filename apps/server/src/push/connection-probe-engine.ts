/**
 * 连接探测:宿主按自己的时钟,定时问每条启用的连接「通不通」,把结果写回连接的 `probeState`。
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
 */

import {
	type Connection,
	type ConnectionCapabilities,
	type ConnectionProbeState,
	fail,
	type Logger,
	type ProbeResult,
	type ServiceContext,
	type TargetDispatcher,
} from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";

/** 后台每轮探测的间隔。 */
const CONNECTION_PROBE_INTERVAL_MS = 60 * 1000;
/** 单次连通探测的限时。契约里 `probe` 不收 `signal`,到点只是宿主不再等,适配器那边的请求不会被取消。 */
const CONNECTION_PROBE_TIMEOUT_MS = 30 * 1000;
/** 连续这么多次探不通才算断。 */
const FAILURES_BEFORE_UNREACHABLE = 2;

export interface ConnectionProbeEngineOptions {
	/** 现读连接表,每轮都读最新的。 */
	getConnections(): readonly Connection[];
	/** 探连通与能力用派发器现成的三个口。 */
	dispatcher: Pick<
		TargetDispatcher,
		"probeConnection" | "connectionCapabilities" | "probeConnectionCapabilities"
	>;
	/** 只换探测状态那一格(宿主独写)。 */
	recordProbeState(connectionId: string, state: ConnectionProbeState): Promise<unknown>;
	serviceCtx: Pick<ServiceContext, "signal" | "track">;
	logger: Logger;
	intervalMs?: number;
}

export interface ConnectionProbeEngine {
	/** 探一条连接并顺路补探能力。 */
	probe(connectionId: string): Promise<ProbeResult>;
	/** 停掉定时器。 */
	dispose(): void;
}

/** 任一格能力还停在「未探测」。 */
function hasUnknownCapability(capabilities: ConnectionCapabilities | undefined): boolean {
	if (!capabilities) return false;
	return Object.values(capabilities).some((support) => support.state === "unknown");
}

export function createConnectionProbeEngine(
	opts: ConnectionProbeEngineOptions,
): ConnectionProbeEngine {
	const { dispatcher, serviceCtx, logger: log } = opts;
	/** 每条连接此刻在途的一次探测(含写盘)。 */
	const inFlight = new Set<string>();
	/** 每条连接连续探不通的次数。 */
	const failures = new Map<string, number>();

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
	async function probe(connectionId: string): Promise<ProbeResult> {
		const result = await probeReachability(connectionId);
		// 连都连不上的连接,能力必然也探不出来 —— 再问一次只是白等满一整个超时。
		// (`unsupported` 是「没有探测协议」,不是连不上,不在此列。)
		if (!result.ok && result.code !== "unsupported") return result;
		if (hasUnknownCapability(dispatcher.connectionCapabilities(connectionId))) {
			await dispatcher.probeConnectionCapabilities(connectionId);
		}
		return result;
	}

	/** 盘上此刻的状态:每次现读,不信一轮开头拿的快照。 */
	const statusOnDisk = (connectionId: string) =>
		opts.getConnections().find((c) => c.id === connectionId)?.probeState?.status;

	async function probeOne(connectionId: string): Promise<void> {
		if (inFlight.has(connectionId)) return;
		inFlight.add(connectionId);
		try {
			const result = await probe(connectionId);
			// 探不了的连接(如 webhook):记成 `unsupported`(不是通也不是不通),已经是它的不再写。
			if (!result.ok && result.code === "unsupported") {
				failures.delete(connectionId);
				if (statusOnDisk(connectionId) === "unsupported") return;
				await opts.recordProbeState(connectionId, {
					status: "unsupported",
					lastCheckedAt: new Date().toISOString(),
				});
				return;
			}
			// 被限流 = 对端活着:不算失败也不算通,状态与计数都不动。
			if (!result.ok && result.code === "rate_limited") {
				log.warn(`[probe] connection ${connectionId} rate limited: ${result.message}`);
				return;
			}
			if (result.ok) {
				failures.delete(connectionId);
				if (statusOnDisk(connectionId) === "reachable") return;
				await opts.recordProbeState(connectionId, {
					status: "reachable",
					lastCheckedAt: new Date().toISOString(),
					latencyMs: result.latencyMs,
				});
				return;
			}
			const count = (failures.get(connectionId) ?? 0) + 1;
			failures.set(connectionId, count);
			if (count < FAILURES_BEFORE_UNREACHABLE) return;
			if (statusOnDisk(connectionId) === "unreachable") return;
			// 失败的原话填进 `message`,码不落盘。
			await opts.recordProbeState(connectionId, {
				status: "unreachable",
				lastCheckedAt: new Date().toISOString(),
				message: result.message,
			});
		} catch (e) {
			log.warn(`[probe] connection ${connectionId} update failed: ${String(e)}`);
		} finally {
			inFlight.delete(connectionId);
		}
	}

	async function probeAll(): Promise<void> {
		// 关停一开始就不再起新的一轮:登记进 track 之后不能靠预算硬等它。
		if (serviceCtx.signal.aborted) return;
		const enabled = opts.getConnections().filter((c) => c.enabled);
		// 停用或删掉的连接,失败的计数一起丢 —— 再启用时从头数。
		const live = new Set(enabled.map((c) => c.id));
		for (const id of failures.keys()) if (!live.has(id)) failures.delete(id);
		await Promise.all(enabled.map((c) => probeOne(c.id)));
	}

	// 引擎起来先探一轮,之后按定时器轮询。
	// 探测结果经 recordProbeState 写回连接表:登记进 track,关停等这笔写交进 config 写道。
	const trackProbe = (): void => {
		serviceCtx.track(probeAll().catch((e) => log.warn(`[probe] 健康探测失败: ${String(e)}`)));
	};
	trackProbe();
	const timer = setInterval(trackProbe, opts.intervalMs ?? CONNECTION_PROBE_INTERVAL_MS);
	// 别让定时器拖住进程退出。
	timer.unref?.();

	return {
		probe,
		dispose: () => clearInterval(timer),
	};
}
