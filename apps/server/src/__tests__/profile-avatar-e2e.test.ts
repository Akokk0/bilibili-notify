/**
 * 🔴 **拓展订阅的头像在真 BN 上是接着的**(ADR-0019 决策 10 / 49;头像进图库见 ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗)。
 *
 * 路由那层的测试(`routes/__tests__/subscriptions-extension-create.test.ts`)自己递拓展名单、自己搭订阅仓
 * 那座桥,图库清扫也是自己调;这里起一台真 BN,钉住 `index.ts` 那几根线:
 *  - 新建订阅认的是**装载器真的那份名单**:一个装着、没开的 v2 订阅源(不要求在跑);头像进图库,读口取得回来。
 *  - 删订阅时 ProfileRefresh 听 `subscription-changed` 丢掉资料缓存里的这一条;头像这时**不会**被直接删,
 *    它不再有人引用,等下一轮图库清扫 —— 停机期间删掉的订阅也一样,下次开机那一轮收走
 *    (`startHistoryRetention` 把图库交给清扫、资料缓存登记成引用方,这两处接线漏了的话,头像要么永远留着、
 *    要么过了宽限期被当垃圾删掉,门禁全绿)。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubscriptionDTO } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { IMAGE_GRACE_MS, isValidImageRef } from "../images/image-store.js";
import { type ServerHandle, startServer } from "../index.js";
import { avatarDataUrl, PNG_BYTES } from "./support/avatar-fixtures.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { openTestGeneration } from "./support/generation.js";

const FIXTURE_ID = "avatar-probe";
/** 没有任何资料引用的一张图(过了宽限期的孤儿)。 */
const ORPHAN_REF = `${"f".repeat(64)}.png`;
const SUB_ID = "b0000000-0000-4000-8000-000000000001";

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

describe("头像 e2e:新建认真的拓展名单、头像进图库、删订阅后由清扫收走", () => {
	let dataDir: string;
	let gen: string;
	let imagesDir: string;
	let handle: ServerHandle | undefined;
	let port: number;

	async function imageFiles(): Promise<string[]> {
		try {
			return (await readdir(imagesDir)).sort();
		} catch {
			return [];
		}
	}

	function boot(): Promise<ServerHandle> {
		return startServer({
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
	}

	/** 装一个 v2 订阅源(开关没拨,没在跑)。 */
	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-sub-avatar-e2e-"));
		// 开机前先开好一代,摆的东西都进这一代(ADR-0022)。
		gen = await openTestGeneration(dataDir);
		imagesDir = join(gen, "images");

		const extDir = join(gen, "extensions", FIXTURE_ID);
		await mkdir(extDir, { recursive: true });
		await writeFile(
			join(extDir, "extension.json"),
			JSON.stringify({
				id: FIXTURE_ID,
				name: "头像探针",
				description: "只为了是个订阅源",
				version: "0.1.0",
				apiVersion: 2,
				contributes: {
					subscription: {
						display: { label: "探针", shortLabel: "探", color: "#3366ff" },
						events: ["post"],
					},
				},
			}),
		);
		await writeFile(join(extDir, "index.mjs"), "export function activate() {}\n");

		port = await findFreePort();
		handle = await boot();
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);

	it("新建一条(拓展没开也行)→ 头像进图库、读口取得回来", async () => {
		const created = await api("/api/subscriptions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...makeExtensionSubscription({ id: SUB_ID, extensionId: FIXTURE_ID, externalId: "x" }),
				cachedProfile: { name: "某人", avatarUrl: avatarDataUrl("png", PNG_BYTES) },
			}),
		});
		expect(created.status, await created.clone().text()).toBe(200);
		const row = ((await created.json()) as SubscriptionDTO[]).find((s) => s.id === SUB_ID);
		const ref = row?.cachedProfile?.avatar ?? "";
		expect(isValidImageRef(ref)).toBe(true);
		expect(await imageFiles()).toEqual([ref]);

		const img = await api(`/api/images/${ref}`);
		expect(img.status).toBe(200);
		expect(Buffer.from(await img.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
	});

	it("删掉 → 资料缓存里丢了这条、头像没被直接删;停机后过了宽限期,下次开机的清扫收走它与孤儿图", async () => {
		const ref = (await imageFiles())[0] ?? "";
		expect((await api(`/api/subscriptions/${SUB_ID}`, { method: "DELETE" })).status).toBe(204);

		// ProfileRefresh 听 subscription-changed 丢掉资料缓存里这一条。
		const runtimeFile = join(gen, "runtime", "sub-runtime.json");
		await vi.waitFor(async () => {
			const onDisk = JSON.parse(await readFile(runtimeFile, "utf8")) as Record<string, unknown>;
			expect(onDisk).not.toHaveProperty(SUB_ID);
		});
		// 头像文件还在:删订阅不再顺手删它,不再有人引用以后由清扫收。
		expect(await imageFiles()).toEqual([ref]);

		await handle?.close("restart");
		handle = undefined;
		// 停机期间过了宽限期:头像与一张从来没人引用的孤儿图都是一天多以前的。
		await writeFile(join(imagesDir, ORPHAN_REF), PNG_BYTES);
		const aged = new Date(Date.now() - IMAGE_GRACE_MS - 60 * 60 * 1000);
		for (const name of [ref, ORPHAN_REF]) await utimes(join(imagesDir, name), aged, aged);

		handle = await boot();
		await vi.waitFor(async () => expect(await imageFiles()).toEqual([]));
	});
});
