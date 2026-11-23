import { type ExtensionContext, fail, ok } from "@bilibili-notify/extension";

export function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function decimal(value: unknown): string | undefined {
	const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
	return typeof id === "string" && /^[1-9]\d*$/.test(id) ? id : undefined;
}

export function createClient(ctx: ExtensionContext) {
	const unavailable = () => fail("unavailable", ctx.i18n.t("request.unavailable"));
	async function read(url: URL, signal: AbortSignal) {
		const response = await ctx.http.fetch(url, {
			bare: true,
			maxRedirects: 0,
			maxBodyBytes: 2 * 1024 * 1024,
			timeoutMs: 10000,
			signal,
		});
		if (!response.ok) return response;
		const location = response.headers.get("location");
		if ([301, 302, 303, 307, 308].includes(response.status) && location)
			return ok({ body: "", location });
		if (!response.isSuccess) return unavailable();
		return ok({ body: response.text(), location: undefined });
	}
	async function json(url: URL, signal: AbortSignal) {
		const response = await read(url, signal);
		if (!response.ok) return response;
		try {
			const value = JSON.parse(
				response.body,
				(_key, value: unknown, context?: { source?: string }) =>
					typeof value === "number" &&
					!Number.isSafeInteger(value) &&
					context?.source &&
					/^\d+$/.test(context.source)
						? context.source
						: value,
			);
			return ok({ data: record(value) });
		} catch {
			return unavailable();
		}
	}
	return { read, json, unavailable };
}
export type HuyaClient = ReturnType<typeof createClient>;
