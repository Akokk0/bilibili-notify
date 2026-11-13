import {
	type AuthState,
	FAILURE_CODES,
	fail,
	IMAGE_REF_PATTERN,
	ok,
	type Result,
	type SourceAuth,
} from "@bilibili-notify/internal";
import { z } from "zod";
import { t } from "../i18n/index.js";

const message = z.string().trim().min(1).max(500);
const timestamp = z.iso.datetime({ offset: true });
const verification = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("sms"), attemptId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
	z.object({
		kind: z.literal("external"),
		url: z
			.url({ protocol: /^https$/ })
			.max(4096)
			.refine((value) => {
				const url = URL.parse(value);
				return url && !url.username && !url.password;
			}),
	}),
]);
// Project only public fields before auth data reaches REST, WebSocket or a command.
const stateSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("logged-out") }),
	z.object({ status: z.literal("logged-in"), loggedInAt: timestamp }),
	z.object({
		status: z.literal("awaiting-scan"),
		qr: z.object({
			dataUrl: z
				.string()
				.max(512 * 1024)
				.regex(/^data:image\/png;base64,[a-zA-Z0-9+/]+=*$/),
			expiresAt: timestamp,
		}),
	}),
	z.object({
		status: z.literal("confirming"),
		message: message.optional(),
		verification: verification.optional(),
	}),
	z.object({ status: z.enum(["expired", "error"]), message }),
]);
const accountSchema = z.object({
	name: z.string().trim().min(1).max(256),
	avatar: z.string().regex(IMAGE_REF_PATTERN).optional(),
});

export function extensionSourceAuth(provider: SourceAuth, stopped: () => boolean): SourceAuth {
	for (const member of ["state", "beginLogin", "logout", "onChange"] as const) {
		if (typeof provider[member] !== "function") throw new Error(`source auth requires ${member}()`);
	}
	const inactive = () => fail("unavailable", t("sources.notRunning"));
	const failed = () => fail("unavailable", t("sources.auth.operationFailed"));
	const state = (): AuthState => {
		if (stopped()) return { status: "logged-out" };
		try {
			const parsed = stateSchema.safeParse(provider.state());
			if (parsed.success) return parsed.data;
		} catch {}
		return { status: "error", message: t("sources.auth.operationFailed") };
	};
	const action = async (fn: () => Promise<Result>): Promise<Result> => {
		if (stopped()) return inactive();
		try {
			const result = await fn();
			if (stopped()) return inactive();
			if (result.ok === true) return ok();
			if (
				result.ok === false &&
				Object.hasOwn(FAILURE_CODES, result.code) &&
				message.safeParse(result.message).success
			)
				return fail(result.code, result.message);
		} catch {}
		return failed();
	};
	const submitVerification = provider.submitVerification?.bind(provider);
	return {
		state,
		beginLogin: () => action(() => provider.beginLogin()),
		logout: () => action(() => provider.logout()),
		...(submitVerification
			? {
					submitVerification: (attemptId: string, code: string) =>
						action(() => submitVerification(attemptId, code)),
				}
			: {}),
		account() {
			if (state().status !== "logged-in") return null;
			try {
				const parsed = accountSchema.safeParse(provider.account?.());
				return parsed.success ? parsed.data : null;
			} catch {
				return null;
			}
		},
		onChange(fn) {
			const handle = provider.onChange(() => {
				if (!stopped()) fn();
			});
			return { dispose: () => handle.dispose() };
		},
	};
}
