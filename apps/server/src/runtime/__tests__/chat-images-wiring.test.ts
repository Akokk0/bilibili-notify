/**
 * **真装配里,女仆对话登记成了图库的一家引用方**(接线守卫)。
 *
 * 会话库的 `listImageRefs` 与图库的清扫各有各的测试,可证明不了 `bootstrap.ts` 里那一行 `register(…)` 真的写上了:
 * 漏掉的症状是一切照常,只有一天以后清扫把还在对话里的图当垃圾删了,而门禁全绿。所以这里走真的
 * `createAppRuntime`:图被会话引用着,过了宽限期清扫不删;会话一删,下一轮清扫才收走。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { settingsSegment } from "../../bilibili/settings.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { IMAGE_GRACE_MS } from "../../images/image-store.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";
import { dataPath } from "../roots.js";

let dataDir: string;
let runtime: AppRuntime;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-chat-images-wiring-"));
	runtime = createAppRuntime(
		BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }),
		{
			dataRoot: dataDir,
		},
		{ integrationSettings: [settingsSegment] },
	);
});
afterEach(async () => {
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

/** 宽限期过了:清扫按「一天多以后」的时钟算。 */
const afterGrace = () => new Date(Date.now() + IMAGE_GRACE_MS + 60 * 60 * 1000);
const imagesOnDisk = () => readdir(dataPath(dataDir, "images"));

describe("createAppRuntime 里的女仆对话图", () => {
	it("会话引用着的图,过了宽限期清扫也不删;会话删了,下一轮才收走", async () => {
		const stored = await runtime.chatImages.put(PNG_BYTES);
		if (!stored.ok) throw new Error(stored.message);
		const conv = await runtime.conversationStore.create();
		await runtime.conversationStore.appendMessages(conv.id, [
			{ role: "user", content: "看图", images: [stored.ref] },
		]);

		const kept = await runtime.imageStore.sweep({ now: afterGrace() });
		expect(kept).toMatchObject({ removed: [], referenced: 1 });
		expect(await imagesOnDisk()).toEqual([stored.ref]);

		await runtime.conversationStore.remove(conv.id);
		const swept = await runtime.imageStore.sweep({ now: afterGrace() });
		expect(swept.removed).toEqual([stored.ref]);
		expect(await imagesOnDisk()).toEqual([]);
	});
});
