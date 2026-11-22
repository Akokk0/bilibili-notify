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

function creatorId(input: string) {
	const direct = decimalId(input.trim());
	if (direct) return direct;
	const url = URL.parse(input.trim());
	if (
		!url ||
		!trustedHttps(url) ||
		!["weibo.com", "www.weibo.com", "m.weibo.cn"].includes(url.hostname)
	)
		return;
	return decimalId(/^\/(?:u|profile)\/(\d+)\/?$/.exec(url.pathname)?.[1]);
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
		uid: string,
		caller: AbortSignal,
	): Promise<Result<{ profile: CreatorProfileReport; following: unknown }>> {
		const signal = AbortSignal.any([caller, account.sessionSignal()]);
		if (!decimalId(uid)) return fail("invalid", ctx.i18n.t("profile.input"));
		const result = await account.get(
			"/ajax/profile/info",
			{ uid, scene: "1" },
			signal,
			`${HOME}u/${uid}`,
		);
		if (!result.ok) return result;
		const user = record(record(result.data.data).user);
		if (
			decimalId(user.idstr ?? user.id) !== uid ||
			typeof user.screen_name !== "string" ||
			!user.screen_name.trim()
		)
			return fail("unavailable", ctx.i18n.t("request.unavailable"));
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
		return ok({ profile, following: user.following });
	}
	return {
		async searchCreators(input, signal) {
			const uid = creatorId(input);
			if (!uid) return fail("invalid", ctx.i18n.t("profile.input"));
			const found = await profile(uid, signal);
			if (!found.ok) return found.code === "not_found" ? ok({ candidates: [] }) : found;
			if (found.following === false && uid !== account.uid())
				return fail("invalid", ctx.i18n.t("profile.follow"));
			return ok({ candidates: [{ externalId: uid, ...found.profile }] });
		},
		async fetchProfile(identity, signal) {
			const found = await profile(identity.externalId, signal);
			return found.ok ? ok(found.profile) : found;
		},
	};
}
