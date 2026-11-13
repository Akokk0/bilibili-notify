import { type ExtensionContext, fail, ok } from "@bilibili-notify/extension";
import type { DouyinClient } from "./client";
import { toPostReport } from "./posts";
import { dict } from "./web";
export function createLinkResolver(ctx: ExtensionContext, client: DouyinClient) {
	return async (input: string, signal: AbortSignal) => {
		signal = AbortSignal.any([signal, ctx.signal, client.sessionSignal()]);
		const invalid = () => fail("invalid", ctx.i18n.t("api.invalidLink"));
		let url: URL;
		try {
			url = new URL(input);
		} catch {
			return invalid();
		}
		const expanded = await client.expand(url, signal);
		if (!expanded.ok) return expanded;
		const id = /^\/(?:share\/)?(?:video|note|slides)\/(\d{1,24})\/?$/.exec(
			expanded.url.pathname,
		)?.[1];
		if (!id) return invalid();
		const r = await client.detail(id, signal);
		if (!r.ok) return r;
		const detail = dict(dict(r.data).aweme_detail);
		if (detail.aweme_id !== id) return invalid();
		const post = await toPostReport(ctx, detail, signal);
		if (!post.ok) return post;
		if (!post.report.post.creator?.name || signal.aborted) return invalid();
		return ok({
			...post.report,
			post: {
				...post.report.post,
				creator: { ...post.report.post.creator, name: post.report.post.creator.name },
			},
		});
	};
}
