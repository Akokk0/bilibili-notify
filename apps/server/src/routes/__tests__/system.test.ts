/**
 * `/api/system` —— 现在只有「重启一下」这一件事。
 *
 * 这一层的实质逻辑只有两条,而两条都是「用户会以为功能坏了」的地方:
 * ① **先回话再关自己**(照 `/api/update/apply`):顺序反了,浏览器只看得到一个网络错误,
 *    然后他会去按第二次、第三次 —— 每一次都真的重启了一遍。
 * ② **拉不起来的环境上,POST 也得拦**:按钮藏起来 ≠ 没人发这个请求(旧标签页、curl),
 *    而这一发的后果是把 BN 关了、没人拉。
 */

import type { RestartAbility, RestartResponse } from "@bilibili-notify/contract";
import { describe, expect, it, vi } from "vite-plus/test";
import { createSystemRoute } from "../system.js";

const STARTED = "2026-09-10T00:00:00.000Z";

function boot(ability: RestartAbility, restart = vi.fn(async () => {})) {
	return {
		app: createSystemRoute({ ability, startedAt: STARTED, version: "0.10.1", restart }),
		restart,
	};
}

describe("GET /api/system", () => {
	it("交出判据 —— 面板据它决定按钮出不出、旁边写什么", async () => {
		const { app } = boot({ can: true, how: "container" });
		expect(await (await app.request("/")).json()).toEqual({
			restart: { can: true, how: "container" },
		});
	});

	it("拉不起来时把**为什么**也交出去 —— 藏个按钮不解释最像功能坏了", async () => {
		const { app } = boot({ can: false, reason: "source-run" });
		expect(await (await app.request("/")).json()).toEqual({
			restart: { can: false, reason: "source-run" },
		});
	});
});

describe("POST /api/system/restart", () => {
	it("先回话,再关自己", async () => {
		const { app, restart } = boot({ can: true, how: "desktop" });

		const res = await app.request("/restart", { method: "POST" });

		expect(res.status).toBe(200);
		const body = (await res.json()) as RestartResponse;
		expect(body).toEqual({ restarting: true, startedAt: STARTED, version: "0.10.1" });
		// 🔴 回话交出去的那一刻还**没**开始关 —— 反了的话这条响应根本写不出去。
		expect(restart).not.toHaveBeenCalled();
		await new Promise((r) => setTimeout(r, 5));
		expect(restart).toHaveBeenCalledOnce();
	});

	it("拉不起来的环境 → 409,一下都不关", async () => {
		const { app, restart } = boot({ can: false, reason: "source-run" });

		const res = await app.request("/restart", { method: "POST" });

		expect(res.status).toBe(409);
		await new Promise((r) => setTimeout(r, 5));
		expect(restart).not.toHaveBeenCalled();
	});

	it("拒绝时说清楚是哪一种拉不起来 —— 那句话是面板唯一的线索", async () => {
		const { app } = boot({ can: false, reason: "unsupervised" });
		const body = (await (await app.request("/restart", { method: "POST" })).json()) as {
			err: string;
		};
		expect(body.err).toContain("没人");
	});

	/**
	 * 优雅停机是 rethrow 的,而这一步之前 unhandledRejection 的 handler 已经摘掉了 ——
	 * 没人接的话 Node 走默认:退出码 1,编排系统当成崩溃去退避重启。
	 */
	it("restart 抛了 → 不变成 unhandled rejection", async () => {
		const restart = vi.fn(async () => {
			throw new Error("dispose exploded");
		});
		const { app } = boot({ can: true, how: "container" }, restart);

		expect((await app.request("/restart", { method: "POST" })).status).toBe(200);
		await new Promise((r) => setTimeout(r, 5));
		expect(restart).toHaveBeenCalledOnce();
	});
});
