import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { describe, expect, it, vi } from "vite-plus/test";
import type { UpdateService } from "../../update/service.js";
import { createUpdateRoute } from "../update.js";

/**
 * 升级 API 的 wire 层。判断全在 `update/service.ts`,这里只做四件事:把状态交出去、
 * 转发三个动作、以及**应用更新时先回话再关自己**。
 *
 * 最后那条是这一层唯一的实质逻辑,也是唯一会让用户以为「点了没反应」的地方:
 * 重启会掐断这条 HTTP 连接,先关再回话的话浏览器只看得到一个网络错误。
 */

function fakeService(overrides: Partial<UpdateService> = {}): UpdateService {
	const status: UpdateStatusDTO = {
		currentVersion: "0.8.0",
		rollbackTarget: null,
		pinnedVersion: null,
		state: { phase: "idle" },
	};
	return {
		getStatus: () => status,
		check: async () => status,
		download: async () => status,
		rollback: async () => status,
		probeMirrors: async () => [],
		...overrides,
	};
}

describe("update 路由", () => {
	it("GET / 交出当前状态", async () => {
		const app = createUpdateRoute({ service: fakeService(), applyUpdate: async () => {} });

		const res = await app.request("/");

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ currentVersion: "0.8.0", state: { phase: "idle" } });
	});

	it("POST /check 只转发,不自己判断", async () => {
		const check = vi.fn(async () => ({
			currentVersion: "0.8.0",
			rollbackTarget: null,
			pinnedVersion: null,
			state: { phase: "ready" as const, target: "0.9.0", releaseUrl: "https://x/t" },
		}));
		const app = createUpdateRoute({
			service: fakeService({ check }),
			applyUpdate: async () => {},
		});

		const res = await app.request("/check", { method: "POST" });

		expect(check).toHaveBeenCalledOnce();
		expect(await res.json()).toMatchObject({ state: { phase: "ready", target: "0.9.0" } });
	});

	it("POST /download 与 POST /rollback 同样只转发", async () => {
		const download = vi.fn(async () => fakeService().getStatus());
		const rollback = vi.fn(async () => fakeService().getStatus());
		const app = createUpdateRoute({
			service: fakeService({ download, rollback }),
			applyUpdate: async () => {},
		});

		expect((await app.request("/download", { method: "POST" })).status).toBe(200);
		expect((await app.request("/rollback", { method: "POST" })).status).toBe(200);
		expect(download).toHaveBeenCalledOnce();
		expect(rollback).toHaveBeenCalledOnce();
	});

	it("载荷还没就绪时 POST /apply 拒绝,而不是白白重启一次", async () => {
		// 「重启完发现版本没变」是最让人怀疑功能坏掉的一种结果,而重启本身有代价:
		// 推送会断、直播监听会掉。没东西可应用就别动。
		const applyUpdate = vi.fn(async () => {});
		const app = createUpdateRoute({ service: fakeService(), applyUpdate });

		const res = await app.request("/apply", { method: "POST" });

		expect(res.status).toBe(409);
		expect(applyUpdate).not.toHaveBeenCalled();
	});

	it("回退钉好之后 POST /apply 放行 —— 回退也要靠重启才生效", async () => {
		const applyUpdate = vi.fn(async () => {});
		const app = createUpdateRoute({
			service: fakeService({
				getStatus: () => ({
					currentVersion: "0.9.0",
					pinnedVersion: null,
					rollbackTarget: "0.8.0",
					state: { phase: "rolled-back", target: "0.8.0" },
				}),
			}),
			applyUpdate,
		});

		expect((await app.request("/apply", { method: "POST" })).status).toBe(200);
	});

	it("先把话说完再关自己 —— 否则浏览器只看得到一个网络错误", async () => {
		const order: string[] = [];
		const applyUpdate = vi.fn(async () => {
			order.push("shutdown");
		});
		const app = createUpdateRoute({
			service: fakeService({
				getStatus: () => ({
					currentVersion: "0.8.0",
					rollbackTarget: null,
					pinnedVersion: null,
					state: { phase: "ready", target: "0.9.0", releaseUrl: "https://x/t" },
				}),
			}),
			applyUpdate,
		});

		const res = await app.request("/apply", { method: "POST" });
		order.push("responded");
		await vi.waitFor(() => expect(applyUpdate).toHaveBeenCalled());

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ restarting: true });
		// 响应必须先出去。反过来的话用户点完「立即更新」看到的是一条报错,
		// 然后他会去点第二次、第三次 —— 而每一次都真的重启了一遍服务。
		//
		// 这条钉的是**让开一步**这件事(宏任务而非微任务)。进程内的 `app.request`
		// 模拟不了「响应写进 socket」,真正保证那一步的是 applyUpdate 那头的优雅停机
		// 会等在途请求收尾 —— 那部分由 index.ts 的 closeHttpServer 负责。
		expect(order).toEqual(["responded", "shutdown"]);
	});

	it("功能没启用时 /apply 也拒 —— 不给一条能白白重启服务的路", async () => {
		const applyUpdate = vi.fn(async () => {});
		const app = createUpdateRoute({
			service: fakeService({
				getStatus: () => ({
					currentVersion: "0.8.0",
					rollbackTarget: null,
					pinnedVersion: null,
					state: { phase: "disabled" },
				}),
			}),
			applyUpdate,
		});

		expect((await app.request("/apply", { method: "POST" })).status).toBe(409);
		expect(applyUpdate).not.toHaveBeenCalled();
	});
});

describe("update 路由 —— 测一遍加速站", () => {
	it("POST /mirrors/probe 把 prefixes 原样交给 service,结果原样交回", async () => {
		const probeMirrors = vi.fn(async (prefixes: readonly string[]) =>
			prefixes.map((prefix) => ({ prefix, ok: true as const, ms: 12, version: "0.9.0" })),
		);
		const app = createUpdateRoute({
			service: fakeService({ probeMirrors }),
			applyUpdate: async () => {},
		});

		const res = await app.request("/mirrors/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prefixes: ["", "https://ghfast.top/"] }),
		});

		expect(res.status).toBe(200);
		expect(probeMirrors).toHaveBeenCalledWith(["", "https://ghfast.top/"]);
		expect(await res.json()).toEqual({
			results: [
				{ prefix: "", ok: true, ms: 12, version: "0.9.0" },
				{ prefix: "https://ghfast.top/", ok: true, ms: 12, version: "0.9.0" },
			],
		});
	});

	it("prefixes 不成形 → 400,不去碰 service —— 只收空串或 https:// 前缀,数量有上限", async () => {
		const probeMirrors = vi.fn(async () => []);
		const app = createUpdateRoute({
			service: fakeService({ probeMirrors }),
			applyUpdate: async () => {},
		});

		for (const body of [
			"{}",
			JSON.stringify({ prefixes: "https://x/" }),
			JSON.stringify({ prefixes: ["http://plain.example/"] }),
			JSON.stringify({ prefixes: Array.from({ length: 40 }, (_, i) => `https://m${i}.example/`) }),
		]) {
			const res = await app.request("/mirrors/probe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			expect(res.status, body).toBe(400);
		}
		expect(probeMirrors).not.toHaveBeenCalled();
	});
});
