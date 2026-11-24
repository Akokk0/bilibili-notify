import type { ExtensionContext, ImageRef } from "@bilibili-notify/extension";
import { web } from "./pages";

export function imageDeadline(started: number): number {
	// Leave time inside the host's 15-second lookup for returning the verified metadata.
	return Math.min(started + 12000, Date.now() + 2500);
}

export function createImageReader(ctx: ExtensionContext) {
	const images = new Map<string, { ref: ImageRef; expires: number }>();
	return async (
		value: unknown,
		signal: AbortSignal,
		deadline: number,
	): Promise<ImageRef | undefined> => {
		if (typeof value !== "string" || !value || signal.aborted) return;
		const url = URL.parse(value, web);
		if (
			!url ||
			url.username ||
			url.password ||
			url.port ||
			!/(^|\.)(msstatic\.com|huya\.com)$/.test(url.hostname)
		)
			return;
		if (url.protocol === "http:") url.protocol = "https:";
		if (url.protocol !== "https:") return;
		const key = url.href;
		const cached = images.get(key);
		if (cached && cached.expires > Date.now()) return cached.ref;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return;
		const limit = new AbortController();
		const photoSignal = AbortSignal.any([signal, limit.signal]);
		let onAbort!: () => void;
		const stopped = new Promise<undefined>((resolve) => {
			onAbort = () => resolve(undefined);
			photoSignal.addEventListener("abort", onAbort, { once: true });
		});
		const timer = ctx.setTimeout(() => limit.abort(), remaining);
		const download = ctx.fetchImage(key, { signal: photoSignal, headers: { Referer: `${web}/` } });
		const result = await Promise.race([download, stopped]).finally(() => {
			timer.dispose();
			photoSignal.removeEventListener("abort", onAbort);
		});
		if (!result?.ok || photoSignal.aborted) return;
		images.delete(key);
		images.set(key, { ref: result.ref, expires: Date.now() + 300000 });
		if (images.size > 512) {
			const first = images.keys().next();
			if (!first.done) images.delete(first.value);
		}
		return result.ref;
	};
}
