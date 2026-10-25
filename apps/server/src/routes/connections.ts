import type {
	AddressCandidatesResponse,
	ConnectionCapabilitiesMap,
	ConnectionTestResponse,
	ConnectionView,
} from "@bilibili-notify/contract";
import { fail, NewConnectionSchema, PushTargetScopeSchema } from "@bilibili-notify/internal";
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
 * 凭据下发打码(ADR-0021 决策 44):读与写的响应里 `settings` 里 `secret` 标记的格是 `{ masked }`
 * (适配器不在场 / 设置不合法时整格是 `{ masked }`,见 `secret-view.ts`);写入带着遮挡回 400,
 * 不带 = 保留已存的,清空交空串 / null。POST 只管新建(同 id 已存在回 409),编辑走 PATCH。
 *
 * 平台快照(`platformSnapshot`)与探测状态(`probeState`)只有宿主写:POST 时快照从适配器的候选里抄,
 * 体里带来的这两格一律忽略。
 *
 * 失败一律经 `respondFailure`(ADR-0026):store 拒收时抛的 `ConfigValidationError` 自带标准码,
 * 路由按码回(不合规 400、没这条 404、还被目标引用着 409),不嗅文案。
 */
export function createConnectionsRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	/** 下发前密钥格打码(`secret` 标记);盘上与推送链路里仍是明文。 */
	const viewsOf = (): ConnectionView[] =>
		deps.store.getConnections().map((c) => connectionView(c, deps.connectionSecrets));

	app.get("/", (c) => c.json(viewsOf()));

	/**
	 * 连接能力快照(@全体 / 收不收得到回复 / 小程序卡三项),连接 id → 这条连接的能力。
	 * **直连与拓展连接都列**:一条连接就是一个 bot(ADR-0012 决策 45),能力由它的适配器按连接答。
	 * 适配器给不出能力的连接(没有适配器管、适配器没实现)不列,面板按「还不知道」算;
	 * 推送链路还没起来时是空表 —— 同样显示成「还不知道」,不算错。
	 */
	app.get("/capabilities", (c) => {
		const pipeline = deps.runtime.pipeline;
		const out: ConnectionCapabilitiesMap = {};
		if (pipeline) {
			for (const connection of deps.store.getConnections()) {
				const caps = pipeline.connectionCapabilities(connection.id);
				if (caps) out[connection.id] = caps;
			}
		}
		return c.json(out);
	});

	/**
	 * 这条连接上可挑的地址(只查 `scope` 那一种):QQ 的群 / 私聊来自内存发现表,频道现去 QQ 拉。
	 * 停用的连接照样能列;适配器没有这个成员(OneBot 之类)回 `unsupported`。
	 */
	app.get("/:id/addresses", async (c) => {
		const scope = PushTargetScopeSchema.safeParse(c.req.query("scope"));
		if (!scope.success) {
			return respondFailure(
				c,
				fail("invalid", "scope 只能是 group / private / channel", {
					issues: [{ path: ["scope"], message: "不是 group / private / channel 之一" }],
				}),
			);
		}
		const pipeline = deps.runtime.pipeline;
		if (!pipeline) return respondFailure(c, fail("unavailable", ENGINES_NOT_READY_MESSAGE));
		const result = await pipeline.listAddressCandidates(
			c.req.param("id"),
			scope.data,
			c.req.raw.signal,
		);
		if (!result.ok) return respondFailure(c, result);
		return c.json<AddressCandidatesResponse>({ candidates: [...result.candidates] });
	});

	app.post("/", async (c) => {
		const read = await readJsonBody(c);
		if (!read.ok) return respondFailure(c, read);
		const masked = maskedCellsFailure(read.body);
		if (masked) return respondFailure(c, masked);
		// 外壳先过一遍(宿主独写的两格不在这份 schema 里,带来了也被剥掉)。
		const draft = NewConnectionSchema.safeParse(read.body);
		if (!draft.success) {
			return respondFailure(
				c,
				ConfigValidationError.fromZod("connections", draft.error).toFailure(),
			);
		}
		// 新建连接要适配器在跑:找不到就拒(改已有的连接不受这条管,适配器不在场先存)。
		const adapter = deps.runtime.adapterRegistry
			.list()
			.find((a) => a.adapterKey === draft.data.adapterKey);
		if (!adapter) {
			return respondFailure(c, fail("unavailable", "这种连接的适配器没在跑，没法新建"));
		}
		// 平台快照:从挑中平台的那个候选抄(候选口是适配器的必备成员,内置与拓展同一条路)。
		let candidates: Awaited<ReturnType<typeof adapter.listConnectionCandidates>>;
		try {
			candidates = await adapter.listConnectionCandidates(c.req.raw.signal);
		} catch (err) {
			log.warn(`POST /api/connections: ${draft.data.adapterKey} 的候选列不出来: ${String(err)}`);
			return respondFailure(c, fail("unavailable", "这个适配器现在列不出可选的平台，请稍后再试"));
		}
		const hit = candidates.find((cand) => cand.platform.platform === draft.data.platform);
		if (!hit) {
			return respondFailure(
				c,
				fail("invalid", `这个适配器没有 ${draft.data.platform} 这种候选`, {
					issues: [{ path: ["platform"], message: "不在这个适配器的候选里" }],
				}),
			);
		}
		const { platform: _platform, ...snapshot } = hit.platform;
		try {
			// 只管新建 —— 整条覆盖里「没带这一格」与「清空这一格」分不开,编辑一律走 PATCH。
			await deps.store.createConnection(draft.data, snapshot);
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
			return c.json(connectionView(next, deps.connectionSecrets));
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
		const pipeline = deps.runtime.pipeline;
		if (!pipeline) return respondFailure(c, fail("unavailable", ENGINES_NOT_READY_MESSAGE));
		// 探测结果写进连接的 probeState、问题表的清理,都由推送链路的手动探测一并做了
		// (面板的状态圆点不必等一分钟一轮的周期探测)。回给面板的形状在 {@link testResultOfProbe} 里另翻。
		const result = await pipeline.probeConnection(id);
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
