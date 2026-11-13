import type { ExtensionContext } from "@bilibili-notify/extension";

export function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export async function image(ctx: ExtensionContext, field: unknown, signal: AbortSignal) {
	const urls = object(field).url_list;
	if (!Array.isArray(urls)) return;
	for (const url of urls) {
		if (signal.aborted) return;
		if (typeof url !== "string" || !url.startsWith("https://")) continue;
		const result = await ctx.fetchImage(url, {
			signal,
			headers: { Referer: "https://www.douyin.com/" },
		});
		if (result.ok) return result.ref;
	}
}
