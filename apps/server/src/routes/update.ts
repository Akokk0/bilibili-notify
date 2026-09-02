/**
 * 自主升级 API。判断全在 `update/service.ts` —— 这一层只做 wire,外加一件实质的事:
 * **应用更新时先把话说完,再关自己**。
 *
 * 应用 = 重启。重启会掐断正在回应的这条 HTTP 连接,所以顺序反了的话,用户点完
 * 「立即更新」看到的是一条网络错误,然后他会去点第二次、第三次 —— 而每一次都真的
 * 重启了一遍服务。
 */

import { canApplyUpdate, isMirrorPrefix } from "@bilibili-notify/contract";
import { Hono } from "hono";
import { z } from "zod";
import type { UpdateService } from "../update/service.js";

/**
 * 「测一遍」的请求体。只收空串(直连)或合法的 `https://` 前缀 —— 这是要去真连的地址,
 * 判定与面板共用同一条(契约里的 `isMirrorPrefix`),否则会出现「测得通、存不进去」。
 * 数量也封顶:内置六个 + 直连 + 一条自定义,二十已经很宽了。
 */
const ProbeBody = z.object({
	prefixes: z.array(z.string().refine((p) => p === "" || isMirrorPrefix(p))).max(20),
});

export interface CreateUpdateRouteInput {
	service: UpdateService;
	/**
	 * 优雅停机 + 退出,交给进程管理器把新版本拉起来(容器是 `restart:` 策略,
	 * 桌面版是 Tauri 外壳)。由 index.ts 注入 —— 路由不该知道怎么关一个进程。
	 */
	applyUpdate: () => Promise<void>;
}

export function createUpdateRoute({ service, applyUpdate }: CreateUpdateRouteInput): Hono {
	const app = new Hono();

	app.get("/", (c) => c.json(service.getStatus()));
	app.post("/check", async (c) => c.json(await service.check()));
	app.post("/download", async (c) => c.json(await service.download()));
	app.post("/rollback", async (c) => c.json(await service.rollback()));

	app.post("/mirrors/probe", async (c) => {
		const parsed = ProbeBody.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) return c.json({ err: "prefixes 不成形" }, 400);
		return c.json({ results: await service.probeMirrors(parsed.data.prefixes) });
	});

	app.post("/apply", (c) => {
		// 判定在契约里,面板决定按钮出不出用的是同一个函数 —— 见 `canApplyUpdate`。
		if (!canApplyUpdate(service.getStatus().state)) {
			return c.json({ err: "没有可应用的版本" }, 409);
		}

		// 先回话,再关。两层保险,缺一不可:
		//
		// ① `setTimeout` 而不是 `Promise.resolve().then` —— 微任务会在这个响应交给
		//    运行时**之前**就跑掉,等于没让开。
		// ② `applyUpdate` 那头做的是**优雅停机**,它会等在途请求收尾 —— 宏任务只是
		//    让开一步,真正保证这条响应写得出去的是那一步。
		//
		// 不 await:等它就等于等自己被杀。但要接住 rejection —— 优雅停机里任一处 dispose
		// 抛了,这个没人管的 promise 会让进程以非 0 退出,正是上面注释要避免的那种结果。
		setTimeout(() => {
			applyUpdate().catch(() => {
				// index.ts 那头自己会记日志并照样退 0;这里只负责不让它变成 unhandled rejection。
			});
		}, 0);
		return c.json({ restarting: true });
	});

	return app;
}
