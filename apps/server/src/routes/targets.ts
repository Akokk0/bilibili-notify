import type { TestResponse } from "@bilibili-notify/contract";
import { fail, issuesFromZod, type NotificationPayload } from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { ConfigValidationError } from "../config/store.js";
import { logText, t as serverText } from "../i18n/index.js";
import { readJsonBody, readJsonObject } from "./request-body.js";
import { pipelineNotReadyMessage, respondFailure } from "./respond-failure.js";
import { testResultOfDelivery } from "./test-result.js";
import type { RouteDeps } from "./types.js";

/**
 * `/api/targets` — CRUD on the PushTarget[] list,外加 `POST /:id/test`(试一次推送)。
 *
 * 失败一律经 `respondFailure`(ADR-0026):store 拒收时抛的 `ConfigValidationError` 自带标准码
 * (不合规 `invalid` 400、没这一条 `not_found` 404、托管的不许动 `conflict` 409),路由按码回、不嗅文案。
 *
 * `POST /:id/test` —— 往**一个**推送目标上丢一条已知良好的载荷,走真实的 TargetDispatcher,
 * 与真事件投递同一条路径。卡片页的「发送测试推送」按钮与推送目标页的「测试」按钮用它。
 * (目标 id 从前在请求体里的 `targetId`,ADR-0036 挪进了路径。)
 *
 * 试一次、回报结果(ADR-0026):投递的结果**照旧回 200**,体是 `Result<{ latencyMs }>`(送达带耗时,
 * 没送达带码和原话,不带假的耗时)。请求本身不成 —— 体不对 400、推送链路没起 503、没有这个目标 404 ——
 * 是非 2xx 的错误体,经 `respondFailure`。
 */

/**
 * 测试推送的种类:四种特性键(`liveStart` / `post` / `superchat` / `membership`)各配一句样板,外加 `text`(只验通不通)。
 * 请求体只在这一处定义,面板的「测试」按钮发的都是缺省的 `text`。
 */
const TestKindSchema = z.enum(["liveStart", "post", "superchat", "membership", "text"]);

const TestRequestSchema = z.object({
	kind: TestKindSchema.default("text"),
	text: z.string().optional(),
});

const TargetIdSchema = z.uuid();

// TestResponse 在 @bilibili-notify/contract(web 同源消费)。

const KIND_TEXTS: Record<z.infer<typeof TestKindSchema>, string> = {
	get liveStart() {
		return serverText("service.routes.targets.text.1");
	},
	get post() {
		return serverText("service.routes.targets.text.2");
	},
	get superchat() {
		return serverText("service.routes.targets.text.3");
	},
	get membership() {
		return serverText("service.routes.targets.text.4");
	},
	get text() {
		return serverText("service.routes.targets.text.5");
	},
};

/** 整个体都不带(`curl -X POST` 一把)就当 `{}`,全按缺省;带了但不是 JSON 才算体不对。 */
async function readOptionalJson(c: Context): Promise<unknown> {
	const raw = await c.req.text();
	if (raw.trim() === "") return {};
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

export function createTargetsRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/", (c) => c.json(deps.store.getTargets()));

	app.post("/", async (c) => {
		const read = await readJsonBody(c);
		if (!read.ok) return respondFailure(c, read);
		try {
			await deps.store.upsertTarget(read.body as never);
			return c.json(deps.store.getTargets(), 200);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error(logText("log.http.operationFailed"), { operation: "POST /api/targets" }, err);
			throw err;
		}
	});

	app.patch("/:id", async (c) => {
		const id = c.req.param("id");
		const read = await readJsonObject(c);
		if (!read.ok) return respondFailure(c, read);
		try {
			const next = await deps.store.patchTarget(id, read.body);
			return c.json(next);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error(logText("log.http.operationFailed"), { operation: "PATCH /api/targets/:id" }, err);
			throw err;
		}
	});

	app.post("/:id/test", async (c) => {
		const idCheck = TargetIdSchema.safeParse(c.req.param("id"));
		if (!idCheck.success) {
			return respondFailure(
				c,
				fail("invalid", serverText("service.routes.targets.text.6"), {
					issues: issuesFromZod(idCheck.error),
				}),
			);
		}
		const targetId = idCheck.data;
		const parsed = TestRequestSchema.safeParse(await readOptionalJson(c));
		if (!parsed.success) {
			return respondFailure(
				c,
				fail(
					"invalid",
					serverText("service.routes.targets.text.7", {
						value0: TestKindSchema.options.join(" / "),
					}),
					{
						issues: issuesFromZod(parsed.error),
					},
				),
			);
		}

		const { kind, text } = parsed.data;
		const pipeline = deps.runtime.pipeline;
		if (!pipeline) return respondFailure(c, fail("unavailable", pipelineNotReadyMessage()));

		const target = deps.store.getTargets().find((t) => t.id === targetId);
		if (!target)
			return respondFailure(c, fail("not_found", serverText("service.routes.targets.text.8")));

		const payload: NotificationPayload = {
			kind: "text",
			text: text ?? KIND_TEXTS[kind],
		};
		// The push.sendToTarget path goes through the same retry / dispatcher lookup
		// pipeline use, so the test exercises real behaviour.
		const result = await pipeline.push.sendToTarget(target.id, payload);
		return c.json<TestResponse>(testResultOfDelivery(result));
	});

	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		try {
			const removed = await deps.store.deleteTarget(id);
			if (!removed)
				return respondFailure(c, fail("not_found", serverText("service.routes.targets.text.9")));
			return c.body(null, 204);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error(logText("log.http.operationFailed"), { operation: "DELETE /api/targets/:id" }, err);
			throw err;
		}
	});

	return app;
}
