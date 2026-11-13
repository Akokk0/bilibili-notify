import {
	type CreatorCandidate,
	type CreatorProfileReport,
	type ExtensionContext,
	type Failure,
	fail,
	ok,
	type Result,
} from "@bilibili-notify/extension";
import { count, image, object, text } from "./media";
import type { DouyinSourceClient } from "./source";

function missing(failure: Failure) {
	return failure.code === "not_found" && failure.upstreamCode !== "douyin.private";
}

function webUrl(url: URL | null): url is URL {
	return !!url && url.protocol === "https:" && !url.port && !url.username && !url.password;
}

export function createCreatorDirectory(ctx: ExtensionContext, client: DouyinSourceClient) {
	const invalidProfile = () => fail("unavailable", ctx.i18n.t("error.profile"));
	const homepage = () => fail("invalid", ctx.i18n.t("error.homepage"));
	async function profile(
		user: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<Result<CreatorProfileReport>> {
		const name = text(user.nickname);
		if (!name) return invalidProfile();
		const avatar = await image(ctx, user.avatar_thumb ?? user.avatar_medium, signal);
		if (signal.aborted) return fail("indeterminate", ctx.i18n.t("error.stopped"));
		const followers = count(user.follower_count);
		const bio = text(user.signature);
		return ok({
			name,
			...(avatar && { avatar }),
			...(followers !== undefined && { followers }),
			...(bio && { bio }),
		});
	}
	async function lookup(id: string, signal: AbortSignal) {
		const result = await client.profile(id, signal);
		if (!result.ok) return result;
		const user = object(object(result.data).user);
		return user.sec_uid === id && text(user.nickname) ? ok({ user }) : invalidProfile();
	}
	async function byId(id: string, signal: AbortSignal) {
		const found = await lookup(id, signal);
		if (!found.ok) return missing(found) ? ok({ candidates: [] }) : found;
		const result = await profile(found.user, signal);
		if (!result.ok) return result;
		const { ok: _, ...info } = result;
		return ok({ candidates: [{ ...info, externalId: id }] });
	}
	async function searchCreators(
		input: string,
		signal: AbortSignal,
	): Promise<Result<{ candidates: CreatorCandidate[] }>> {
		const query = input.trim();
		if (!query) return ok({ candidates: [] });
		const match = query.match(/https?:\/\/[^\s<>"，。]+/iu);
		if (match) {
			let url = URL.parse(match[0]);
			if (!webUrl(url)) return homepage();
			if (url.hostname === "v.douyin.com") {
				const expanded = await client.expand(url, signal);
				if (!expanded.ok) return expanded;
				url = expanded.url;
			}
			if (!webUrl(url)) return homepage();
			const path =
				url.hostname === "www.douyin.com"
					? /^\/user\/([\w-]+)\/?$/
					: url.hostname === "www.iesdouyin.com"
						? /^\/share\/user\/([\w-]+)\/?$/
						: undefined;
			const id = path?.exec(url.pathname)?.[1];
			return id ? byId(id, signal) : homepage();
		}
		if (/^MS4w[\w-]+$/.test(query)) return byId(query, signal);
		let accountFailure: Failure | undefined;
		if (/^[a-z0-9_.-]{1,64}$/i.test(query)) {
			const result = await client.account(query, signal);
			if (signal.aborted) return fail("indeterminate", ctx.i18n.t("error.stopped"));
			if (!result.ok && !missing(result)) {
				if (!["unavailable", "unsupported", "timeout"].includes(result.code)) return result;
				accountFailure = result;
			}
			if (result.ok) {
				const user = object(object(result.data).user_info);
				const id = text(user.sec_uid);
				if (id && (user.unique_id === query || (!user.unique_id && user.short_id === query)))
					return byId(id, signal);
			}
		}
		const result = await client.search(query, signal);
		if (!result.ok) return result;
		const rows = object(result.data).user_list;
		if (!Array.isArray(rows)) return invalidProfile();
		const seen = new Set<string>();
		const candidates: CreatorCandidate[] = [];
		for (const row of rows) {
			const user = object(object(row).user_info);
			const id = text(user.sec_uid);
			if (!id || seen.has(id) || !text(user.nickname)) continue;
			const info = await profile(user, signal);
			if (!info.ok) return info;
			const { ok: _, ...fields } = info;
			const account = text(user.unique_id) ?? text(user.short_id) ?? id;
			candidates.push({
				...fields,
				externalId: id,
				bio: [ctx.i18n.t("search.account", { account }), fields.bio].filter(Boolean).join(" · "),
			});
			seen.add(id);
			if (candidates.length === 10) break;
		}
		return candidates.length === 0 && accountFailure ? accountFailure : ok({ candidates });
	}
	return { lookup, profile, searchCreators };
}
