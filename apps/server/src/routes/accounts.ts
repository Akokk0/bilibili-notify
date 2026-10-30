import type { AccountsResponse } from "@bilibili-notify/contract";
import { fail } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { accountViews } from "../accounts/accounts.js";
import { t } from "../i18n/index.js";
import { errorMessageOf } from "../util/error-message.js";
import { respondFailure } from "./respond-failure.js";
import type { RouteDeps } from "./types.js";

export function createAccountsRoute(deps: RouteDeps, settle?: () => Promise<void>): Hono {
	const app = new Hono();
	app.get("/", async (c) => {
		await settle?.();
		try {
			return c.json({
				accounts: accountViews(
					deps.runtime.sourceRegistry.list(),
					deps.store.getGlobals().accounts?.order,
				),
			} satisfies AccountsResponse);
		} catch (err) {
			deps.runtime.serviceCtx.logger.error(`GET /api/accounts threw: ${errorMessageOf(err)}`);
			return respondFailure(c, fail("unavailable", t("accounts.readFailed")));
		}
	});
	return app;
}
