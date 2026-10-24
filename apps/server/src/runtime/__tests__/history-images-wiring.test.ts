/**
 * **真装配里,推送历史和重推原件各登记成了图库的一家引用方**(接线守卫,同 `chat-images-wiring.test.ts`)。
 *
 * 历史的 `listHistoryImageRefs`、重推原件的 `listRepushImageRefs` 与图库的清扫各有各的测试,可证明不了 `bootstrap.ts` 里
 * 那两行 `register(…)` 真的写上了:漏掉的症状是一切照常,只有一天以后清扫把还在历史行 / 重推原件里的图当垃圾删了,而门禁
 * 全绿。所以这里走真的 `createAppRuntime`,**把两家分开钉**(只剩一家引用时图要留,两家都没了才收走):
 *
 * - 历史行(保留期内)引用着的图,清扫不收;水位线推过那一天,历史这一家就不再引用它;
 * - 同一张图还被重推原件引用着(原件的日目录还在),图仍留 —— 证明「重推原件」那家真登记上了,不是靠历史那家;
 * - 原件的日目录也没了,才收走;
 * - 资料缓存里的头像(拓展订阅)和历史行的头像快照指着同一张图:订阅删了、资料没了,历史行还引用着,图仍留。
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { distinctPng, putImage } from "../../__tests__/support/chat-images.js";
import { settingsSegment } from "../../bilibili/settings.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { IMAGE_GRACE_MS } from "../../images/image-store.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";
import { dataPath } from "../roots.js";

const SUB = "e0000000-0000-4000-8000-000000000001";

let dataDir: string;
let runtime: AppRuntime;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-history-images-wiring-"));
	runtime = createAppRuntime(
		BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }),
		{
			dataRoot: dataDir,
		},
		{ integrationSettings: [settingsSegment] },
	);
	await runtime.subscriptionStateStore.load();
});
afterEach(async () => {
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

/** 宽限期过了:清扫按「一天多以后」的时钟算。 */
const afterGrace = () => new Date(Date.now() + IMAGE_GRACE_MS + 60 * 60 * 1000);
const imagesOnDisk = () => readdir(dataPath(dataDir, "images"));

/** 记一行带一张图的历史(有目标,所以留重推原件),回行与图的引用。 */
async function recordImageRow(bytes: Buffer, extra: { avatarSnapshot?: string } = {}) {
	const entry = await runtime.historyStore.record({
		pushId: crypto.randomUUID(),
		feature: "post",
		identity: { sourceKey: "bilibili", externalId: "u1" },
		subscriptionId: SUB,
		targetId: crypto.randomUUID(),
		messages: [
			{
				payload: { kind: "image", image: { buffer: bytes, mime: "image/png" } },
				role: "main",
				result: { ok: true, latencyMs: 1 },
			},
		],
		...extra,
	});
	const ref = entry.messages[0]?.payload.image;
	if (!ref) throw new Error("夹具:图没存进图库");
	return { entry, ref, day: entry.createdAt.slice(0, 10) };
}

/** 把水位线推到 `day`(含):这一天及以前的行不再算引用方。 */
async function pushWatermark(day: string): Promise<void> {
	await mkdir(dataPath(dataDir, "history"), { recursive: true });
	await writeFile(
		dataPath(dataDir, "history", "retention.json"),
		JSON.stringify({ clearedThrough: day }),
	);
}

describe("createAppRuntime 里的推送历史与重推原件", () => {
	it("历史行(保留期内)引用着的图,过了宽限期清扫也不删", async () => {
		const { ref } = await recordImageRow(distinctPng(1));

		const swept = await runtime.imageStore.sweep({ now: afterGrace() });

		expect(swept).toMatchObject({ removed: [], referenced: 1 });
		expect(await imagesOnDisk()).toEqual([ref]);
	});

	it("两家分开钉:水位线推过那一天,历史不再引用;重推原件还在就仍留住,原件的日目录没了才收走", async () => {
		const { ref, day } = await recordImageRow(distinctPng(2));
		await pushWatermark(day);

		// 历史那家这一天的行已经不算引用方,留住这张图的只可能是「重推原件」。
		const keptByRepush = await runtime.imageStore.sweep({ now: afterGrace() });
		expect(keptByRepush).toMatchObject({ removed: [], referenced: 1 });
		expect(await imagesOnDisk()).toEqual([ref]);

		await rm(dataPath(dataDir, "history", "repush", day), { recursive: true });
		const swept = await runtime.imageStore.sweep({ now: afterGrace() });
		expect(swept.removed).toEqual([ref]);
		expect(await imagesOnDisk()).toEqual([]);
	});

	it("反过来:原件的日目录没了,历史行还在保留期内 —— 图仍留(历史那家登记上了)", async () => {
		const { ref, day } = await recordImageRow(distinctPng(3));
		await rm(dataPath(dataDir, "history", "repush", day), { recursive: true });

		const swept = await runtime.imageStore.sweep({ now: afterGrace() });

		expect(swept).toMatchObject({ removed: [], referenced: 1 });
		expect(await imagesOnDisk()).toEqual([ref]);
	});

	it("拓展行的头像快照:订阅删了、资料缓存没了,历史行还引用着就留;水位线推过去才收走", async () => {
		const avatar = await putImage(runtime.profileImages, PNG_BYTES);
		await runtime.subscriptionStateStore.patch(SUB, {
			cachedProfile: {
				name: "拓展甲",
				avatar,
				sign: "",
				lastRefreshedAt: "2026-10-04T00:00:00.000Z",
			},
		});
		const { day } = await recordImageRow(distinctPng(4), { avatarSnapshot: avatar });
		await runtime.subscriptionStateStore.prune([]);

		const kept = await runtime.imageStore.sweep({ now: afterGrace() });
		expect(kept.removed).not.toContain(avatar);
		expect(await imagesOnDisk()).toContain(avatar);

		await pushWatermark(day);
		await rm(dataPath(dataDir, "history", "repush", day), { recursive: true });
		const swept = await runtime.imageStore.sweep({ now: afterGrace() });
		expect(swept.removed).toContain(avatar);
		expect(await imagesOnDisk()).not.toContain(avatar);
	});

	it("历史行过了保留期,但资料缓存还引用着同一张头像:不收", async () => {
		const avatar = await putImage(runtime.profileImages, PNG_BYTES);
		await runtime.subscriptionStateStore.patch(SUB, {
			cachedProfile: {
				name: "拓展甲",
				avatar,
				sign: "",
				lastRefreshedAt: "2026-10-04T00:00:00.000Z",
			},
		});
		const { day } = await recordImageRow(distinctPng(5), { avatarSnapshot: avatar });
		await pushWatermark(day);
		await rm(dataPath(dataDir, "history", "repush", day), { recursive: true });

		const swept = await runtime.imageStore.sweep({ now: afterGrace() });

		expect(swept.removed).not.toContain(avatar);
		expect(await imagesOnDisk()).toContain(avatar);
	});

	it("运行时上的 historyImages 与历史仓存图是同一座图库:同样的字节经两条路进去,是同一个文件、同一个引用", async () => {
		const viaRuntime = await putImage(runtime.historyImages, PNG_BYTES);
		const { ref: viaStore } = await recordImageRow(PNG_BYTES);
		expect(viaStore).toBe(viaRuntime);
		expect(await imagesOnDisk()).toEqual([viaRuntime]);
	});
});
