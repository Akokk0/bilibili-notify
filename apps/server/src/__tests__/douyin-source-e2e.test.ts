// ADR-0047. 跑市场包的实际入口。上游 API 和图床在回环服务器，截图驱动留下卡片 HTML。
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
	CreatorsResponse,
	DevCapturesView,
	ExtensionsResponse,
	HistoryResponse,
	LiveListeningEntry,
	SourceAuthResponse,
	StatsOverviewResponse,
	SubscriptionView,
} from "@bilibili-notify/contract";
import { HttpClient } from "@bilibili-notify/http";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";
import { JPEG_BYTES, PNG_BYTES } from "./support/avatar-fixtures.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { activeGeneration } from "./support/generation.js";

const cards = vi.hoisted(() => [] as string[]);
vi.mock("../runtime/puppeteer.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/puppeteer.js")>();
	const browser = {
		connected: true,
		newPage: async () => ({
			setContent: async (html: string) => {
				cards.push(html);
			},
			waitForFunction: async () => undefined,
			$: async () => ({
				boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
				dispose: async () => {},
			}),
			screenshot: async () => JPEG_BYTES,
			close: async () => {},
			on: () => {},
			setRequestInterception: async () => {},
		}),
		close: async () => {},
		disconnect: () => {},
	};
	return {
		...real,
		createPuppeteerAdapter: (opts: Parameters<typeof real.createPuppeteerAdapter>[0]) =>
			real.createPuppeteerAdapter({
				...opts,
				launcher: { launch: async () => browser, connect: async () => browser },
			}),
	};
});

const identity = { sourceKey: "douyin", externalId: "MS4wSynthCreator123" };
const creator = {
	sec_uid: identity.externalId,
	unique_id: "synthetic_creator",
	nickname: "合成博主",
	signature: "合成资料",
	follower_count: 451,
	avatar_thumb: { url_list: ["https://media.example/avatar.png"] },
};
const room = {
	id_str: "100001",
	status: 2,
	owner: creator,
	title: "合成直播间",
	user_count: 34,
	cover: { url_list: ["https://media.example/live.png"] },
};
const base = makeExtensionSubscription({
	extensionId: identity.sourceKey,
	externalId: identity.externalId,
});
const now = Math.floor(Date.now() / 1000);
const oldWork = {
	aweme_id: "100101",
	create_time: now - 100,
	author: creator,
	desc: "基线前的旧作品",
};
const note = {
	aweme_id: "100102",
	create_time: now - 2,
	author: creator,
	desc: "合成图文",
	images: [{ url_list: ["https://media.example/note.png"] }],
};
const video = {
	aweme_id: "100103",
	create_time: now - 1,
	author: creator,
	desc: "合成视频",
	video: { duration: 6000, cover: { url_list: ["https://media.example/video.png"] } },
};
// A creator with no subscription can still appear in a group preview.
const sharedPost = {
	...note,
	aweme_id: "100104",
	desc: "群聊分享的图文",
	author: { sec_uid: "MS4wAnotherCreator", nickname: "群聊作者" },
};
function imageBytes(path: string) {
	return Buffer.concat([PNG_BYTES, Buffer.from(path)]);
}
let stage: "baseline" | "live" | "end" = "baseline";
let baselineReads = 0;
const invalidRequests: string[] = [];
const imageReads = new Set<string>();
interface Hook {
	targetId: string;
	payload: { segments?: Array<{ type: string; text?: string; mime?: string; data?: string }> };
}
const hooks: Hook[] = [];

let dir: string;
let host: ServerHandle | undefined;
let upstream: Server | undefined;
let origin: string;
let targetId: string;

async function listen(server: Server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return (server.address() as AddressInfo).port;
}

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
	const res = await fetch(host?.url + path, {
		method,
		...(body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	expect(res.status, await res.clone().text()).toBe(200);
	return res.json() as Promise<T>;
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-douyin-market-"));
	const root = fileURLToPath(new URL("../../../../", import.meta.url));
	const archive = join(dir, "douyin.zip");
	await promisify(execFile)(
		process.execPath,
		["scripts/pack-extension.mjs", "--id", "douyin", "--out", archive],
		{ cwd: root },
	);
	upstream = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const reply = (body: object) =>
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
		if (url.pathname === "/hook" && req.method === "POST") {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			hooks.push(JSON.parse(Buffer.concat(chunks).toString()));
			reply({});
			return;
		}
		if (url.pathname === "/v.douyin.com/example/") {
			if (req.headers.cookie) invalidRequests.push("short link received a cookie");
			res.writeHead(302, { location: `https://www.douyin.com/note/${sharedPost.aweme_id}` }).end();
			return;
		}
		if (
			url.pathname === "/www.douyin.com/aweme/v1/web/aweme/detail/" &&
			url.searchParams.get("aweme_id") === sharedPost.aweme_id
		) {
			reply({ status_code: 0, aweme_detail: sharedPost });
			return;
		}
		if (url.pathname === "/www.douyin.com/") {
			res.setHeader("set-cookie", "__ac_nonce=synthetic-nonce; Path=/; Secure");
			res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html>");
			return;
		}
		if (url.pathname === "/login.douyin.com/passport/web/get_qrcode/") {
			reply({
				data: {
					token: "synthetic-token",
					qrcode_index_url: "https://www.douyin.com/scan/example",
					expire_time: now + 600,
				},
			});
			return;
		}
		if (url.pathname === "/login.douyin.com/passport/web/check_qrconnect/") {
			reply({
				data: { status: "confirmed", redirect_url: "https://www.douyin.com/sso/synthetic" },
			});
			return;
		}
		if (url.pathname === "/www.douyin.com/sso/synthetic") {
			res.setHeader("set-cookie", "sessionid=synthetic; Domain=.douyin.com; Path=/; Secure");
			reply({});
			return;
		}
		if (
			url.pathname === "/www.douyin.com/passport/account/info/v2/" &&
			req.headers.cookie?.includes("sessionid=synthetic")
		) {
			reply({
				message: "success",
				data: { is_visitor_account: false, user_id_str: "4001", nickname: "合成账号" },
			});
			return;
		}
		if (
			url.pathname.startsWith("/media.example/") &&
			req.headers.referer === "https://www.douyin.com/"
		) {
			imageReads.add(url.pathname);
			res.writeHead(200, { "content-type": "image/png" }).end(imageBytes(url.pathname));
			return;
		}
		if (
			url.pathname === "/www.iesdouyin.com/web/api/v2/user/info/" &&
			url.searchParams.get("unique_id") === creator.unique_id
		) {
			reply({ status_code: 0, user_info: creator });
			return;
		}
		if (
			url.pathname === "/www.douyin.com/aweme/v1/web/user/profile/other/" &&
			url.searchParams.get("sec_user_id") === identity.externalId
		) {
			reply({
				status_code: 0,
				user: {
					...creator,
					live_status: stage === "live" ? 1 : 0,
					room_id_str: room.id_str,
					room_data: { owner: { web_rid: "100002" } },
				},
			});
			return;
		}
		if (
			url.pathname === "/www.douyin.com/aweme/v1/web/aweme/post/" &&
			url.searchParams.get("sec_user_id") === identity.externalId
		) {
			if (stage === "baseline") baselineReads++;
			reply({
				status_code: 0,
				aweme_list: stage === "baseline" ? [oldWork] : [video, note, oldWork],
				has_more: 0,
			});
			return;
		}
		if (
			url.pathname === "/live.douyin.com/webcast/room/web/enter/" &&
			url.searchParams.get("room_id_str") === room.id_str &&
			url.searchParams.get("web_rid") === "100002"
		) {
			reply({ status_code: 0, data: { data: [{ ...room, start_time: now - 120 }] } });
			return;
		}
		invalidRequests.push(url.pathname);
		res.writeHead(404).end();
	});
	origin = `http://127.0.0.1:${await listen(upstream)}`;
	// 把合成抖音接口和图床转到回环，继续走宿主 HTTP 和图库。
	const hosts = new Set([
		"v.douyin.com",
		"login.douyin.com",
		"www.douyin.com",
		"www.iesdouyin.com",
		"live.douyin.com",
		"media.example",
	]);
	const fetchUpstream = HttpClient.prototype.fetch;
	vi.spyOn(HttpClient.prototype, "fetch").mockImplementation(function (
		this: HttpClient,
		input,
		opts,
	) {
		const u = new URL(input);
		if (!hosts.has(u.hostname)) return fetchUpstream.call(this, input, opts);
		return fetchUpstream.call(this, `${origin}/${u.hostname}${u.pathname}${u.search}`, {
			...opts,
			addressCheck: undefined,
		});
	});
	const probe = createServer();
	const port = await listen(probe);
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	host = await startServer({
		argv: [
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--data-dir",
			dir,
			"--log-level",
			"silent",
		],
		env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1", BN_CHROME_PATH: "/synthetic/chrome" },
		statsRecordingCheckMs: 100,
	});
	const form = new FormData();
	form.set("file", new File([await readFile(archive)], "douyin.zip", { type: "application/zip" }));
	const installed = await fetch(`${host.url}/api/ext/install`, { method: "POST", body: form });
	expect(installed.status, await installed.clone().text()).toBe(200);
	expect(await installed.json()).toMatchObject({ id: "douyin" });
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], shouldClearNativeTimers: true });
	await api("/api/settings", "PATCH", { core: { extensions: { douyin: { enabled: true } } } });
	await vi.waitFor(
		async () => {
			const { extensions } = await api<ExtensionsResponse>("/api/ext");
			expect(extensions.find((e) => e.id === "douyin")?.state).toBe("running");
		},
		{ timeout: 10_000 },
	);
	const connectionId = "ea000000-0000-4000-8000-000000000001";
	await api("/api/connections", "POST", {
		id: connectionId,
		name: "合成目标",
		enabled: true,
		adapterKey: "webhook",
		platform: "generic",
		settings: { url: `${origin}/hook`, headers: {} },
	});
	const targets = await api<Array<{ id: string; connectionId: string }>>("/api/targets");
	targetId = targets.find((t) => t.connectionId === connectionId)?.id ?? "";
	expect(targetId).toBeTruthy();
}, 20_000);

afterAll(async () => {
	try {
		await host?.close("test cleanup");
	} finally {
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (upstream) await new Promise<void>((resolve) => upstream?.close(() => resolve()));
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

it("官方抖音包解析博主、同步资料，再把图文、视频和开下播送到所选目标并计入历史统计", async () => {
	const authPath = "/api/sources/douyin/auth";
	expect((await api<SourceAuthResponse>(authPath, "POST")).state.status).toBe("awaiting-scan");
	await vi.waitFor(
		async () => {
			expect(await api<SourceAuthResponse>(authPath)).toMatchObject({
				state: { status: "logged-in" },
				account: { name: "合成账号" },
			});
		},
		{ timeout: 10_000 },
	);
	const { candidates } = await api<CreatorsResponse>(
		`/api/sources/douyin/creators?q=${creator.unique_id}`,
	);
	expect(candidates).toMatchObject([
		{
			externalId: identity.externalId,
			name: creator.nickname,
			followers: 451,
			bio: creator.signature,
		},
	]);
	const routes = { ...base.routing, post: [targetId], liveStart: [targetId], liveEnd: [targetId] };
	await api("/api/subscriptions", "POST", { ...base, routing: routes });
	await vi.waitFor(
		async () => {
			expect(baselineReads).toBeGreaterThan(0);
			const [sub] = await api<SubscriptionView[]>("/api/subscriptions");
			expect(sub?.cachedProfile).toMatchObject({
				name: creator.nickname,
				followers: 451,
				bio: creator.signature,
			});
			const avatar = await fetch(`${host?.url}/api/images/${sub?.cachedProfile?.avatar}`);
			expect(Buffer.from(await avatar.arrayBuffer())).toEqual(
				imageBytes("/media.example/avatar.png"),
			);
		},
		{ timeout: 10_000 },
	);
	expect(hooks).toEqual([]);

	// 推进来源注册的十分钟轮询。系统时钟、网络、文件和截图队列均按实时时序执行。
	stage = "live";
	await vi.advanceTimersByTimeAsync(600_000);
	await vi.waitFor(
		async () => {
			expect(await api<LiveListeningEntry[]>("/api/live/listening")).toMatchObject([
				{ subscriptionId: base.id, identity, isLive: true, title: room.title },
			]);
			expect(cards.some((c) => c.includes(note.desc))).toBe(true);
			expect(cards.some((c) => c.includes(video.desc))).toBe(true);
		},
		{ timeout: 10_000 },
	);
	stage = "end";
	await vi.advanceTimersByTimeAsync(600_000);
	await vi.waitFor(
		async () => {
			const { entries } = await api<HistoryResponse>("/api/history?limit=50");
			expect(entries.map((e) => e.feature).sort()).toEqual([
				"liveEnd",
				"liveStart",
				"post",
				"post",
			]);
			for (const entry of entries)
				expect(entry).toMatchObject({
					identity,
					subscriptionId: base.id,
					targetId,
					status: "delivered",
					nameSnapshot: creator.nickname,
				});
		},
		{ timeout: 10_000 },
	);
	expect(await api<LiveListeningEntry[]>("/api/live/listening")).toEqual([]);
	const delivered = hooks.filter((h) => h.payload.segments?.some((s) => s.type === "image"));
	expect(delivered).toHaveLength(4);
	for (const hook of delivered) {
		expect(hook.targetId).toBe(targetId);
		expect(hook.payload.segments).toContainEqual({
			type: "image",
			mime: "image/jpeg",
			data: JPEG_BYTES.toString("base64"),
		});
	}
	const links = delivered
		.map((h) =>
			h.payload.segments
				?.find((s) => s.type === "text")
				?.text?.split("\n")
				.at(-1),
		)
		.sort();
	expect(links).toEqual([
		"https://live.douyin.com/100002",
		"https://live.douyin.com/100002",
		"https://www.douyin.com/note/100102",
		"https://www.douyin.com/video/100103",
	]);
	for (const [label, image] of [
		[note.desc, "note"],
		[video.desc, "video"],
		[room.title, "live"],
	] as const) {
		const html = cards.find((c) => c.includes(label));
		expect(html).toContain(creator.nickname);
		expect(html).toContain(
			`data:image/png;base64,${imageBytes(`/media.example/${image}.png`).toString("base64")}`,
		);
	}
	expect([...imageReads].sort()).toEqual([
		"/media.example/avatar.png",
		"/media.example/live.png",
		"/media.example/note.png",
		"/media.example/video.png",
	]);
	expect(invalidRequests).toEqual([]);
	// 总览会缓存第一次读取，等今日两类记录覆盖落盘后再读。
	const generation = await activeGeneration(dir);
	await vi.waitFor(
		async () => {
			const recording = await readFile(
				join(generation, "stats", "recording", `${base.id}.jsonl`),
				"utf8",
			);
			expect(recording).toContain('"kind":"posts"');
			expect(recording).toContain('"kind":"live"');
		},
		{ timeout: 10_000 },
	);
	const { rows } = await api<StatsOverviewResponse>("/api/stats/overview?days=7&tz=0");
	expect(rows).toMatchObject([
		{
			subscriptionId: base.id,
			identity,
			posts: 2,
			videoPosts: 1,
			liveSessions: 1,
			live: false,
			followers: 451,
		},
	]);
}, 45_000);

it("群聊分享未订阅博主的短链，官方拓展展开后在对应群组回复图文卡", async () => {
	const groupConnection = "ea000000-0000-4000-8000-000000000002";
	const groupTarget = "ea000000-0000-4000-8000-000000000003";
	await api("/api/connections", "POST", {
		id: groupConnection,
		name: "合成群聊",
		enabled: true,
		adapterKey: "onebot",
		platform: "onebot",
		settings: { transport: "http", baseUrl: origin, maxRetries: 0, retryIntervalMs: 0 },
	});
	await api("/api/targets", "POST", {
		id: groupTarget,
		name: "合成群",
		connectionId: groupConnection,
		kind: "session",
		scope: "group",
		address: "10001",
		enabled: true,
	});
	await api("/api/settings", "PATCH", {
		core: { linkPreview: { enabled: true, isOnByDefault: true, replyForm: "image" } },
	});
	await api("/api/dev/run/core.push.capture", "POST", { params: {} });
	await api("/api/dev/run/core.inbound.link", "POST", {
		params: {
			connection: groupConnection,
			address: "10001",
			text: "看看 https://v.douyin.com/example/",
		},
	});
	await vi.waitFor(
		async () => {
			expect((await api<DevCapturesView>("/api/dev/captures")).entries).toMatchObject([
				{
					kind: "image",
					images: 1,
					connectionId: groupConnection,
					targetId: "session:group:10001",
				},
			]);
		},
		{ timeout: 7000 },
	);
	const html = cards.find((c) => c.includes(sharedPost.desc));
	expect(html).toContain(sharedPost.author.nickname);
	expect(html).toContain(
		`data:image/png;base64,${imageBytes("/media.example/note.png").toString("base64")}`,
	);
	expect(invalidRequests).toEqual([]);
}, 15_000);
