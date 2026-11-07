import type {
	AdapterEntry,
	AdaptersResponse,
	ConnectionAuthBeginResponse,
	ConnectionAuthDraftResponse,
	ConnectionAuthStateResponse,
	ConnectionCandidatesResponse,
} from "@bilibili-notify/contract";
import { type ConnectionAuth, type Failure, fail, type Result } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { manifestPushView } from "../extensions/context.js";
import type { ExtensionEntry } from "../extensions/loader.js";
import { logText, t } from "../i18n/index.js";
import { errorMessageOf } from "../util/error-message.js";
import { respondFailure } from "./respond-failure.js";
import type { RouteDeps } from "./types.js";

export interface AdaptersRouteOptions {
	/** 装载器那张表,现读:拓展的适配器照清单列,跑没跑都有。没接装载器的构建是空表。 */
	extensions: () => readonly ExtensionEntry[];
	/** 等装载器头一轮扫完再答,免得开机那一刻拓展的适配器全缺。没接装载器的构建没有。 */
	settle?: () => Promise<void>;
}

/**
 * `/api/adapters` — 适配器表、新建连接的候选与适配器自带的扫码建连接(`connectionAuth`,ADR-0024 决策 3)。
 *
 * - `GET /` 适配器表(ADR-0024 决策 1、3):每个适配器一条 `{ key, descriptor, has }`。照 `/api/sources` 合两张表:
 *   登记表里不是拓展的(三个内置)取适配器的 `descriptor()`,每次读都现调(名字按此刻的语言);拓展一律取装载器
 *   那份清单的推送那一口 —— 停用、没起来的也列,在跑的也不取登记表上那份(装载器那份按此刻的语言盖好译文)。
 * - `GET /:adapterKey/candidates` 新建连接时供挑的候选(内置的模板候选、桥在线的 bot),ADR-0024 决策 4。
 * - `POST /:adapterKey/auth` 发起;`GET /:adapterKey/auth/:taskId` 读状态(不带草稿、不清草稿);
 *   `POST /:adapterKey/auth/:taskId/draft` 取走草稿(取走即清,响应头 `no-store`)。
 *
 * 路由直接问适配器登记表,不经派发器与推送链路装配 —— 发起时还没有连接,只有适配器键。任务表住适配器里,
 * 这里不持有任何状态。⚠️ 回包**逐格挑**:不展开适配器的返回值,也不把它整个打进日志
 * (草稿里有密钥)。
 *
 * 失败一律经 `respondFailure`(ADR-0026):适配器不在 `unavailable`、没这个成员 `unsupported`,
 * 其余按适配器回的码原样翻。
 */
export function createAdaptersRoute(deps: RouteDeps, opts: AdaptersRouteOptions): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/", async (c) => {
		await opts.settle?.();
		const extensions = opts.extensions();
		const extensionIds = new Set(extensions.map((entry) => entry.id));
		const adapters: AdapterEntry[] = [];
		for (const view of deps.runtime.adapterRegistry.list()) {
			if (extensionIds.has(view.adapterKey)) continue;
			adapters.push({
				key: view.adapterKey,
				descriptor: view.descriptor(),
				has: {
					connectionAuth: view.connectionAuth !== undefined,
					listAddressCandidates: view.listAddressCandidates !== undefined,
				},
			});
		}
		for (const entry of extensions) {
			const descriptor = entry.manifest && manifestPushView(entry.manifest);
			if (descriptor) {
				// 本版拓展不开放扫码与列地址;只声明宿主实际放行的能力。
				adapters.push({
					key: entry.id,
					descriptor,
					has: { connectionAuth: false, listAddressCandidates: false },
				});
			}
		}
		return c.json({ adapters } satisfies AdaptersResponse);
	});

	/** 键 → 适配器的 `connectionAuth`;不成立就地回失败。 */
	function authOf(adapterKey: string): { auth: ConnectionAuth } | { failure: Failure } {
		const adapter = deps.runtime.adapterRegistry.list().find((a) => a.adapterKey === adapterKey);
		if (!adapter) return { failure: fail("unavailable", t("adapters.notRunning")) };
		if (!adapter.connectionAuth) {
			return { failure: fail("unsupported", t("adapters.auth.unsupported")) };
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
			log.error(logText("log.http.operationFailed"), { operation: where, error: err });
			return fail("unavailable", errorMessageOf(err));
		}
	}

	// 候选只问登记表的视图(不带 `send`):发送只许经派发器(出口咽喉)。内置与拓展同一个口。
	app.get("/:adapterKey/candidates", async (c) => {
		const adapterKey = c.req.param("adapterKey");
		const adapter = deps.runtime.adapterRegistry.list().find((a) => a.adapterKey === adapterKey);
		if (!adapter) return respondFailure(c, fail("unavailable", t("adapters.notRunning")));
		try {
			const candidates = await adapter.listConnectionCandidates(c.req.raw.signal);
			await deps.runtime.configStore.refreshConnectionSnapshots(
				adapterKey,
				candidates.map((candidate) => candidate.platform),
			);
			const body: ConnectionCandidatesResponse = { candidates: [...candidates] };
			return c.json(body);
		} catch (err) {
			// 适配器「不许抛」;真抛了算 bug,记 error、回 `unavailable`。
			log.error(logText("log.http.operationFailed"), {
				operation: "GET /api/adapters/:adapterKey/candidates",
				error: err,
			});
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
