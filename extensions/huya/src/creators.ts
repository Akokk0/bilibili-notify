import {
	type CreatorCandidate,
	type ExtensionContext,
	fail,
	type Identity,
	ok,
} from "@bilibili-notify/extension";
import { decimal, type HuyaClient, record } from "./client";
import { createImageReader, imageDeadline } from "./images";
import { observe } from "./live";
import { pageRoom, publicRoom, web } from "./pages";

export interface HuyaRoom {
	uid: string;
	number: string;
	name: string;
	data: Record<string, unknown>;
}

interface CandidatePhoto {
	candidate: CreatorCandidate;
	url: string;
}

function followerCount(value: unknown): number | undefined {
	const count = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
	return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

export function createDirectory(ctx: ExtensionContext, client: HuyaClient) {
	const readImage = createImageReader(ctx);
	const rooms = new Map<string, string>();
	function remember(uid: string, number: string) {
		rooms.delete(uid);
		rooms.set(uid, number);
		if (rooms.size > 512) {
			const oldest = rooms.keys().next();
			if (!oldest.done) rooms.delete(oldest.value);
		}
	}
	const invalid = () => fail("invalid", ctx.i18n.t("profile.input"));
	async function room(number: string, signal: AbortSignal) {
		const url = new URL("https://mp.huya.com/cache.php");
		url.search = new URLSearchParams({ m: "Live", do: "profileRoom", roomid: number }).toString();
		const result = await client.json(url, signal);
		if (!result.ok) return result;
		if (result.data.status === 422 && /^该主播不存在[！!。]?$/.test(String(result.data.message)))
			return fail("not_found", ctx.i18n.t("profile.missing"));
		const data = record(result.data.data);
		const profile = record(data.profileInfo);
		const uid = decimal(profile.uid);
		const roomNumber = decimal(profile.profileRoom);
		if (
			result.data.status !== 200 ||
			!uid ||
			!roomNumber ||
			typeof profile.nick !== "string" ||
			!profile.nick.trim()
		)
			return client.unavailable();
		return ok({ uid, number: roomNumber, name: profile.nick, data });
	}
	async function lookup(uid: string, signal: AbortSignal) {
		if (!decimal(uid)) return invalid();
		const cached = rooms.get(uid);
		if (cached) {
			const result = await room(cached, signal);
			if (!result.ok && result.code !== "not_found") return result;
			if (result.ok && result.uid === uid) {
				remember(uid, result.number);
				return result;
			}
			rooms.delete(uid);
		}
		const page = await pageRoom(client, new URL(`/video/u/${uid}`, web), signal, true);
		if (!page.ok) return page;
		if (page.number === cached) return client.unavailable();
		const result = await room(page.number, signal);
		if (!result.ok) return result;
		if (result.uid !== uid) return client.unavailable();
		remember(uid, result.number);
		return result;
	}
	async function loadCandidatePhotos(
		photos: CandidatePhoto[],
		signal: AbortSignal,
		started: number,
	) {
		const deadline = imageDeadline(started);
		const remaining = photos.values();
		async function readRemaining() {
			for (const { candidate, url } of remaining) {
				if (signal.aborted) return;
				const avatar = await readImage(url, signal, deadline);
				if (avatar) candidate.avatar = avatar;
			}
		}
		await Promise.all(Array.from({ length: Math.min(3, photos.length) }, readRemaining));
	}
	async function nickname(input: string, signal: AbortSignal) {
		const started = Date.now();
		const url = new URL("https://search.cdn.huya.com/");
		url.search = new URLSearchParams({
			m: "Search",
			do: "getSearchContent",
			q: input,
			uid: "0",
			v: "1",
			typ: "-5",
			livestate: "0",
			rows: "10",
			start: "0",
		}).toString();
		const result = await client.json(url, signal);
		if (!result.ok) return result;
		const rows = record(record(result.data.response)["1"]).docs;
		if (!Array.isArray(rows)) return client.unavailable();
		const candidates = new Map<string, CreatorCandidate>();
		const photos: CandidatePhoto[] = [];
		for (const item of rows) {
			const row = record(item);
			const uid = decimal(row.uid),
				number = decimal(row.room_id);
			if (
				!uid ||
				!number ||
				typeof row.game_nick !== "string" ||
				!row.game_nick.trim() ||
				candidates.has(uid)
			)
				continue;
			const candidate: CreatorCandidate = {
				externalId: uid,
				displayId: number,
				name: row.game_nick,
			};
			const followers = followerCount(row.game_activityCount);
			if (followers !== undefined) candidate.followers = followers;
			candidates.set(uid, candidate);
			const url = [row.game_avatarUrl180, row.game_avatarUrl52].find(
				(value): value is string => typeof value === "string" && Boolean(value.trim()),
			);
			if (url) photos.push({ candidate, url });
			remember(uid, number);
			if (candidates.size === 10) break;
		}
		if (rows.length && !candidates.size) return client.unavailable();
		await loadCandidatePhotos(photos, signal, started);
		if (signal.aborted) return fail("indeterminate", ctx.i18n.t("request.cancelled"));
		return ok({ candidates: [...candidates.values()] });
	}
	async function searchCreators(query: string, signal: AbortSignal) {
		const started = Date.now();
		const input = query.trim();
		if (!input) return ok({ candidates: [] });
		let number = decimal(input);
		if (!number) {
			if (!/^[a-z][a-z\d+.-]*:/i.test(input) && !input.startsWith("//") && !input.includes("/"))
				return nickname(input, signal);
			const alias = publicRoom(URL.parse(input));
			if (!alias) return fail("invalid", ctx.i18n.t("profile.input"));
			number = decimal(alias);
			if (!number) {
				const found = await pageRoom(client, new URL(alias, web), signal);
				if (!found.ok) return found;
				number = found.number;
			}
		}
		const result = await room(number, signal);
		if (!result.ok) return result.code === "not_found" ? ok({ candidates: [] }) : result;
		remember(result.uid, result.number);
		const profile = await profileOf(result, signal, started);
		if (!profile.ok) return profile;
		const { ok: _, ...fields } = profile;
		return ok({ candidates: [{ externalId: result.uid, ...fields }] });
	}
	async function profileOf(room: HuyaRoom, signal: AbortSignal, started = Date.now()) {
		const profile = record(room.data.profileInfo);
		const live = record(room.data.liveData);
		const followers =
			followerCount(profile.activityCount) ??
			(decimal(live.uid) === room.uid ? followerCount(live.activityCount) : undefined);
		const avatar = await readImage(profile.avatar180, signal, imageDeadline(started));
		if (signal.aborted) return fail("indeterminate", ctx.i18n.t("request.cancelled"));
		return ok({
			name: room.name,
			displayId: room.number,
			...(followers !== undefined && { followers }),
			...(avatar && { avatar }),
		});
	}
	async function fetchProfile(identity: Identity, signal: AbortSignal) {
		const started = Date.now();
		const result = await lookup(identity.externalId, signal);
		return result.ok ? profileOf(result, signal, started) : result;
	}
	return {
		searchCreators,
		fetchProfile,
		lookup,
		profileOf,
		observationOf: (room: HuyaRoom, signal: AbortSignal, started = Date.now()) =>
			observe(ctx, room, signal, readImage, imageDeadline(started)),
	};
}
