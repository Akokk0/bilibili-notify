import { fail, ok } from "@bilibili-notify/extension";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { host, room } from "./host";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

it("用数字房间号添加主播，在 JSON 数字超过安全整数时仍按完整 UID 建订阅", async () => {
	const app = host((url) => {
		expect(url.origin + url.pathname).toBe("https://mp.huya.com/cache.php");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			m: "Live",
			do: "profileRoom",
			roomid: "42",
		});
		return {
			headers: { "content-type": "text/html" },
			body: JSON.stringify(room("9223372036854775801", "42")).replace(
				'"9223372036854775801"',
				"9223372036854775801",
			),
		};
	});
	expect(await app.source.searchCreators("42", app.signal)).toEqual({
		ok: true,
		candidates: [{ externalId: "9223372036854775801", displayId: "42", name: "阿虎" }],
	});
});

it("手机别名链接从 canonical 找房间号，外站链接和跨站跳转不会产生外站请求", async () => {
	const app = host((url) => {
		if (url.href === "https://www.huya.com/lpl")
			return { body: '<html><head><link href="/42" rel="canonical"></head></html>' };
		if (url.href === "https://www.huya.com/moved")
			return { status: 302, headers: { location: "https://other.example/42" } };
		if (url.hostname === "mp.huya.com" && url.searchParams.get("roomid") === "42")
			return { body: room("71", "42") };
		throw new Error(`Unexpected network destination: ${url.href}`);
	});
	const lookup = app.source.searchCreators("https://m.huya.com/lpl?share=1", app.signal);
	await vi.advanceTimersByTimeAsync(6000);
	expect(await lookup).toMatchObject({
		ok: true,
		candidates: [{ externalId: "71", displayId: "42" }],
	});
	for (const input of ["https://www.huya.com.evil.example/42", "https://www.huya.com/moved"]) {
		const result = app.source.searchCreators(input, app.signal);
		await vi.advanceTimersByTimeAsync(3000);
		expect((await result).ok).toBe(false);
	}
});

it("按昵称列出同名不同人的候选，忽略重复 UID，最多交十位主播", async () => {
	const app = host((url) => {
		expect(url.origin).toBe("https://search.cdn.huya.com");
		expect(url.searchParams.get("q")).toBe("阿虎");
		const rows = Array.from({ length: 12 }, (_, i) => ({
			uid: 100 + i,
			room_id: 200 + i,
			game_nick: "阿虎",
		}));
		return { body: { response: { "1": { numFound: 12, docs: [rows[0], ...rows] } } } };
	});
	const result = await app.source.searchCreators("阿虎", app.signal);
	expect(result.ok && result.candidates).toHaveLength(10);
	if (result.ok)
		expect(result.candidates.slice(0, 2)).toEqual([
			{ externalId: "100", displayId: "200", name: "阿虎" },
			{ externalId: "101", displayId: "201", name: "阿虎" },
		]);
});

it("昵称搜索用搜索结果的头像填入候选，单张坏图仍保留该主播和原有顺序", async () => {
	const first = "https://huyaimg.msstatic.com/first.jpg";
	const second = "https://huyaimg.msstatic.com/second.jpg";
	const ref = `${"c".repeat(64)}.jpg` as const;
	const app = host(() => ({
		body: {
			response: {
				"1": {
					docs: [
						{ uid: 71, room_id: 998, game_nick: "楚河", game_avatarUrl180: first },
						{ uid: 72, room_id: 43, game_nick: "楚楚河河", game_avatarUrl52: second },
					],
				},
			},
		},
	}));
	app.ctx.fetchImage.mockImplementation(async (url) =>
		url === first ? ok({ ref }) : fail("not_found", "fixture"),
	);
	expect(await app.source.searchCreators("楚河", app.signal)).toEqual({
		ok: true,
		candidates: [
			{ externalId: "71", displayId: "998", name: "楚河", avatar: ref },
			{ externalId: "72", displayId: "43", name: "楚楚河河" },
		],
	});
	expect(app.ctx.fetchImage.mock.calls.map(([url]) => url)).toEqual([first, second]);
	expect(app.fetch).toHaveBeenCalledTimes(1);
});

it("一张头像迟迟不回时继续加载后面的候选，宿主取消整个搜索时则中止", async () => {
	const slow = "https://huyaimg.msstatic.com/slow.jpg";
	const docs = [slow, ...["b", "c", "d"].map((n) => `https://huyaimg.msstatic.com/${n}.jpg`)].map(
		(url, i) => ({ uid: i + 71, room_id: i + 998, game_nick: "楚河", game_avatarUrl180: url }),
	);
	const app = host(() => ({
		body: { response: { "1": { docs } } },
	}));
	const ref = `${"a".repeat(64)}.jpg` as const;
	app.ctx.fetchImage.mockImplementation((url, options) => {
		if (url !== slow) return Promise.resolve(ok({ ref }));
		return new Promise((resolve) => {
			options?.signal?.addEventListener(
				"abort",
				() => resolve(fail("indeterminate", "cancelled")),
				{ once: true },
			);
		});
	});
	const search = app.source.searchCreators("楚河", app.signal);
	await vi.advanceTimersByTimeAsync(3000);
	const result = await search;
	expect(result.ok && result.candidates.map((c) => c.avatar)).toEqual([undefined, ref, ref, ref]);
	const cancel = new AbortController();
	const abandoned = app.source.searchCreators("楚河", cancel.signal);
	await vi.advanceTimersByTimeAsync(1);
	cancel.abort();
	expect(await abandoned).toMatchObject({ ok: false, code: "indeterminate" });
});

it.each([0, 12500])("数字房间资料用时 %i 毫秒时，慢头像仍能在宿主截止前降级", async (delay) => {
	const app = host(async () => {
		if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
		const snapshot = room("71", "42");
		return {
			body: {
				...snapshot,
				data: {
					...snapshot.data,
					profileInfo: {
						...snapshot.data.profileInfo,
						avatar180: "https://huyaimg.msstatic.com/slow.jpg",
						activityCount: 20,
					},
				},
			},
		};
	});
	app.ctx.fetchImage.mockImplementation(() => new Promise(() => {}));
	const received = vi.fn();
	void app.source.searchCreators("42", app.signal).then(received);
	await vi.advanceTimersByTimeAsync(delay || 3000);
	expect(received).toHaveBeenCalledWith({
		ok: true,
		candidates: [{ externalId: "71", displayId: "42", name: "阿虎", followers: 20 }],
	});
	if (!delay) expect(app.ctx.fetchImage.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	app.dispose();
});

it("昵称候选保留精确粉丝数和零粉丝，缺失或无效的计数留空", async () => {
	const counts = ["1612", 0, null, "", -1, "1.6万", "9007199254740993"];
	const docs = counts.map((count, i) => ({
		uid: i + 1,
		room_id: i + 42,
		game_nick: "楚河",
		game_activityCount: count,
		totalCount: 5000,
	}));
	const app = host(() => ({ body: { response: { "1": { docs } } } }));
	const result = await app.source.searchCreators("楚河", app.signal);
	expect(result.ok && result.candidates.map((candidate) => candidate.followers)).toEqual([
		1612,
		0,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
	]);
});

it.each([
	{ profile: 0, live: 900, owner: "71", expected: 0 },
	{ profile: "9884306", live: 500, owner: "71", expected: 9884306 },
	{ profile: null, live: "1616", owner: "71", expected: 1616 },
	{ profile: null, live: 1234, owner: "85", expected: undefined },
	{ profile: null, live: null, owner: "71", expected: undefined },
])("房间号搜索和订阅资料都使用房主的粉丝数：$profile / $live ($owner)", async (sample) => {
	const app = host(() => {
		const snapshot = room("71", "998", "OFF", {
			uid: sample.owner,
			activityCount: sample.live,
			totalCount: 5000,
			attendeeCount: 3000,
		});
		return {
			body: {
				...snapshot,
				data: {
					...snapshot.data,
					profileInfo: { ...snapshot.data.profileInfo, activityCount: sample.profile },
				},
			},
		};
	});
	const search = await app.source.searchCreators("998", app.signal);
	expect(search.ok && search.candidates[0]?.followers).toBe(sample.expected);
	const refresh = app.source.fetchProfile?.({ sourceKey: "huya", externalId: "71" }, app.signal);
	await vi.advanceTimersByTimeAsync(3000);
	const profile = await refresh;
	expect(profile?.ok && profile.followers).toBe(sample.expected);
});

it("旧房间换人后按原 UID 找回主播，冷启动也能从离线主页恢复", async () => {
	let owner = "71";
	const identify = { sourceKey: "huya", externalId: "71" };
	const handle = (url: URL) => {
		if (url.href === "https://www.huya.com/video/u/71")
			return {
				body: '<a href="//www.huya.com/8">推荐</a><a href="//www.huya.com/99" class="link-live J_userLinkLive">直播间</a>',
			};
		const id = url.searchParams.get("roomid");
		expect(["42", "99"]).toContain(id);
		return { body: room(id === "42" ? owner : "71", id ?? "") };
	};
	const app = host(handle);
	await app.source.searchCreators("42", app.signal);
	owner = "92";
	for (const current of [app, host(handle)]) {
		const profile = current.source.fetchProfile?.(identify, current.signal);
		await vi.advanceTimersByTimeAsync(15000);
		expect(await profile).toMatchObject({ ok: true, displayId: "99", name: "阿虎" });
	}
});

it("旧房间仍能查出本人的新房间号时，下次直接查新房间", async () => {
	let current = "42";
	const app = host(() => ({ body: room("71", current) }));
	await app.source.searchCreators("42", app.signal);
	current = "99";
	const identity = { sourceKey: "huya", externalId: "71" };
	for (const expected of ["42", "99"]) {
		const profile = app.source.fetchProfile?.(identity, app.signal);
		await vi.advanceTimersByTimeAsync(3000);
		expect(await profile).toMatchObject({ ok: true, displayId: "99" });
		const queried = app.fetch.mock.calls.at(-1)?.[0];
		expect(queried && new URL(queried).searchParams.get("roomid")).toBe(expected);
	}
});

it("搜索、资料和直播复核复用近期的图库引用，地址变化或五分钟后重新取图", async () => {
	let cover = "https://anchorpost.msstatic.com/a.jpg";
	const avatar = "https://huyaimg.msstatic.com/avatar.jpg";
	const app = host(() => {
		const result = room("71", "42", "ON", { screenshot: cover });
		return {
			body: {
				...result,
				data: { ...result.data, profileInfo: { ...result.data.profileInfo, avatar180: avatar } },
			},
		};
	});
	app.ctx.fetchImage.mockResolvedValue(ok({ ref: `${"b".repeat(64)}.jpg` }));
	const identity = { sourceKey: "huya", externalId: "71" };
	await app.source.searchCreators("42", app.signal);
	const profile = app.source.fetchProfile?.(identity, app.signal);
	const live = app.source.fetchLiveStatus?.(identity, app.signal);
	await vi.advanceTimersByTimeAsync(3000);
	expect(await profile).toMatchObject({ ok: true, avatar: expect.any(String) });
	expect(await live).toMatchObject({ ok: true, details: { cover: expect.any(String) } });
	const repeated = app.source.fetchLiveStatus?.(identity, app.signal);
	await vi.advanceTimersByTimeAsync(3000);
	await repeated;
	expect(app.ctx.fetchImage.mock.calls.map(([url]) => url)).toEqual([avatar, cover]);
	cover = "https://anchorpost.msstatic.com/b.jpg";
	const changed = app.source.fetchLiveStatus?.(identity, app.signal);
	await vi.advanceTimersByTimeAsync(3000);
	await changed;
	await vi.advanceTimersByTimeAsync(300000);
	await app.source.fetchProfile?.(identity, app.signal);
	expect(app.ctx.fetchImage.mock.calls.map(([url]) => url)).toEqual([
		avatar,
		"https://anchorpost.msstatic.com/a.jpg",
		cover,
		avatar,
	]);
});

it("房间核对耗尽图片预算时及时返回已确认的在播状态", async () => {
	let slow = false;
	const app = host(async () => {
		if (slow) await new Promise((resolve) => setTimeout(resolve, 9500));
		return {
			body: room("71", "42", "ON", {
				introduction: "决赛",
				screenshot: "https://live.msstatic.com/cover.jpg",
			}),
		};
	});
	await app.source.searchCreators("42", app.signal);
	app.ctx.fetchImage.mockImplementation(() => new Promise(() => {}));
	slow = true;
	const received = vi.fn();
	void app.source
		.fetchLiveStatus?.({ sourceKey: "huya", externalId: "71" }, app.signal)
		.then(received);
	await vi.advanceTimersByTimeAsync(14000);
	expect(received).toHaveBeenCalledWith({
		ok: true,
		kind: "live",
		details: { title: "决赛", url: "https://www.huya.com/42" },
	});
	app.dispose();
});

it.each([
	["ON", "ON", "live"],
	["OFF", "OFF", "offline"],
	["REPLAY", "REPLAY", "offline"],
	["ON", "OFF", "unavailable"],
	["REPLAY", undefined, "unavailable"],
	["NEW", "NEW", "unavailable"],
])("宿主复核 %s / %s 时得到 %s", async (status, real, expected) => {
	const app = host(() => {
		const data = room("71", "42", status, {
			startTime: 1700000000,
			introduction: "比赛",
			gameFullName: "棋类",
			screenshot: "https://live.msstatic.com/42.jpg",
			totalCount: 5000,
		});
		return { body: { ...data, data: { ...data.data, realLiveStatus: real } } };
	});
	app.ctx.fetchImage.mockResolvedValue(ok({ ref: `${"a".repeat(64)}.jpg` }));
	await app.source.searchCreators("42", app.signal);
	const statusRead = app.source.fetchLiveStatus?.(
		{ sourceKey: "huya", externalId: "71" },
		app.signal,
	);
	await vi.advanceTimersByTimeAsync(3000);
	const actual = await statusRead;
	if (expected === "live")
		expect(actual).toEqual({
			ok: true,
			kind: "live",
			startedAt: "2023-11-14T22:13:20.000Z",
			details: {
				title: "比赛",
				category: "棋类",
				cover: `${"a".repeat(64)}.jpg`,
				url: "https://www.huya.com/42",
			},
		});
	else if (expected === "offline") expect(actual).toEqual({ ok: true, kind: "offline" });
	else expect(actual).toMatchObject({ ok: false, code: "unavailable" });
});

it.each([
	{ isRoomPay: true, isSecret: 0 },
	{ isRoomPay: "1", isSecret: 0 },
	{ isRoomPay: false, isSecret: true },
	{ isRoomPay: false, isSecret: "1" },
])("房间标记限制访问时保留未知状态，即使有在播标记", async (flags) => {
	const app = host(() => {
		const snapshot = room("71", "42", "ON", { isSecret: flags.isSecret });
		return { body: { ...snapshot, data: { ...snapshot.data, isRoomPay: flags.isRoomPay } } };
	});
	await app.source.searchCreators("42", app.signal);
	const read = app.source.fetchLiveStatus?.({ sourceKey: "huya", externalId: "71" }, app.signal);
	await vi.advanceTimersByTimeAsync(3000);
	expect(await read).toMatchObject({ ok: false, code: "unavailable", message: "live.restricted" });
});
