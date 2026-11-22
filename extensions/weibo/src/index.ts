import type { ExtensionContext } from "@bilibili-notify/extension";
import { createAccount } from "./account";
import { createCreators } from "./creators";

export function activate(ctx: ExtensionContext): void {
	const account = createAccount(ctx);
	ctx.registerSource({
		auth: account.auth,
		...createCreators(ctx, account),
		start() {},
		stop() {},
	});
}
