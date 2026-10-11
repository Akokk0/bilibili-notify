import type { SourceAuthResponse } from "@bilibili-notify/contract";
import { type Failure, fail, type SourceAuth } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { errorMessageOf } from "../util/error-message.js";
import { respondFailure } from "./respond-failure.js";
import type { RouteDeps } from "./types.js";

/**
 * `/api/sources` — 来源的登录口(`Source.auth`,ADR-0021 决策 45)。
 *
 * - `GET    /:sourceKey/auth` 读状态与账号;
 * - `POST   /:sourceKey/auth` 发起扫码登录(已经在等扫码时回 `conflict`);
 * - `DELETE /:sourceKey/auth` 退出登录。
 *
 * 路由直接问来源登记表,不持有状态:来源不在回 `unavailable`、没有登录口回 `unsupported`;实现抛了算 bug,
 * 记一行 error(只记抛出来的话)、回 `unavailable`。回包逐格挑,里面没有 cookie 与令牌。
 *
 * 拒绝重复发起放在这里而不是实现里:`confirming` 同时表示「开机还没确认」,那时必须能发起扫码,路由只看得到
 * `AuthState`、分不出两种情况,所以只在 `awaiting-scan` 时拦;`confirming` 时放行并换一张新码。
 */
export function createSourcesRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

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
