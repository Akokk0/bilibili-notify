import type { ExtensionContext } from "@bilibili-notify/extension";
import { createAccount } from "./account";
import { createCreators } from "./creators";
import { createFeed } from "./feed";

export function activate(ctx: ExtensionContext): void {
	const account = createAccount(ctx);
	const feed = createFeed(ctx, account);
	ctx.registerSource({
		auth: account.auth,
		...createCreators(ctx, account),
		start(source) {
			account.start();
			return feed.start(source);
		},
		stop() {
			account.stop();
			return feed.stop();
		},
	});
}
