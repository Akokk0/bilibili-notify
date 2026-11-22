import type { ExtensionContext } from "@bilibili-notify/extension";
import { createAccount } from "./account";
import { createCreators } from "./creators";
import { createFeed } from "./feed";

export function activate(ctx: ExtensionContext): void {
	const account = createAccount(ctx);
	ctx.registerSource({
		auth: account.auth,
		...createCreators(ctx, account),
		...createFeed(ctx, account),
	});
}
