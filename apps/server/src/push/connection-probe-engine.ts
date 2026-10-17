/**
 * 连接探测:宿主按自己的时钟,定时问每条启用的连接「通不通」,把结果写回连接的 `probeState`。
 *
 * 后台这一轮只调适配器的 `probe`(没有副作用,不发消息),所以面板不用主人逐条点「测试」,
 * 圆点也反映实况。探测自己有时钟,是宿主一侧按职责起名的长期部件,放在 `push/`,
 * 因为连接、派发、适配器都在这里。
 */

import type {
	Connection,
	ConnectionCapabilities,
	ConnectionProbeState,
	Logger,
	ProbeResult,
	ServiceContext,
	TargetDispatcher,
} from "@bilibili-notify/internal";

/** 后台每轮探测的间隔。 */
const CONNECTION_PROBE_INTERVAL_MS = 5 * 60 * 1000;

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
	let probeInFlight = false;

	/**
	 * 健康探测 + 顺路补探能力:连上那一刻没探到(反向 ws 的 bot 是后来才连入的)、或探的
	 * 时候没连上,能力会停在「未探测」;开机、每五分钟、主人点「测试」都从这儿再给一次机会。
	 * 只补「未探测」的,已经有答案的不重探 —— 那是 reconcile 的事。
	 */
	async function probe(connectionId: string): Promise<ProbeResult> {
		const result = await dispatcher.probeConnection(connectionId);
		// 连都连不上的连接,能力必然也探不出来 —— 再问一次只是白等满一整个超时,
		// 而这条路是每五分钟一轮、逐个 await 的,离线的连接会把整轮时间翻倍。
		// (`unsupported` 是「没有探测协议」,不是连不上,不在此列。)
		if (!result.ok && result.code !== "unsupported") return result;
		if (hasUnknownCapability(dispatcher.connectionCapabilities(connectionId))) {
			await dispatcher.probeConnectionCapabilities(connectionId);
		}
		return result;
	}

	async function probeAll(): Promise<void> {
		if (probeInFlight) return;
		probeInFlight = true;
		try {
			for (const connection of opts.getConnections()) {
				if (!connection.enabled) continue;
				// 关停一开始就不再起新的探测:一轮探下来要等每条连接的超时,登记进 track 之后
				// 不能靠预算硬等它。
				if (serviceCtx.signal.aborted) break;
				try {
					const result = await probe(connection.id);
					// 探不了的连接(如 webhook):记成 `unsupported`(不是通也不是不通),但已经是它的不再写 ——
					// 否则每条这样的连接每五分钟多一次写盘与 `config-changed`。
					if (!result.ok && result.code === "unsupported") {
						if (connection.probeState?.status === "unsupported") continue;
						await opts.recordProbeState(connection.id, {
							status: "unsupported",
							lastCheckedAt: new Date().toISOString(),
						});
						continue;
					}
					// 失败的原话填进 `message`,码不落盘。
					await opts.recordProbeState(
						connection.id,
						result.ok
							? {
									status: "reachable",
									lastCheckedAt: new Date().toISOString(),
									latencyMs: result.latencyMs,
								}
							: {
									status: "unreachable",
									lastCheckedAt: new Date().toISOString(),
									message: result.message,
								},
					);
				} catch (e) {
					log.warn(`[probe] connection ${connection.id} update failed: ${String(e)}`);
				}
			}
		} finally {
			probeInFlight = false;
		}
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
