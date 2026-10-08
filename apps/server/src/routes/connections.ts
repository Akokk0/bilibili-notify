import type { ConnectionTestResponse, ConnectionView } from "@bilibili-notify/contract";
import type { ConnectionCapabilities } from "@bilibili-notify/internal";
import { fail, isDirectConnection } from "@bilibili-notify/internal";
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
	 * 平台能力快照(今天只有「能不能签小程序卡」),连接 id → 平台名 → 能力。只列有能力
	 * 概念的平台;官机 / webhook 不在里面,面板据此写「这个平台不支持」。引擎还没起来时是
	 * 空表 —— 面板显示成「未探测」,不算错。
	 *
	 * **第二级这一层是在这儿套上的**:引擎按连接寻址,而直连一条连接就是一个平台,平台名
	 * 从连接自己身上读。接桥之后一条连接驮多个平台,那时这一层要由引擎自己给出,这里改成
	 * 原样透传。
	 */
	app.get("/capabilities", (c) => {
		const engines = deps.runtime.engines;
		const out: Record<string, Record<string, ConnectionCapabilities>> = {};
		if (engines) {
			for (const connection of deps.store.getConnections()) {
				// 第二级这一层只有直连套得上:一条直连就是一个平台。桥接入驮着哪些平台是它
				// 握手时报的,那时这一层要由引擎自己给出,这里改成原样透传。
				if (!isDirectConnection(connection)) continue;
				const caps = engines.connectionCapabilities(connection.id);
				if (caps) out[connection.id] = { [connection.platform]: caps };
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
