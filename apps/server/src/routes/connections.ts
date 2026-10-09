import type {
	ConnectionCapabilitiesMap,
	ConnectionTestResponse,
	ConnectionView,
} from "@bilibili-notify/contract";
import { fail } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { ConfigValidationError } from "../config/store.js";
import { maskedCellsFailure } from "./masked-cells.js";
import { readJsonBody, readJsonObject } from "./request-body.js";
import { ENGINES_NOT_READY_MESSAGE, respondFailure } from "./respond-failure.js";
import { connectionView } from "./secret-view.js";
import { testResultOfProbe } from "./test-result.js";
import type { RouteDeps } from "./types.js";

/**
 * `/api/connections` — CRUD on the Connection[] list.
 *
 * A connection is one instance of somewhere to send to: an OneBot HTTP
 * endpoint, a webhook URL. PushTargets reference one by `connectionId`, so
 * deleting a connection any target still points at is rejected with 409 and
 * the caller detaches first.
 *
 * 凭据下发打码(ADR-0021 决策 44):读与写的响应里 `secret` 标记的格是 `{ masked }`;写入带着遮挡回 400,
 * 不带 = 保留已存的,清空交空串 / null。POST 只管新建(同 id 已存在回 409),编辑走 PATCH。
 *
 * 失败一律经 `respondFailure`(ADR-0026):store 拒收时抛的 `ConfigValidationError` 自带标准码,
 * 路由按码回(不合规 400、没这条 404、还被目标引用着 409),不嗅文案。
 */
export function createConnectionsRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	/** 下发前密钥格打码(`secret` 标记);盘上与引擎里仍是明文。 */
	const viewsOf = (): ConnectionView[] => deps.store.getConnections().map(connectionView);

	app.get("/", (c) => c.json(viewsOf()));

	/**
	 * 连接能力快照(@全体 / 收不收得到回复 / 小程序卡三项),连接 id → 这条连接的能力。
	 * **直连与拓展连接都列**:一条连接就是一个 bot(ADR-0012 决策 45),能力由它的适配器按连接答。
	 * 适配器给不出能力的连接(没有适配器管、适配器没实现)不列,面板按「还不知道」算;
	 * 引擎还没起来时是空表 —— 同样显示成「还不知道」,不算错。
	 */
	app.get("/capabilities", (c) => {
		const engines = deps.runtime.engines;
		const out: ConnectionCapabilitiesMap = {};
		if (engines) {
			for (const connection of deps.store.getConnections()) {
				const caps = engines.connectionCapabilities(connection.id);
				if (caps) out[connection.id] = caps;
			}
		}
		return c.json(out);
	});

	app.post("/", async (c) => {
		const read = await readJsonBody(c);
		if (!read.ok) return respondFailure(c, read);
		const masked = maskedCellsFailure(read.body);
		if (masked) return respondFailure(c, masked);
		try {
			// 只管新建 —— 整条覆盖里「没带这一格」与「清空这一格」分不开,编辑一律走 PATCH。
			await deps.store.createConnection(read.body as never);
			return c.json(viewsOf(), 200);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("POST /api/connections failed", err);
			throw err;
		}
	});

	app.patch("/:id", async (c) => {
		const id = c.req.param("id");
		const read = await readJsonObject(c);
		if (!read.ok) return respondFailure(c, read);
		const masked = maskedCellsFailure(read.body);
		if (masked) return respondFailure(c, masked);
		try {
			const next = await deps.store.patchConnection(id, read.body);
			return c.json(connectionView(next));
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("PATCH /api/connections/:id failed", err);
			throw err;
		}
	});

	app.post("/:id/probe", async (c) => {
		const id = c.req.param("id");
		const connection = deps.store.getConnections().find((a) => a.id === id);
		if (!connection) return respondFailure(c, fail("not_found", "没有这条连接"));
		const engines = deps.runtime.engines;
		if (!engines) return respondFailure(c, fail("unavailable", ENGINES_NOT_READY_MESSAGE));
		const result = await engines.probeConnection(id);
		// Persist the probe outcome to the connection's testStatus so the dashboard's
		// status dot reflects this click without waiting for the 5-min poller.
		// `unsupported` (no probe protocol) deliberately doesn't write back — we
		// want the UI to remain "pending / unsupported" rather than green or red.
		// 🔴 `testStatus.err` 是盘上的老格式(3a-21 整个换成 `probeState`):这里把失败的原话填进去,
		// 码不落盘。回给面板的形状在 {@link testResultOfProbe} 里另翻。
		if (result.ok || result.code !== "unsupported") {
			try {
				await deps.store.patchConnection(id, {
					testStatus: {
						ok: result.ok,
						lastCheckedAt: new Date().toISOString(),
						latencyMs: result.ok ? result.latencyMs : undefined,
						err: result.ok ? undefined : result.message,
					},
				});
			} catch (err) {
				log.warn(`POST /api/connections/${id}/probe patchConnection failed: ${String(err)}`);
			}
		}
		return c.json<ConnectionTestResponse>(testResultOfProbe(result));
	});

	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		try {
			const removed = await deps.store.deleteConnection(id);
			if (!removed) return respondFailure(c, fail("not_found", "没有这条连接"));
			return c.body(null, 204);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("DELETE /api/connections/:id failed", err);
			throw err;
		}
	});

	return app;
}
