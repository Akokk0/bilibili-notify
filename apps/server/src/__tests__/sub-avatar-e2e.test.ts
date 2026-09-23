/**
 * 🔴 **拓展订阅的头像在真 BN 上是接着的**(ADR-0019 决策 10 / 49)。
 *
 * 路由那层的测试(`routes/__tests__/subs-extension-create.test.ts`)自己递拓展名单、自己搭订阅仓
 * 那座桥;这里起一台真 BN,钉住 `index.ts` 那几根线:
 *  - 开机清扫:停机期间删掉的订阅,头像文件在开机时扫掉(`sweep` 那一行漏接的话,孤儿永远留着)。
 *  - 新建订阅认的是**装载器真的那份名单**:一个装着、没开的 v2 订阅源(不要求在跑)。
 *  - 删订阅时头像跟着删。
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubscriptionDTO } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { avatarDataUrl, PNG_BYTES } from "./support/avatar-fixtures.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

const FIXTURE_ID = "avatar-probe";
const ORPHAN_ID = "b0000000-0000-4000-8000-00000000000f";
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

describe("头像 e2e:开机清扫、新建认真的拓展名单、删订阅带走头像", () => {
	let dataDir: string;
	let avatarsDir: string;
	let handle: StandaloneServerHandle | undefined;
	let port: number;

	async function avatarFiles(): Promise<string[]> {
		return (await readdir(avatarsDir)).sort();
	}

	/**
	 * 装一个 v2 订阅源(开关没拨,没在跑);头像目录里预先摆一个没有订阅认领的孤儿、一个崩溃留下的
	 * 半截临时文件。
	 */
	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-sub-avatar-e2e-"));
		avatarsDir = join(dataDir, "avatars");

		const extDir = join(dataDir, "extensions", FIXTURE_ID);
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

		await mkdir(avatarsDir, { recursive: true });
		await writeFile(join(avatarsDir, `${ORPHAN_ID}.png`), PNG_BYTES);
		await writeFile(join(avatarsDir, `${ORPHAN_ID}.png.tmp.1.abc`), PNG_BYTES);

		port = await findFreePort();
		handle = await startStandaloneServer({
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
			shutdownTimeoutMs: 1_000,
		});
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);

	it("开机时扫掉了没有订阅认领的头像与半截临时文件", async () => {
		expect(await avatarFiles()).toEqual([]);
	});

	it("新建一条(拓展没开也行)→ 头像落盘、取得回来;删掉 → 头像跟着删", async () => {
		const created = await api("/api/subs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...makeExtensionSubscription({ id: SUB_ID, extensionId: FIXTURE_ID, externalId: "x" }),
				cachedProfile: { name: "某人", avatar: avatarDataUrl("png", PNG_BYTES) },
			}),
		});
		expect(created.status, await created.clone().text()).toBe(200);
		const row = ((await created.json()) as SubscriptionDTO[]).find((s) => s.id === SUB_ID);
		const url = row?.cachedProfile?.avatar ?? "";
		expect(url).toMatch(new RegExp(`^/api/subs/${SUB_ID}/avatar\\?v=`));
		expect(await avatarFiles()).toEqual([`${SUB_ID}.png`]);

		const img = await api(url);
		expect(img.status).toBe(200);
		expect(Buffer.from(await img.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

		expect((await api(`/api/subs/${SUB_ID}`, { method: "DELETE" })).status).toBe(204);
		await vi.waitFor(async () => {
			expect(await avatarFiles()).toEqual([]);
		});
	});
});
