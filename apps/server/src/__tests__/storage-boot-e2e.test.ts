/**
 * 🔴 **一台真 BN 上存储占用的三个口接没接上**(㉙d,ADR-0027 决策 17)。
 *
 * 路由、占用表、各个仓各自的测试全绿,证明不了 `index.ts` 把它们接到了真的那几个对象上:占用表量的是不是真数据根、
 * 清「统计」有没有经真记录器、有没有让粉丝轮询的快照与总览缓存失效、清「历史」「女仆」
 * 有没有走真的仓与图库。这里起一台真 BN(自己的临时目录),盘上摆好各类数据,走 HTTP 把每一类清一遍。
 *
 * 摆的东西:一条拓展订阅(有粉丝时序)与一条停用的 B 站订阅(订阅运行态里有资料与房号),四个统计目录各一份,
 * 历史日文件(一份在今天之前、引用一张老图)与重推原件,一份女仆对话(引用一张老图)。图的修改时间都拨到宽限期之外。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	FollowersResponse,
	ImageSweepResponse,
	StatsOverviewResponse,
	StorageClearResponse,
	StorageUsageResponse,
} from "@bilibili-notify/contract";
import { makeEmptySubscription } from "@bilibili-notify/internal";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { CONFIG_DIR } from "../config/store.js";
import { FOLLOWERS_DIR } from "../followers/store.js";
import { readClearedThrough } from "../history/retention.js";
import { imageRefOf } from "../images/image-store.js";
import { type ServerHandle, startServer } from "../index.js";
import { STATS_LIVE_DIR, STATS_POSTS_DIR, STATS_RECORDING_DIR } from "../stats/store.js";
import { PNG_BYTES } from "./support/avatar-fixtures.js";
import { distinctPng } from "./support/chat-images.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { activeGeneration, openTestGeneration } from "./support/generation.js";
import { subscriptionsFileText } from "./support/subscriptions-file.js";

const EXT = makeExtensionSubscription({
	id: "e3000000-0000-4000-8000-000000000001",
	extensionId: "storage-probe",
	externalId: "ext-1",
	enabled: true,
});
const BILI = makeEmptySubscription({
	id: "b3000000-0000-4000-8000-000000000001",
	identity: { sourceKey: "bilibili", externalId: "3001" },
});
const H = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const OLD = new Date(Date.now() - 5 * 86_400_000);
/**
 * 历史日文件与重推原件的日子:三天前(UTC)。要在默认的 30 天保留期**之内** —— 开机那一轮保留清理会把期外的
 * 重推原件与老图先收走,这条测试要的是「清理由主人触发」而不是开机自己清了。
 */
const DAY = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				probe.close(() => reject(new Error("failed to allocate test port")));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}

describe("存储占用 e2e:真 BN 上用量表与四类清理", () => {
	let dataDir: string;
	let gen: string;
	let handle: ServerHandle | undefined;
	let histImage: string;
	let chatImage: string;
	const sizes = {
		posts: 0,
		live: 0,
		recording: 0,
		followers: 0,
		histImage: 0,
		chatImage: 0,
		historyDay: 0,
		snapshot: 0,
		chat: 0,
	};

	const api = (path: string, init?: RequestInit) => fetch(`${handle?.url}${path}`, init);
	const usage = async () =>
		new Map(
			((await (await api("/api/system/storage")).json()) as StorageUsageResponse).rows.map((r) => [
				r.category,
				r,
			]),
		);
	const write = async (rel: string, body: string | Buffer) => {
		const path = join(gen, rel);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, body);
		return Buffer.byteLength(body);
	};
	const exists = (rel: string) =>
		stat(join(gen, rel)).then(
			() => true,
			() => false,
		);

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-storage-boot-e2e-"));
		gen = await openTestGeneration(dataDir);
		await write(
			join(...CONFIG_DIR, "subscriptions.json"),
			subscriptionsFileText([EXT, { ...BILI, enabled: false }]),
		);
		// 订阅运行态只留资料;B 站房号住它自己的状态。
		await write(
			join("runtime", "subscription-state.json"),
			JSON.stringify({
				[BILI.id]: {
					cachedProfile: { name: "甲", followers: 100, refreshedAt: iso(H) },
				},
				[EXT.id]: {
					cachedProfile: { name: "乙", followers: 80, refreshedAt: iso(H) },
				},
			}),
		);
		await write(
			join("runtime", "bilibili", "state.json"),
			JSON.stringify({ version: 1, entries: { [`room:${BILI.identity.externalId}`]: "42" } }),
		);
		// 数据统计:四个目录各一份(拓展订阅的粉丝时序是真的两条样本,没有压缩可压)。
		sizes.posts = await write(
			join(...STATS_POSTS_DIR, `${EXT.id}.jsonl`),
			line({ id: "p1", hasVideo: false, publishedAt: iso(2 * H) }),
		);
		sizes.live = await write(
			join(...STATS_LIVE_DIR, `${EXT.id}.jsonl`),
			line({ kind: "start", occurredAt: iso(5 * H) }) +
				line({ kind: "end", occurredAt: iso(4 * H) }),
		);
		sizes.recording = await write(
			join(...STATS_RECORDING_DIR, `${EXT.id}.jsonl`),
			line({ kind: "posts", startedAt: iso(30 * H), endedAt: iso(29 * H) }),
		);
		sizes.followers = await write(
			join(...FOLLOWERS_DIR, `${EXT.id}.jsonl`),
			line({ sampledAt: iso(20 * H), followers: 50 }) +
				line({ sampledAt: iso(1 * H), followers: 80 }),
		);
		// 图:一张只被一条旧历史行引用,一张只被女仆对话引用;修改时间都拨到宽限期之外。
		histImage = imageRefOf(distinctPng(1)) as string;
		chatImage = imageRefOf(distinctPng(2)) as string;
		for (const [ref, n] of [
			[histImage, 1],
			[chatImage, 2],
		] as const) {
			await write(join("images", ref), distinctPng(n));
			await utimes(join(gen, "images", ref), OLD, OLD);
		}
		sizes.histImage = distinctPng(1).byteLength;
		sizes.chatImage = distinctPng(2).byteLength;
		sizes.historyDay = await write(
			join("history", `${DAY}.jsonl`),
			line({ messages: [{ payload: { image: histImage } }] }),
		);
		sizes.snapshot = await write(
			join("history", "repush", DAY, "row.json"),
			JSON.stringify({ messages: [{ payload: { text: "x" } }] }),
		);
		sizes.chat = await write(
			join("ai", "conversations", "c1.json"),
			JSON.stringify({ messages: [{ images: [chatImage] }] }),
		);

		const port = await findFreePort();
		handle = await startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});
		expect(await activeGeneration(dataDir)).toBe(gen);
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	it("用量表量的是真数据根:七行、手写的字节对得上", async () => {
		const rows = await usage();
		expect([...rows.keys()]).toEqual([
			"stats",
			"historyText",
			"historyImages",
			"ai",
			"generations",
			"otherImages",
			"logs",
		]);
		expect(rows.get("stats")?.sizeBytes).toBe(
			sizes.posts + sizes.live + sizes.recording + sizes.followers,
		);
		expect(rows.get("historyText")?.sizeBytes).toBe(sizes.historyDay);
		// 历史图 = 历史行引用的那张图 + 重推原件;AI = 对话 + 对话引用的图。
		expect(rows.get("historyImages")?.sizeBytes).toBe(sizes.histImage + sizes.snapshot);
		expect(rows.get("ai")?.sizeBytes).toBe(sizes.chat + sizes.chatImage);
		expect(rows.get("otherImages")?.sizeBytes).toBe(0);
		expect(rows.get("generations")).toMatchObject({ clearable: false, deletableGenerations: 0 });
	});

	it("接线前提:清之前粉丝面板有拓展那一行,订阅运行态里有别的格", async () => {
		const fans = (await (await api("/api/stats/followers")).json()) as FollowersResponse;
		const entry = fans.entries.find((e) => e.subscriptionId === EXT.id);
		expect(entry?.deltaSubscribed).toBe(30); // 资料里 80 − 时序第一条 50
		const runtime = JSON.parse(
			await readFile(join(gen, "runtime", "subscription-state.json"), "utf8"),
		);
		expect(runtime[BILI.id]).toMatchObject({
			cachedProfile: { name: "甲", followers: 100 },
		});
		expect(Object.keys(runtime[BILI.id])).toEqual(["cachedProfile"]);
		const biliState = JSON.parse(
			await readFile(join(gen, "runtime", "bilibili", "state.json"), "utf8"),
		);
		expect(biliState.entries[`room:${BILI.identity.externalId}`]).toBe("42");
		// 先摸一次总览,让它进 30 秒缓存:清完要看它被作废。
		const overview = (await (
			await api("/api/stats/overview?days=30")
		).json()) as StatsOverviewResponse;
		expect(overview.rows.find((r) => r.subscriptionId === EXT.id)?.posts).toBe(1);
	});

	it("DELETE stats:四个目录清空、订阅运行态不动、粉丝面板与总览缓存都不再是旧数", async () => {
		const before = (await usage()).get("stats")?.sizeBytes;
		const res = await api("/api/system/storage/stats", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(((await res.json()) as StorageClearResponse).freedBytes).toBe(before);

		for (const dir of [STATS_POSTS_DIR, STATS_LIVE_DIR, STATS_RECORDING_DIR, FOLLOWERS_DIR]) {
			expect(await readdir(join(gen, ...dir))).toEqual([]);
		}
		const runtime = JSON.parse(
			await readFile(join(gen, "runtime", "subscription-state.json"), "utf8"),
		);
		expect(runtime[BILI.id]).not.toHaveProperty("roomId");
		expect(runtime[BILI.id].cachedProfile.followers).toBe(100);
		const biliState = JSON.parse(
			await readFile(join(gen, "runtime", "bilibili", "state.json"), "utf8"),
		);
		expect(biliState.entries[`room:${BILI.identity.externalId}`]).toBe("42");
		// 粉丝轮询手里的快照:时序没了,拓展那一行跟着没了(不再是旧的「+30」)。
		const fans = (await (await api("/api/stats/followers")).json()) as FollowersResponse;
		expect(fans.entries.find((e) => e.subscriptionId === EXT.id)).toBeUndefined();
		// 总览缓存被作废:同一个查询不再带着清掉的作品 / 粉丝。
		const overview = (await (
			await api("/api/stats/overview?days=30")
		).json()) as StatsOverviewResponse;
		expect(overview.rows.find((r) => r.subscriptionId === EXT.id)?.posts ?? 0).toBe(0);
	});

	it("DELETE historyText:日文件与重推原件一起删,只被它引用的老图被清扫收走", async () => {
		const res = await api("/api/system/storage/historyText", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(((await res.json()) as StorageClearResponse).freedBytes).toBe(
			sizes.historyDay + sizes.snapshot + sizes.histImage,
		);
		expect(await exists(`history/${DAY}.jsonl`)).toBe(false);
		expect(await exists(`history/repush/${DAY}/row.json`)).toBe(false);
		expect(await exists(`images/${histImage}`)).toBe(false);
		expect(await exists(`images/${chatImage}`)).toBe(true);
	});

	it("DELETE historyImages:水位线推到昨天(原件已随文字删了,这一趟腾出 0)", async () => {
		const res = await api("/api/system/storage/historyImages", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(((await res.json()) as StorageClearResponse).freedBytes).toBe(0);
		const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		// 水位线按 UTC 日:跑测试的那一刻刚好跨零点时与这里的「昨天」差一天,允许前后一天。
		const mark = await readClearedThrough(gen);
		expect([yesterday, new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)]).toContain(
			mark,
		);
	});

	it("DELETE ai:对话删了,只被它引用的图被清扫收走", async () => {
		const res = await api("/api/system/storage/ai", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(((await res.json()) as StorageClearResponse).freedBytes).toBe(
			sizes.chat + sizes.chatImage,
		);
		expect(await readdir(join(gen, "ai", "conversations"))).toEqual([]);
		expect(await exists(`images/${chatImage}`)).toBe(false);
		// 图库里一张都不剩了(PNG_BYTES 只是确认夹具用的字节没被误当成图库内容)。
		expect(await readdir(join(gen, "images"))).toEqual([]);
		expect(PNG_BYTES.byteLength).toBeGreaterThan(0);
	});

	it("别的类别、未知类别都是 400;手动清扫回结果", async () => {
		for (const category of ["generations", "logs", "otherImages", "nope"]) {
			const res = await api(`/api/system/storage/${category}`, { method: "DELETE" });
			expect(res.status, category).toBe(400);
		}
		const sweep = await api("/api/system/storage/images/sweep", { method: "POST" });
		expect(sweep.status).toBe(200);
		expect((await sweep.json()) as ImageSweepResponse).toEqual({
			removedCount: 0,
			removedBytes: 0,
			referenced: 0,
			inGrace: 0,
		});
	});

	it("全清之后:四个可清的类别都是 0,再清一遍回 0(幂等)", async () => {
		const rows = await usage();
		for (const category of ["stats", "historyText", "historyImages", "ai"] as const) {
			expect(rows.get(category)?.sizeBytes, category).toBe(0);
			const res = await api(`/api/system/storage/${category}`, { method: "DELETE" });
			expect(await res.json()).toEqual({ freedBytes: 0 });
		}
	});
});
