import type { SourceAuthResponse, SourceEntry, SourcesResponse } from "@bilibili-notify/contract";
import {
	type Failure,
	fail,
	type SourceAuth,
	type SourceDescriptor,
} from "@bilibili-notify/internal";
import { Hono } from "hono";
import { manifestSourceDescriptor } from "../extensions/extension-source.js";
import type { ExtensionEntry } from "../extensions/loader.js";
import type { SourceView } from "../subscriptions/registry.js";
import { errorMessageOf } from "../util/error-message.js";
import { respondFailure } from "./respond-failure.js";
import type { RouteDeps } from "./types.js";

export interface SourcesRouteOptions {
	/** 装载器那张表,现读:拓展的来源照清单列,跑没跑都有。没接装载器的构建是空表。 */
	extensions: () => readonly ExtensionEntry[];
	/** 等装载器头一轮扫完再答,免得开机那一刻拓展的来源全缺。没接装载器的构建没有。 */
	settle?: () => Promise<void>;
}

/** 线上的描述符:会员体系先不下发(档位图标是图库引用,面板读会员档的时候再一起上)。 */
function wireDescriptorOf(descriptor: SourceDescriptor): SourceEntry["descriptor"] {
	const { membershipPrograms: _membershipPrograms, ...rest } = descriptor;
	return rest;
}

/** 来源实现了哪些可选成员,宿主自己看,不让来源自报。 */
function hasOf(view: SourceView): NonNullable<SourceEntry["has"]> {
	return { auth: view.auth !== undefined, liveStatus: view.fetchLiveStatus !== undefined };
}

/**
 * `/api/sources` — 来源表与来源的登录口。
 *
 * - `GET    /` 来源表(ADR-0027 决策 6):每个来源一条 `{ key, descriptor, has? }`。两张表合起来:登记表里
 *   不是拓展的(B 站)取登记时交的描述符;拓展一律取装载器那份清单 —— 停用、没起来的也列(不带 `has`),
 *   在跑的也不取登记时那份(那份冻在登记那一刻的语言上,装载器那份按此刻的语言盖好译文);
 * - `GET    /:sourceKey/auth` 读状态与账号(登录口是 `Source.auth`,ADR-0021 决策 45);
 * - `POST   /:sourceKey/auth` 发起扫码登录(已经在等扫码时回 `conflict`);
 * - `DELETE /:sourceKey/auth` 退出登录。
 *
 * 路由直接问来源登记表,不持有状态:来源不在回 `unavailable`、没有登录口回 `unsupported`;实现抛了算 bug,
 * 记一行 error(只记抛出来的话)、回 `unavailable`。回包逐格挑,里面没有 cookie 与令牌。
 *
 * 拒绝重复发起放在这里而不是实现里:`confirming` 同时表示「开机还没确认」,那时必须能发起扫码,路由只看得到
 * `AuthState`、分不出两种情况,所以只在 `awaiting-scan` 时拦;`confirming` 时放行并换一张新码。
 */
export function createSourcesRoute(deps: RouteDeps, opts: SourcesRouteOptions): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;
	const registry = deps.runtime.sourceRegistry;

	app.get("/", async (c) => {
		await opts.settle?.();
		const extensions = opts.extensions();
		const extensionIds = new Set(extensions.map((entry) => entry.id));
		const sources: SourceEntry[] = [];
		for (const view of registry.list()) {
			if (extensionIds.has(view.sourceKey)) continue;
			sources.push({
				key: view.sourceKey,
				descriptor: wireDescriptorOf(view.descriptor),
				has: hasOf(view),
			});
		}
		for (const entry of extensions) {
			const descriptor = entry.manifest && manifestSourceDescriptor(entry.manifest);
			if (!descriptor) continue;
			const view = registry.get(entry.id);
			sources.push({ key: entry.id, descriptor, ...(view ? { has: hasOf(view) } : {}) });
		}
		return c.json({ sources } satisfies SourcesResponse);
	});

	/** 键 → 来源的登录口;不成立就地回失败。 */
	function authOf(sourceKey: string): { auth: SourceAuth } | { failure: Failure } {
		const view = deps.runtime.sourceRegistry.get(sourceKey);
		if (!view) return { failure: fail("unavailable", "这个来源没在跑") };
		if (!view.auth) return { failure: fail("unsupported", "这个来源不用登录") };
		return { auth: view.auth };
	}

	function responseOf(auth: SourceAuth): SourceAuthResponse {
		const account = auth.account?.();
		if (!account) return { state: auth.state() };
		// 逐格挑:实现多带的格不外泄。
		return {
			state: auth.state(),
			account:
				account.avatar === undefined
					? { name: account.name }
					: { name: account.name, avatar: account.avatar },
		};
	}

	app.get("/:sourceKey/auth", (c) => {
		const found = authOf(c.req.param("sourceKey"));
		if ("failure" in found) return respondFailure(c, found.failure);
		try {
			return c.json(responseOf(found.auth));
		} catch (err) {
			log.error(`GET /api/sources/:sourceKey/auth threw: ${errorMessageOf(err)}`);
			return respondFailure(c, fail("unavailable", "读登录状态出错了，详情在日志里"));
		}
	});

	app.post("/:sourceKey/auth", async (c) => {
		const found = authOf(c.req.param("sourceKey"));
		if ("failure" in found) return respondFailure(c, found.failure);
		try {
			if (found.auth.state().status === "awaiting-scan") {
				return respondFailure(c, fail("conflict", "已经有一个扫码登录在进行了，先重置再重新开始"));
			}
			const begun = await found.auth.beginLogin();
			if (!begun.ok) return respondFailure(c, begun);
			return c.json(responseOf(found.auth));
		} catch (err) {
			log.error(`POST /api/sources/:sourceKey/auth threw: ${errorMessageOf(err)}`);
			return respondFailure(c, fail("unavailable", "发起扫码登录失败，详情在日志里"));
		}
	});

	app.delete("/:sourceKey/auth", async (c) => {
		const found = authOf(c.req.param("sourceKey"));
		if ("failure" in found) return respondFailure(c, found.failure);
		try {
			const out = await found.auth.logout();
			if (!out.ok) return respondFailure(c, out);
			return c.json(responseOf(found.auth));
		} catch (err) {
			log.error(`DELETE /api/sources/:sourceKey/auth threw: ${errorMessageOf(err)}`);
			return respondFailure(c, fail("unavailable", "退出登录失败，详情在日志里"));
		}
	});

	return app;
}
