import {
	type CreatorProfileReport,
	type ExtensionContext,
	fail,
	ok,
	type Result,
	type SourceDef,
} from "@bilibili-notify/extension";
import type { WeiboAccount } from "./account";
import { decimalId, HOME, record, trustedHttps } from "./client";
import { avatarUrl, image } from "./media";

type CreatorQuery = { uid: string } | { screen_name: string };

async function profileAvatar(
	ctx: ExtensionContext,
	user: Record<string, unknown>,
	signal: AbortSignal,
	started: number,
) {
	const url = avatarUrl(user);
	const budget = Math.min(2500, started + 12000 - Date.now());
	if (!url || signal.aborted || budget <= 0) return;
	const limit = new AbortController();
	const photoSignal = AbortSignal.any([signal, limit.signal]);
	let onAbort!: () => void;
	const stopped = new Promise<undefined>((resolve) => {
		onAbort = () => resolve(undefined);
		photoSignal.addEventListener("abort", onAbort, { once: true });
	});
	const timer = ctx.setTimeout(() => limit.abort(), budget);
	try {
		return await Promise.race([image(ctx, url, photoSignal), stopped]);
	} finally {
		timer.dispose();
		photoSignal.removeEventListener("abort", onAbort);
	}
}

function nickname(value: string): CreatorQuery | undefined {
	const name = value.replace(/^@/, "");
	if (name && !/[\s/:?#@\\]/u.test(name)) return { screen_name: name };
}

function creatorQuery(input: string): CreatorQuery | undefined {
	const value = input.trim();
	const direct = decimalId(value);
	if (direct) return { uid: direct };
	const url = URL.parse(value);
	if (!url) return nickname(value);
	if (!trustedHttps(url) || !["weibo.com", "www.weibo.com", "m.weibo.cn"].includes(url.hostname))
		return;
	const uid = decimalId(/^\/(?:u|profile)\/(\d+)\/?$/.exec(url.pathname)?.[1]);
	if (uid) return { uid };
	const encoded = /^\/n\/([^/]+)\/?$/.exec(url.pathname)?.[1];
	if (encoded) {
		try {
			return nickname(decodeURIComponent(encoded));
		} catch {
			return;
		}
	}
}

export function createCreators(
	ctx: ExtensionContext,
	account: WeiboAccount,
): Pick<SourceDef, "searchCreators" | "fetchProfile"> {
	async function profile(
		query: CreatorQuery,
		caller: AbortSignal,
	): Promise<Result<{ uid: string; profile: CreatorProfileReport; following: unknown }>> {
		const started = Date.now();
		const signal = AbortSignal.any([caller, account.sessionSignal()]);
		const result = await account.get(
			"/ajax/profile/info",
			{ ...query, scene: "1" },
			signal,
			"uid" in query
				? `${HOME}u/${query.uid}`
				: `${HOME}n/${encodeURIComponent(query.screen_name)}`,
		);
		if (!result.ok) return result;
		const user = record(record(result.data.data).user);
		const uid = decimalId(user.idstr ?? user.id);
		if (
			!uid ||
			("uid" in query && uid !== query.uid) ||
			typeof user.screen_name !== "string" ||
			!user.screen_name.trim()
		)
			return fail("unavailable", ctx.i18n.t("request.unavailable"));
		if (
			"screen_name" in query &&
			user.screen_name.toLowerCase() !== query.screen_name.toLowerCase()
		)
			return fail("not_found", ctx.i18n.t("profile.notFound"));
		const avatar = await profileAvatar(ctx, user, signal, started);
		if (signal.aborted) return fail("indeterminate", ctx.i18n.t("request.cancelled"));
		const profile: CreatorProfileReport = { name: user.screen_name };
		if (avatar) profile.avatar = avatar;
		if (typeof user.description === "string") profile.bio = user.description;
		if (
			typeof user.followers_count === "number" &&
			Number.isSafeInteger(user.followers_count) &&
			user.followers_count >= 0
		)
			profile.followers = user.followers_count;
		return ok({ uid, profile, following: user.following });
	}
	return {
		async searchCreators(input, signal) {
			const query = creatorQuery(input);
			if (!query) return fail("invalid", ctx.i18n.t("profile.input"));
			const found = await profile(query, signal);
			if (!found.ok) return found.code === "not_found" ? ok({ candidates: [] }) : found;
			if (found.following === false && found.uid !== account.uid())
				return fail("invalid", ctx.i18n.t("profile.follow"));
			return ok({ candidates: [{ externalId: found.uid, ...found.profile }] });
		},
		async fetchProfile(identity, signal) {
			const uid = decimalId(identity.externalId);
			if (!uid) return fail("invalid", ctx.i18n.t("profile.input"));
			const found = await profile({ uid }, signal);
			return found.ok ? ok(found.profile) : found;
		},
	};
}
