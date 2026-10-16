import type {
	ConnectionAuthBeginResponse,
	ConnectionAuthDraftResponse,
	ConnectionAuthStateResponse,
	ConnectionCandidatesResponse,
} from "@bilibili-notify/contract";
import { type ConnectionAuth, type Failure, fail, type Result } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { errorMessageOf } from "../util/error-message.js";
import { respondFailure } from "./respond-failure.js";
import type { RouteDeps } from "./types.js";

/**
 * `/api/adapters` — 适配器自带的扫码建连接(`connectionAuth`,ADR-0024 决策 3)。
 *
 * - `GET /:adapterKey/candidates` 新建连接时供挑的候选(内置的模板候选、桥在线的 bot),ADR-0024 决策 4。
 * - `POST /:adapterKey/auth` 发起;`GET /:adapterKey/auth/:taskId` 读状态(不带草稿、不清草稿);
 *   `POST /:adapterKey/auth/:taskId/draft` 取走草稿(取走即清,响应头 `no-store`)。
 *
 * 路由直接问适配器登记表,不经派发器与引擎装配 —— 发起时还没有连接,只有适配器键。任务表住适配器里,
 * 这里不持有任何状态。⚠️ 回包**逐格挑**:不展开适配器的返回值,也不把它整个打进日志
 * (草稿里有密钥)。
 *
 * 失败一律经 `respondFailure`(ADR-0026):适配器不在 `unavailable`、没这个成员 `unsupported`,
 * 其余按适配器回的码原样翻。
 */
export function createAdaptersRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	/** 键 → 适配器的 `connectionAuth`;不成立就地回失败。 */
	function authOf(adapterKey: string): { auth: ConnectionAuth } | { failure: Failure } {
		const adapter = deps.runtime.adapterRegistry.list().find((a) => a.adapterKey === adapterKey);
		if (!adapter) return { failure: fail("unavailable", "这种连接的适配器没在跑") };
		if (!adapter.connectionAuth) {
			return { failure: fail("unsupported", "这种连接没有扫码建连接的办法") };
		}
		return { auth: adapter.connectionAuth };
	}

	/** 适配器「不许抛」;真抛了算 bug,记一行 error(只记抛出来的话)、回 `unavailable`。 */
	async function guarded<T extends object>(
		where: string,
		call: () => Promise<Result<T>>,
	): Promise<Result<T>> {
		try {
			return await call();
		} catch (err) {
			log.error(`${where} threw: ${errorMessageOf(err)}`);
			return fail("unavailable", errorMessageOf(err));
		}
	}

	// 候选只问登记表的视图(不带 `send`):发送只许经派发器(出口咽喉)。内置与拓展同一个口。
	app.get("/:adapterKey/candidates", async (c) => {
		const adapterKey = c.req.param("adapterKey");
		const adapter = deps.runtime.adapterRegistry.list().find((a) => a.adapterKey === adapterKey);
		if (!adapter) return respondFailure(c, fail("unavailable", "这种连接的适配器没在跑"));
		try {
			const candidates = await adapter.listConnectionCandidates(c.req.raw.signal);
			const body: ConnectionCandidatesResponse = { candidates: [...candidates] };
			return c.json(body);
		} catch (err) {
			// 适配器「不许抛」;真抛了算 bug,记 error、回 `unavailable`。
			log.error(`GET /api/adapters/:adapterKey/candidates threw: ${errorMessageOf(err)}`);
			return respondFailure(c, fail("unavailable", errorMessageOf(err)));
		}
	});

	app.post("/:adapterKey/auth", async (c) => {
		const found = authOf(c.req.param("adapterKey"));
		if ("failure" in found) return respondFailure(c, found.failure);
		const r = await guarded("POST /api/adapters/:adapterKey/auth", () =>
			found.auth.begin(c.req.raw.signal),
		);
		if (!r.ok) return respondFailure(c, r);
		const body: ConnectionAuthBeginResponse = {
			taskId: r.taskId,
			state: r.state,
			pollIntervalSeconds: r.pollIntervalSeconds,
		};
		return c.json(body);
	});

	app.get("/:adapterKey/auth/:taskId", async (c) => {
		const found = authOf(c.req.param("adapterKey"));
		if ("failure" in found) return respondFailure(c, found.failure);
		const r = await guarded("GET /api/adapters/:adapterKey/auth/:taskId", () =>
			found.auth.state(c.req.param("taskId"), c.req.raw.signal),
		);
		if (!r.ok) return respondFailure(c, r);
		const body: ConnectionAuthStateResponse = { state: r.state };
		return c.json(body);
	});

	app.post("/:adapterKey/auth/:taskId/draft", async (c) => {
		const found = authOf(c.req.param("adapterKey"));
		if ("failure" in found) return respondFailure(c, found.failure);
		const r = await guarded("POST /api/adapters/:adapterKey/auth/:taskId/draft", () =>
			found.auth.takeDraft(c.req.param("taskId")),
		);
		if (!r.ok) return respondFailure(c, r);
		const body: ConnectionAuthDraftResponse = { settings: r.settings };
		// 草稿里有密钥:不许任何一层缓存留着它。
		c.header("Cache-Control", "no-store");
		return c.json(body);
	});

	return app;
}
