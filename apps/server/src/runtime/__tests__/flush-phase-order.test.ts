/**
 * **真装配里,每个写道都登记进了 flush 段,而且先后是对的**(守卫 8 的接线那一半)。
 *
 * 各个 store 自己的 `close()` 有各自的测试,可证明不了 `bootstrap.ts` 里那几行 `onDispose(…, "flush")`
 * 真的写上了 —— 漏一行的症状是:一切照常,只有关停返回之后那个 store 还在写盘,门禁全绿。所以这里走真的
 * `createAppRuntime`:关停之后每个 store 的写都得被拒。
 *
 * 先后也钉在这里,两处:
 *
 * - 资料更新落盘(reported-profiles)往资料缓存仓与图库写,同段后登记的先跑,所以它得排在那两家 `close()` 的登记之后 ——
 *   反过来的话,关停时在途的那条资料写会撞上已经关门的仓、白白丢掉。
 * - 历史仓(落行时往图库存配图、留重推原件时又存一遍)往图库写,所以图库的 `close()` 得先登记、排在历史仓 `close()` 之前
 *   登记 —— 同段后登记的先跑,历史仓先把在途的行连同它的重推原件落完,图库才关门。
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import { settingsSegment } from "../../bilibili/settings.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { isValidImageRef } from "../../images/image-store.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";
import { dataPath } from "../roots.js";
import { SUBSCRIPTION_STATE_FILE } from "../subscription-state-store.js";

// 落盘函数前的闸默认敞开;只有「先后」那条用例才 hold(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

const SUB = makeExtensionSubscription({ id: "f0000000-0000-4000-8000-000000000001" });
const CLOSED = { code: "queue_closed" };

let dataDir: string;
let runtime: AppRuntime;

beforeEach(async () => {
	storageWriteGate.reset();
	dataDir = await mkdtemp(join(tmpdir(), "bn-flush-order-"));
	runtime = createAppRuntime(
		BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }),
		{
			dataRoot: dataDir,
		},
		{ integrationSettings: [settingsSegment] },
	);
	await runtime.configStore.load();
	await runtime.subscriptionStateStore.load();
	await runtime.configStore.upsertSubscription(SUB);
});
afterEach(async () => {
	storageWriteGate.reset();
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

describe("createAppRuntime 的 flush 段", () => {
	it("关停之后,配置 / 历史 / 资料缓存 / 会话 / 图库这几个写道都已关门(头像存的是图库)", async () => {
		await runtime.dispose();

		await expect(
			runtime.configStore.patchGlobals({ profileRefreshCron: "*/9 * * * *" }),
		).rejects.toMatchObject(CLOSED);
		// 各集成的设置(B 站的 `bilibili.json`)与核心设置同一个写道:关门时一并关。
		await expect(
			runtime.configStore.patchSettings({ integrations: { bilibili: { healthCheckMinutes: 45 } } }),
		).rejects.toMatchObject(CLOSED);
		await expect(
			runtime.historyStore.record({
				pushId: "p1",
				feature: "post",
				identity: { sourceKey: "bilibili", externalId: "u1" },
				subscriptionId: SUB.id,
				targetId: null,
				messages: [],
			}),
		).rejects.toMatchObject(CLOSED);
		await expect(runtime.subscriptionStateStore.prune([])).rejects.toMatchObject(CLOSED);
		await expect(runtime.profileImages.put(PNG_BYTES)).rejects.toMatchObject(CLOSED);
		await expect(runtime.historyImages.put(PNG_BYTES)).rejects.toMatchObject(CLOSED);
		await expect(runtime.conversationStore.create()).rejects.toMatchObject(CLOSED);
		await expect(
			runtime.imageStore.register({ name: "测试", listRefs: async () => [] }).put(PNG_BYTES),
		).rejects.toMatchObject(CLOSED);
		await expect(
			runtime.uptimeStore.append({ hourStartedAt: "2026-10-06T08:00:00.000Z", minutes: 1 }),
		).rejects.toMatchObject(CLOSED);
		// 粉丝样本仓(㉘c):追加、压缩、删除同一条按订阅的队,关停时一并关门。
		await expect(
			runtime.fansStore.append(SUB.id, { sampledAt: "2026-10-06T08:00:00.000Z", followers: 1 }),
		).rejects.toMatchObject(CLOSED);
		await expect(runtime.fansStore.compact(SUB.id, new Date())).rejects.toMatchObject(CLOSED);
	});

	it("运行记录:关停先补记当前这一小时,再关门;之后记录器也不再写", async () => {
		// 只拨 Date:假时钟让「开机到关停」隔了 30 分钟,真时钟下不到一分钟、补记的那一行会是 0 分钟而不写。
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2026-10-06T08:20:00.000Z"));
			runtime.uptimeRecorder.start();
			vi.setSystemTime(new Date("2026-10-06T08:50:00.000Z"));
			await runtime.dispose();
		} finally {
			vi.useRealTimers();
		}

		expect(await readFile(dataPath(dataDir, "uptime", "hours.jsonl"), "utf8")).toBe(
			`${JSON.stringify({ hourStartedAt: "2026-10-06T08:00:00.000Z", minutes: 30 })}\n`,
		);
		await expect(
			runtime.uptimeStore.append({ hourStartedAt: "2026-10-06T09:00:00.000Z", minutes: 1 }),
		).rejects.toMatchObject(CLOSED);
	});

	it("记录器先收尾、粉丝仓后关门:记录器排着的拓展粉丝写落得进还开着的仓", async () => {
		// 记录器代拓展写粉丝样本(经它自己的按键队),这些写可能在关停开始以后才轮到;粉丝仓要是先关了门,
		// 那一笔被拒、样本丢掉,只在记录器日志里留一句 —— 所以 `fansStore.close()` 的登记得排在记录器收尾之前。
		// 时序靠闸门卡不出确定的结果(哪一笔先到仓取决于关停各段的快慢),这里直接记两件事发生的先后。
		const order: string[] = [];
		const recorder = runtime.statsRecorder as unknown as {
			closeOpenSessions(): Promise<void>;
		};
		const closeOpenSessions = recorder.closeOpenSessions.bind(recorder);
		recorder.closeOpenSessions = async () => {
			await closeOpenSessions();
			order.push("recorder-drained");
		};
		const closeFans = runtime.fansStore.close.bind(runtime.fansStore);
		runtime.fansStore.close = () => {
			order.push("fans-closed");
			return closeFans();
		};
		await runtime.dispose();
		expect(order).toEqual(["recorder-drained", "fans-closed"]);
	});

	it("在途的资料更新先走空,图库与资料缓存仓才关门:关停返回时那条资料与它的头像已在盘上", async () => {
		// 来源上下文先存头像、再交引用;这里让资料缓存那笔写停在闸门口,关停等它落盘后才关仓。
		const stored = await runtime.profileImages.put(PNG_BYTES);
		if (!stored.ok) throw new Error(stored.message);
		storageWriteGate.hold();
		runtime.profileReports.report([SUB.id], { name: "甲", avatar: stored.ref });
		await storageWriteGate.arrived();

		let closed = false;
		const closing = runtime.dispose().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(closed).toBe(false);

		storageWriteGate.release();
		await closing;
		const onDisk = JSON.parse(
			await readFile(join(dataDir, ...SUBSCRIPTION_STATE_FILE), "utf8"),
		) as Record<string, { cachedProfile?: { name: string; avatar?: string } }>;
		const profile = onDisk[SUB.id]?.cachedProfile;
		expect(profile?.name).toBe("甲");
		expect(profile?.avatar && isValidImageRef(profile.avatar)).toBe(true);
		expect(await readdir(dataPath(dataDir, "images"))).toEqual([profile?.avatar]);
	});

	it("在途的历史行先走空,图库才关门:关停返回时那一行、它的配图和重推原件都已在盘上", async () => {
		// 带图的行:历史仓先把配图存进图库(停在闸门口),之后才写日文件、再为重推原件把同一张图存一遍 —— 这后面两笔都是
		// 关停开始**以后**才发出的。图库要是先关了门,原件那次存图被拒、原件丢了(只记一句 warn,行照写,所以光看行测不出来)。
		const pushId = crypto.randomUUID();
		const targetId = crypto.randomUUID();
		storageWriteGate.hold();
		const recording = runtime.historyStore.record({
			pushId,
			feature: "post",
			identity: { sourceKey: "bilibili", externalId: "u1" },
			subscriptionId: SUB.id,
			targetId,
			messages: [
				{
					payload: { kind: "image", image: { buffer: PNG_BYTES, mime: "image/png" } },
					role: "main",
					result: fail("unavailable", "boom"),
				},
			],
		});
		await storageWriteGate.arrived();

		let closed = false;
		const closing = runtime.dispose().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(closed).toBe(false);

		storageWriteGate.release();
		const entry = await recording;
		await closing;

		const ref = entry.messages[0]?.payload.image;
		expect(ref && isValidImageRef(ref)).toBe(true);
		expect(await readdir(dataPath(dataDir, "images"))).toEqual([ref]);
		const day = entry.createdAt.slice(0, 10);
		expect(await readFile(dataPath(dataDir, "history", `${day}.jsonl`), "utf8")).toContain(
			entry.id,
		);
		expect(await readdir(dataPath(dataDir, "history", "repush", day))).toEqual([
			`${entry.id}.json`,
		]);
	});
});
