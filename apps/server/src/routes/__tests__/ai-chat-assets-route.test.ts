/**
 * 女仆 AI 聊天 —— 附件的上传与读取(`POST /api/ai/assets`、`GET /api/ai/assets/:id`)。
 *
 * 守的是失败怎么答(ADR-0026):
 * - 主人递进来的东西不合规矩(没带文件、格式不认)→ `invalid` + 给人看的中文原因;
 * - 磁盘写失败这类环境的事是 bug 一类的抛错 → 交给全局出错处理:原话(带路径)进日志,
 *   客户端只拿一句固定的话。从前这里 `String(err.message)` 原样回给客户端,路径也在里头。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import { createAiRoute } from "../ai.js";
import { requestErrorHandler, UNHANDLED_ERROR_MESSAGE } from "../respond-failure.js";
import type { RouteDeps } from "../types.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mount(dataDir: string) {
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const deps = {
		store: { bootstrap: { dataDir } },
		runtime: { serviceCtx: { logger } },
	} as unknown as RouteDeps;
	// 与 app.ts 一样:路由挂在带全局出错处理的父实例下,抛出来的错才会被接住。
	const app = new Hono();
	app.onError(requestErrorHandler(logger));
	app.route("/api/ai", createAiRoute(deps));
	return { app, logger };
}

function upload(app: Hono, file: File | null) {
	const form = new FormData();
	if (file) form.append("file", file);
	return app.request("/api/ai/assets", { method: "POST", body: form });
}

const png = () => new File([PNG], "a.png", { type: "image/png" });

describe("POST /api/ai/assets", () => {
	it("合规的图 → 200 + { ok: true, id },随后 GET 读得回同样的字节", async () => {
		const { app } = mount(await mkdtemp(join(tmpdir(), "bn-chatassets-")));

		const res = await upload(app, png());

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.ok).toBe(true);
		expect(body.id).toMatch(/^[0-9a-f]{32}\.png$/);
		const served = await app.request(`/api/ai/assets/${body.id}`);
		expect(served.status).toBe(200);
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
	});

	it("没带文件 → 400 invalid + 「缺少图片文件」", async () => {
		const { app } = mount(await mkdtemp(join(tmpdir(), "bn-chatassets-")));

		const res = await upload(app, null);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "缺少图片文件" });
	});

	it("格式不认(SVG 能带脚本,不在白名单)→ 400 invalid + 给人看的中文原因", async () => {
		const { app } = mount(await mkdtemp(join(tmpdir(), "bn-chatassets-")));

		const res = await upload(app, new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }));

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("不支持的图片类型");
		expect(body.message).toContain("PNG");
	});

	it("磁盘写失败是环境的事 → 503 + 固定一句话;带路径的原话进日志,不回给客户端", async () => {
		// dataDir 指到一个普通文件上:`<file>/assets/chat` 建不出来,抛的是带路径的 ENOTDIR。
		const dir = await mkdtemp(join(tmpdir(), "bn-chatassets-"));
		const notADir = join(dir, "i-am-a-file");
		await writeFile(notADir, "x");
		const { app, logger } = mount(notADir);

		const res = await upload(app, png());

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ code: "unavailable", message: UNHANDLED_ERROR_MESSAGE });
		expect(logger.error).toHaveBeenCalledTimes(1);
		const logged = logger.error.mock.calls[0]?.[1] as Error;
		expect(logged.message).toContain("i-am-a-file");
	});
});

describe("GET /api/ai/assets/:id", () => {
	it("盘上没有这张图 → 404 not_found + 「图片不存在」", async () => {
		const { app } = mount(await mkdtemp(join(tmpdir(), "bn-chatassets-")));

		const res = await app.request(`/api/ai/assets/${"0".repeat(32)}.png`);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "图片不存在" });
	});

	it("id 形状不对(穿越尝试)→ 一样是 404,不当成读盘失败", async () => {
		const { app } = mount(await mkdtemp(join(tmpdir(), "bn-chatassets-")));

		const res = await app.request("/api/ai/assets/..%2F..%2Fbn.config.yaml");

		expect(res.status).toBe(404);
		expect(((await res.json()) as any).code).toBe("not_found");
	});
});
