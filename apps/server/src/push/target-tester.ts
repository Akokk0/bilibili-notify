import { randomBytes, randomUUID } from "node:crypto";
import type { TargetReceptionTest, TargetTestResponse } from "@bilibili-notify/contract";
import type { InboundMeta, InboundPrivateMessage, Result } from "@bilibili-notify/internal";
import { fail, ok } from "@bilibili-notify/internal";
import type { TargetTestKind } from "@bilibili-notify/internal/push-target";
import type { ConfigStore } from "../config/store.js";
import { t } from "../i18n/index.js";
import type { HostTargetDispatcher } from "./target-dispatcher.js";
import { targetTestSamples } from "./test-media.js";

const TTL_MS = 90_000;
const MAX_SESSIONS = 64;

interface ReceptionSession {
	view: TargetReceptionTest;
	targetId: string;
	connectionId: string;
	scope: "group" | "private";
	address: string;
	fingerprint: string;
	expires: number;
}

/** 宿主拥有的短时测试会话；不落盘，不建立第二条消息事件通道。 */
export function createTargetTester(opts: { store: ConfigStore; dispatcher: HostTargetDispatcher }) {
	const sessions = new Map<string, ReceptionSession>();
	let disposed = false;
	function binding(targetId: string): string | undefined {
		const target = opts.store.getTargets().find((item) => item.id === targetId);
		if (!target?.enabled || target.kind !== "session") return undefined;
		const connection = opts.store.getConnection(target.connectionId);
		if (!connection?.enabled || !opts.dispatcher.isAvailable(targetId)) return undefined;
		return JSON.stringify([
			target.connectionId,
			target.scope,
			target.address,
			target.parentAddress,
			connection.adapterKey,
			connection.platform,
			connection.settings,
		]);
	}
	function prune(): void {
		for (const [id, session] of sessions) {
			if (Date.now() > session.expires + TTL_MS) {
				sessions.delete(id);
				continue;
			}
			if (session.view.state !== "pending") continue;
			if (disposed || binding(session.targetId) !== session.fingerprint)
				session.view.state = "cancelled";
			else if (Date.now() >= session.expires) session.view.state = "expired";
		}
	}
	return {
		async run(
			targetId: string,
			kind: TargetTestKind,
			options?: { confirmAtAll?: boolean },
			signal?: AbortSignal,
		): Promise<TargetTestResponse> {
			if (disposed || signal?.aborted) return fail("unavailable", t("targets.status.cancelled"));
			if (kind !== "inbound")
				return opts.dispatcher.sendTest(
					targetId,
					kind,
					targetTestSamples(t("service.routes.targets.text.5")),
					options,
				);
			prune();
			const target = opts.store.getTargets().find((item) => item.id === targetId);
			if (!target) return fail("not_found", t("service.routes.targets.text.8"));
			if (target.kind !== "session" || target.scope === "channel")
				return fail("unsupported", t("capabilityTests.inboundScope"));
			const support = opts.dispatcher.connectionCapabilities(target.connectionId)?.inbound;
			if (support?.state === "unsupported")
				return fail("unsupported", support.reason ?? t("capabilityTests.unsupported"));
			const fingerprint = binding(targetId);
			if (!fingerprint) return fail("not_configured", t("capabilityTests.inactive"));
			for (const [id, previous] of sessions)
				if (previous.targetId === targetId || previous.view.state !== "pending")
					sessions.delete(id);
			if (sessions.size >= MAX_SESSIONS) return fail("rate_limited", t("capabilityTests.tooMany"));
			const expires = Date.now() + TTL_MS;
			const view: TargetReceptionTest = {
				id: randomUUID(),
				state: "pending",
				reply: `BN-${randomBytes(8).toString("hex")}`,
				expiresAt: new Date(expires).toISOString(),
			};
			const session: ReceptionSession = {
				view,
				expires,
				fingerprint,
				targetId,
				connectionId: target.connectionId,
				scope: target.scope,
				address: target.address,
			};
			// 在提示发送前登记，避免快速回传先于发送回应到达。
			sessions.set(view.id, session);
			const cancel = () => {
				view.state = "cancelled";
			};
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				const result = await opts.dispatcher.sendTest(
					targetId,
					"text",
					targetTestSamples(t("capabilityTests.replyPrompt", { reply: view.reply })),
				);
				if (!result.ok || result.isSynthetic) {
					sessions.delete(view.id);
					return result.ok ? fail("unsupported", t("capabilityTests.interceptedInbound")) : result;
				}
				prune();
				if (!sessions.has(view.id) || view.state === "cancelled")
					return fail("conflict", t("targets.status.changed"));
				return ok({ latencyMs: result.latencyMs, reception: { ...view } });
			} finally {
				signal?.removeEventListener("abort", cancel);
			}
		},
		read(targetId: string, id: string): Result<{ test: TargetReceptionTest }> {
			prune();
			const found = sessions.get(id);
			return found?.targetId === targetId
				? ok({ test: { ...found.view } })
				: fail("not_found", t("capabilityTests.notFound"));
		},
		cancel(targetId: string, id: string): void {
			const session = sessions.get(id);
			if (session?.targetId === targetId) sessions.delete(id);
		},
		receive(
			scope: "group" | "private",
			message: InboundPrivateMessage,
			meta: InboundMeta,
		): boolean {
			prune();
			for (const session of sessions.values()) {
				if (
					session.view.state === "pending" &&
					session.connectionId === meta.connectionId &&
					session.scope === scope &&
					session.address === message.address &&
					message.text.trim() === session.view.reply
				) {
					session.view.state = "received";
					return true;
				}
			}
			return false;
		},
		prune,
		dispose(): void {
			disposed = true;
			sessions.clear();
		},
	};
}
