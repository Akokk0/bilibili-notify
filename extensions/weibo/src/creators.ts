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

type CreatorQuery = { uid: string } | { screen_name: string };

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

export async function image(ctx: ExtensionContext, value: unknown, signal: AbortSignal) {
	if (typeof value !== "string" || !value.trim() || signal.aborted) return;
	const url = URL.parse(value, HOME);
	if (!url || !/(?:^|\.)(?:sinaimg\.cn|sinaimg\.com|weibocdn\.com)$/.test(url.hostname)) return;
	if (url.protocol === "http:") url.protocol = "https:";
	if (!trustedHttps(url)) return;
	const result = await ctx.fetchImage(url.href, { headers: { Referer: HOME }, signal });
	return result.ok ? result.ref : undefined;
}

export function createCreators(
	ctx: ExtensionContext,
	account: WeiboAccount,
): Pick<SourceDef, "searchCreators" | "fetchProfile"> {
	async function profile(
		query: CreatorQuery,
		caller: AbortSignal,
	): Promise<Result<{ uid: string; profile: CreatorProfileReport; following: unknown }>> {
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
		const avatar = await image(
			ctx,
			user.avatar_large ?? user.profile_image_url ?? user.avatar_hd,
			signal,
		);
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
