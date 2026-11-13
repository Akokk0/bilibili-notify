import type { ExtensionContext } from "@bilibili-notify/extension";
import { createDouyinAuth } from "./auth";
import { createDouyinClient } from "./client";
import { createLinkResolver } from "./links";
import { createDouyinSource } from "./source";

export function activate(ctx: ExtensionContext): void {
	const auth = createDouyinAuth(ctx);
	const client = createDouyinClient(ctx, auth);
	ctx.registerSource({
		...createDouyinSource(ctx, client),
		auth,
		resolveLink: createLinkResolver(ctx, client),
	});
}
