import type { ExtensionDTO } from "@bilibili-notify/contract";
import { isExtensionEnabled } from "@bilibili-notify/internal";
import { Hono } from "hono";
import type { ConfigStore } from "../config/store.js";
import type { ExtensionEntry } from "../extensions/loader.js";

export interface ExtensionsRouteOptions {
	store: ConfigStore;
	/**
	 * 开机那一趟扫出来 + 加载出来的结果。**现取**,理由同上。
	 *
	 * 没有写死的清单了 —— 拓展是**装进来的**,盘上有什么就是什么(ADR-0012)。
	 */
	extensions: () => readonly ExtensionEntry[];
	/** 某个拓展交上来的面板数据。没跑 / 没交过就是 `undefined`。**现取,不缓存。** */
	status: (id: string) => unknown;
	/**
	 * 把**还没落地的开关**落实掉(装载器的 `sync()`)。给了就在列清单之前 await 一下。
	 *
	 * 🔴 热装卸是异步的,而 `PATCH /api/globals` 在它落地之前就回 200 了 —— 面板紧接着
	 * 刷这一口,拿到的会是**上一秒**的状态。启用那一路尤其明显:第一次 `import()` 一个
	 * 文件是真 I/O。症状是「开关明明拨上去了,状态还写着已停用」,而且不会自己好。
	 */
	settle?: () => Promise<void>;
}

/**
 * 拓展页要的两样东西:装了哪些拓展(以及开没开),和某个拓展自己交上来的那份面板数据。
 *
 * 🔴 **状态走 `/api/*` 而不是 `/ext/<id>/*`**(ADR-0012 决策 36):后者**刻意**在鉴权外
 * (对家手里只有 URL、没有会话),把面板数据挂那儿等于把会话列表与 bot 名单公开出去。
 *
 * 开关本身不在这儿改 —— 它住 `globals.extensions`,走 `PATCH /api/globals`,与别的全局
 * 设置同一条路。这里只读。
 */
export function createExtensionsRoute(opts: ExtensionsRouteOptions): Hono {
	const app = new Hono();

	app.get("/", async (c) => {
		await opts.settle?.();
		const globals = opts.store.getGlobals();
		const extensions: ExtensionDTO[] = opts.extensions().map((entry) => ({
			id: entry.id,
			// 清单读不出来时退回目录名 —— 卡片总得印点什么,而目录名正是那时唯一的身份。
			name: entry.manifest?.name ?? entry.id,
			description: entry.manifest?.description,
			version: entry.manifest?.version,
			provides: entry.manifest?.provides,
			icon: entry.manifest?.icon,
			// 开关与状态是**两件事**:开着却没跑(连败停用 / 清单坏了)正是最该看见的一格。
			enabled: isExtensionEnabled(globals, entry.id),
			state: entry.state,
			detail: entry.detail,
		}));
		return c.json({ extensions });
	});

	/**
	 * 一个拓展交给面板的数据(`ctx.publishStatus`),形状**第一版不约束** —— 面板那一页
	 * 还没写,而抽象要两个例子(决策 36)。没跑 / 没交过就是 404,不是空对象:那两件事
	 * 面板要能分开说。
	 */
	app.get("/:id/status", (c) => {
		const status = opts.status(c.req.param("id"));
		if (status === undefined) return c.json({ ok: false, err: "not found" }, 404);
		return c.json(status);
	});

	return app;
}
