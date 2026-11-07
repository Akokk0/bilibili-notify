/**
 * 拓展的**动态挂载点**(ADR-0012 决策 11 / 12)。
 *
 * 开机注册**一条**总入口 `/ext/:id/*`,它去查一张**活的**路由表;卸载一个拓展 = 从表里
 * 删一行。⚠️ 刻意**不去覆写 Hono 的注册方法**换一个「可卸载的路由」—— 那是拿框架内部
 * 结构换便利,框架一升级就炸,而这条路用公开 API 就走得完。
 *
 * 还有一条:**拓展不该知道自己挂在哪**。前缀由宿主分配、经 ctx 告诉它,所以交到 handler
 * 手里的路径是**去掉前缀之后**的那一段 —— 改前缀不用动任何拓展。
 */

import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createExtensionMounts, EXTENSION_MOUNT_PREFIX } from "../mount.js";

function appWith(mounts: ReturnType<typeof createExtensionMounts>): Hono {
	const app = new Hono();
	app.route(EXTENSION_MOUNT_PREFIX, mounts.route);
	return app;
}

describe("拓展挂载点", () => {
	it("挂上之后打得进去,而且 handler 看到的是**去掉前缀**的路径", async () => {
		const seen: string[] = [];
		const mounts = createExtensionMounts({ logger: silentLogger });
		const handle = mounts.mount("bridge", async (req) => {
			seen.push(new URL(req.url).pathname);
			return new Response("ok");
		});
		expect(handle.prefix).toBe("/ext/bridge");

		const res = await appWith(mounts).request("/ext/bridge/blob/abc");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
		expect(seen).toEqual(["/blob/abc"]);
	});

	it("方法、查询串、请求体都原样透传 —— 这一层只改路径", async () => {
		const mounts = createExtensionMounts({ logger: silentLogger });
		mounts.mount("bridge", async (req) => {
			const url = new URL(req.url);
			return Response.json({
				method: req.method,
				path: url.pathname,
				q: url.searchParams.get("q"),
				body: await req.text(),
			});
		});

		const res = await appWith(mounts).request("/ext/bridge/echo?q=1", {
			method: "POST",
			body: "hello",
		});
		expect(await res.json()).toEqual({ method: "POST", path: "/echo", q: "1", body: "hello" });
	});

	it("光打前缀本身也算它的 —— 路径给 `/`", async () => {
		const mounts = createExtensionMounts({ logger: silentLogger });
		mounts.mount("bridge", async (req) => new Response(new URL(req.url).pathname));
		expect(await (await appWith(mounts).request("/ext/bridge")).text()).toBe("/");
	});

	it("撤下之后同一条路径就 404 了 —— 卸载 = 从表里删一行", async () => {
		const mounts = createExtensionMounts({ logger: silentLogger });
		const handle = mounts.mount("bridge", async () => new Response("ok"));
		const app = appWith(mounts);
		expect((await app.request("/ext/bridge/x")).status).toBe(200);
		handle.dispose();
		const res = await app.request("/ext/bridge/x");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这个拓展" });
	});

	it("没装过的 id → 404,不是 503", async () => {
		expect(
			(await appWith(createExtensionMounts({ logger: silentLogger })).request("/ext/nobody/x"))
				.status,
		).toBe(404);
	});

	it("一个拓展抛了,只有它自己 503;别的拓展照走", async () => {
		const mounts = createExtensionMounts({ logger: silentLogger });
		mounts.mount("bad", () => {
			throw new Error("boom");
		});
		mounts.mount("good", async () => new Response("still here"));
		const app = appWith(mounts);
		const res = await app.request("/ext/bad/x");
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			code: "unavailable",
			message: "拓展处理这次请求时出错了，详情在日志里",
		});
		expect(await (await app.request("/ext/good/x")).text()).toBe("still here");
	});

	it("拓展抛的原话只进日志,不回给对家 —— 那是它自己的报错,可能带路径或密钥", async () => {
		const error = vi.fn();
		const logger = { info: vi.fn(), warn: vi.fn(), error, debug: vi.fn() };
		const mounts = createExtensionMounts({ logger });
		const boom = new Error("db password hunter2 exploded");
		mounts.mount("bad", () => {
			throw boom;
		});
		const res = await appWith(mounts).request("/ext/bad/x?token=s3cret");
		expect(JSON.stringify(await res.json())).not.toContain("exploded");
		expect(error).toHaveBeenCalledTimes(1);
		const [line, details, err] = error.mock.calls[0] as [string, unknown, unknown];
		expect(line).toBe("拓展 HTTP 请求处理失败");
		expect(details).toEqual({ extensionId: "bad", method: "GET", path: "/ext/bad/x" });
		// 路径进日志,查询串不进:token 之类只该待在请求里。
		expect(JSON.stringify([line, details])).toContain("/ext/bad/x");
		expect(JSON.stringify([line, details])).not.toContain("s3cret");
		expect(err).toBe(boom);
	});

	it("同一个 id 挂两次 → 拒绝 —— 一条总入口只能有一个主人", () => {
		const mounts = createExtensionMounts({ logger: silentLogger });
		mounts.mount("bridge", async () => new Response("ok"));
		expect(() => mounts.mount("bridge", async () => new Response("其他人"))).toThrow();
	});

	it("撤下之后可以重挂 —— 停用再启用走的就是这条", async () => {
		const mounts = createExtensionMounts({ logger: silentLogger });
		mounts.mount("bridge", async () => new Response("一")).dispose();
		mounts.mount("bridge", async () => new Response("二"));
		expect(await (await appWith(mounts).request("/ext/bridge")).text()).toBe("二");
	});
});
