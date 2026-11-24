import type { ExtensionContext } from "@bilibili-notify/extension";
import { HOME, trustedHttps } from "./client";

export function imageUrl(value: unknown) {
	if (typeof value !== "string" || !value.trim()) return;
	const url = URL.parse(value, HOME);
	if (!url || !/(?:^|\.)(?:sinaimg\.cn|sinaimg\.com|weibocdn\.com)$/.test(url.hostname)) return;
	if (url.protocol === "http:") url.protocol = "https:";
	if (trustedHttps(url)) return url;
}

export function avatarUrl(user: Record<string, unknown>) {
	return (
		imageUrl(user.avatar_large) ?? imageUrl(user.profile_image_url) ?? imageUrl(user.avatar_hd)
	);
}

export async function image(ctx: ExtensionContext, url: URL | undefined, signal: AbortSignal) {
	if (!url || signal.aborted) return;
	const result = await ctx.fetchImage(url.href, { headers: { Referer: HOME }, signal });
	return result.ok ? result.ref : undefined;
}
