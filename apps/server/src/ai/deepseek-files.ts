import { type FailureCode, fail, ok, type Result } from "@bilibili-notify/internal";
import { z } from "zod";
import { t } from "../i18n/index.js";

type Profile = { baseUrl: string; apiKey: string };
export const DOCUMENT_LIMIT = 16 * 1024 * 1024;
export const AUDIO_LIMIT = 8 * 1024 * 1024;
type FilePurpose = "text_recognition" | "rich_layout_recognition" | "user_data";

const parsedPages = z.object({
	page_count: z.number().int().optional(),
	pages: z.array(z.object({ text: z.string(), finish_reason: z.literal("stop") })).nonempty(),
});
const upstreamCodes: Readonly<Record<number, FailureCode>> = {
	401: "unauthorized",
	402: "not_configured",
	403: "unauthorized",
	408: "timeout",
	429: "rate_limited",
	504: "timeout",
};

async function request(
	profile: Profile,
	path: string,
	method: "POST" | "DELETE",
	body?: FormData,
	signal?: AbortSignal,
): Promise<Result<{ response: Response }>> {
	const timeout = AbortSignal.timeout(method === "DELETE" ? 10_000 : 180_000);
	try {
		const response = await fetch(profile.baseUrl.replace(/\/+$/, "") + path, {
			method,
			body,
			redirect: "error",
			headers: { Authorization: `Bearer ${profile.apiKey}` },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (response.ok || (method === "DELETE" && response.status === 404)) return ok({ response });
		await response.body?.cancel();
		const status = response.status;
		const code = upstreamCodes[status] ?? (status >= 500 ? "unavailable" : "invalid");
		return fail(code, t("deepseek.upstream", { status }), { upstreamCode: status });
	} catch {
		return fail(timeout.aborted ? "timeout" : "unavailable", t("deepseek.network"));
	}
}

function multipart(file: File, purpose?: FilePurpose, temporary = false) {
	const form = new FormData();
	if (purpose) form.append("purpose", purpose);
	if (temporary) {
		// If the connection breaks before we receive the ID, DeepSeek can still store the file.
		// One hour is the shortest supported expiry; a known ID is always explicitly deleted.
		form.append("expires_after[anchor]", "created_at");
		form.append("expires_after[seconds]", "3600");
	}
	form.append("file", file);
	return form;
}

export async function recognizeFile(
	profile: Profile,
	kind: "asr" | "ocr",
	file: File,
	signal: AbortSignal,
): Promise<Result<{ text: string }>> {
	const baseUrl = profile.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
	const result = await request(
		{ ...profile, baseUrl },
		`/v1/tools/${kind}`,
		"POST",
		multipart(file, kind === "ocr" ? "text_recognition" : undefined),
		signal,
	);
	if (!result.ok) return result;
	const data = await result.response.json().catch(() => null);
	if (kind === "asr") {
		const transcript = z.object({ text: z.string() }).safeParse(data);
		if (transcript.success) return ok(transcript.data);
	} else {
		const parsed = parsedPages.safeParse(data);
		if (parsed.success) {
			const { page_count, pages } = parsed.data;
			if (page_count === undefined || page_count === pages.length)
				return ok({ text: pages.map((page) => page.text).join("\n\n") });
		}
	}
	return fail("unavailable", t("deepseek.incomplete"));
}

export async function uploadDocument(profile: Profile, file: File, richLayout: boolean) {
	const purpose = /\.(xlsx?|csv|txt|md|json|epub|mobi)$/i.test(file.name)
		? "user_data"
		: richLayout
			? "rich_layout_recognition"
			: "text_recognition";
	const result = await request(profile, "/files", "POST", multipart(file, purpose, true));
	if (!result.ok) return result;
	const parsed = z
		.object({ id: z.string().regex(/^[\w-]+$/) })
		.safeParse(await result.response.json().catch(() => null));
	return parsed.success ? ok(parsed.data) : fail("unavailable", t("deepseek.incomplete"));
}

export async function removeDocument(profile: Profile, id: string) {
	const path = `/files/${encodeURIComponent(id)}`;
	let result = await request(profile, path, "DELETE");
	if (!result.ok && ["timeout", "unavailable"].includes(result.code))
		result = await request(profile, path, "DELETE");
	if (result.ok) await result.response.body?.cancel();
	return result;
}
