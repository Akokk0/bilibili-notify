import { Hono } from "hono";

/** 所有拓展的挂载根 —— 一条总入口 `/ext/:id/*`,后面按 id 查活的路由表。 */
export const EXTENSION_MOUNT_PREFIX = "/ext";

/**
 * 拓展交给宿主的 HTTP 处理函数。
 *
 * 是**标准 fetch 形状**而不是一个 Hono 子应用:拓展包旁边没有 node_modules,它 import
 * 不到 hono(也 import 不到任何我们的包)。`Request` / `Response` 是运行时自带的。
 */
export type ExtensionFetchHandler = (req: Request) => Response | Promise<Response>;

/** 一条挂上去的总入口。`prefix` 是宿主分配的,拓展自己不该猜(ADR-0012 决策 12)。 */
export interface ExtensionMountHandle {
	readonly prefix: string;
	dispose(): void;
}

export interface ExtensionMounts {
	/** 给这个拓展挂一条总入口。同一个 id 已经有主人时抛 —— 两个主人的路由没法讲道理。 */
	mount(id: string, handler: ExtensionFetchHandler): ExtensionMountHandle;
	/** 挂在 {@link EXTENSION_MOUNT_PREFIX} 底下的那条总入口。开机注册一次,之后不动。 */
	readonly route: Hono;
}

/** 拿到这个拓展的挂载前缀 —— 面板与拓展自己看到的都是这一条。 */
export function extensionMountPrefix(id: string): string {
	return `${EXTENSION_MOUNT_PREFIX}/${id}`;
}

/**
 * 建一张**活的**拓展路由表,外加查它的那条总入口。
 *
 * 卸载一个拓展就是从表里删一行 —— Hono 注册过的路由拆不掉,所以可拆的那一层做在表上,
 * 而不是去覆写框架的注册方法(那是拿框架内部结构换便利,一次升级就炸)。
 */
export function createExtensionMounts(): ExtensionMounts {
	const table = new Map<string, ExtensionFetchHandler>();
	const route = new Hono();

	route.all("/:id{[^/]+}/*", (c) => dispatch(c.req.raw, c.req.param("id")));
	route.all("/:id{[^/]+}", (c) => dispatch(c.req.raw, c.req.param("id")));

	async function dispatch(raw: Request, id: string): Promise<Response> {
		const handler = table.get(id);
		// 没装 / 没启用 / 刚被撤下 —— 对外都是「这条路不存在」。
		if (!handler) return Response.json({ ok: false, err: "not found" }, { status: 404 });

		// 前缀在这里剥掉:拓展注册的是 `/blob/:id`,它从不写 `/ext/bridge`。
		const url = new URL(raw.url);
		url.pathname = url.pathname.slice(extensionMountPrefix(id).length) || "/";
		try {
			return await handler(new Request(url, raw));
		} catch (err) {
			// 一个拓展炸了只炸它自己这一条请求 —— 别让它带走整个进程或别的拓展。
			return Response.json(
				{ ok: false, err: "extension failed", detail: (err as Error).message },
				{ status: 500 },
			);
		}
	}

	return {
		route,
		mount(id, handler) {
			if (table.has(id)) throw new Error(`extension ${id} already mounted`);
			table.set(id, handler);
			return {
				prefix: extensionMountPrefix(id),
				dispose() {
					// 只删自己那一行:重挂过之后 dispose 一个旧 handle 不该把新主人踢掉。
					if (table.get(id) === handler) table.delete(id);
				},
			};
		},
	};
}
