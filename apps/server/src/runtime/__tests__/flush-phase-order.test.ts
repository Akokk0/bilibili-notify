/**
 * **真装配里,每个写道都登记进了 flush 段,而且先后是对的**(守卫 8 的接线那一半)。
 *
 * 各个 store 自己的 `close()` 有各自的测试,可证明不了 `bootstrap.ts` 里那几行 `onDispose(…, "flush")`
 * 真的写上了 —— 漏一行的症状是:一切照常,只有关停返回之后那个 store 还在写盘,门禁全绿。所以这里走真的
 * `createAppRuntime`:关停之后每个 store 的写都得被拒。
 *
 * 先后也钉在这里:资料更新落盘(reported-profiles)往资料缓存仓与头像仓写,同段后登记的先跑,所以它得排在那
 * 两家 `close()` 的登记之后 —— 反过来的话,关停时在途的那条资料写会撞上已经关门的仓、白白丢掉。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";
import { SUB_RUNTIME_FILE } from "../sub-runtime-store.js";

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
	runtime = createAppRuntime(BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }), {
		dataRoot: dataDir,
	});
	await runtime.configStore.load();
	await runtime.subRuntimeStore.load();
	await runtime.configStore.upsertSubscription(SUB);
});
afterEach(async () => {
	storageWriteGate.reset();
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

describe("createAppRuntime 的 flush 段", () => {
	it("关停之后,配置 / 历史 / 资料缓存 / 头像 / 会话这几个写道都已关门", async () => {
		await runtime.dispose();

		await expect(
			runtime.configStore.patchGlobals({ app: { fansCron: "*/9 * * * *" } }),
		).rejects.toMatchObject(CLOSED);
		// 各集成的设置(B 站的 `bilibili.json`)与核心设置同一个写道:关门时一并关。
		await expect(
			runtime.configStore.patchSettings({ integrations: { bilibili: { userAgent: "UA/x" } } }),
		).rejects.toMatchObject(CLOSED);
		await expect(
			runtime.historyStore.record({
				pushId: "p1",
				kind: "dynamic",
				uid: "u1",
				subscriptionId: SUB.id,
				target: null,
				messages: [],
			}),
		).rejects.toMatchObject(CLOSED);
		await expect(runtime.subRuntimeStore.prune([])).rejects.toMatchObject(CLOSED);
		await expect(runtime.subAvatarStore.writeBytes(SUB.id, PNG_BYTES)).rejects.toMatchObject(
			CLOSED,
		);
		await expect(runtime.conversationStore.create()).rejects.toMatchObject(CLOSED);
	});

	it("在途的资料更新先走空,头像仓与资料缓存仓才关门:关停返回时那条资料已在盘上", async () => {
		// 带头像:先写头像文件(停在闸门口),之后才轮到写资料缓存 —— 这第二笔是关停开始**以后**才发出的,
		// 资料缓存仓要是已经先关了门,它就被拒、这条资料丢掉。光是「在途的写等得到」测不出先后。
		storageWriteGate.hold();
		runtime.bus.emit("subscription-reported", {
			extensionId: SUB.identity.sourceKey,
			externalId: SUB.identity.externalId,
			subscriptionIds: [SUB.id],
			report: { kind: "profile", value: { name: "甲", avatar: PNG_BYTES } },
		});
		await storageWriteGate.arrived();

		let closed = false;
		const closing = runtime.dispose().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(closed).toBe(false);

		storageWriteGate.release();
		await closing;
		const onDisk = JSON.parse(await readFile(join(dataDir, ...SUB_RUNTIME_FILE), "utf8")) as Record<
			string,
			{ cachedProfile?: { name: string } }
		>;
		expect(onDisk[SUB.id]?.cachedProfile).toMatchObject({
			name: "甲",
			avatar: expect.stringContaining(`/api/subs/${SUB.id}/avatar?v=`),
		});
	});
});
