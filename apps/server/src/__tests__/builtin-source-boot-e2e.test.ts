/**
 * 🔴 **入口真的调了内置来源的登记,关停时来源真的被停。**
 *
 * 来源、登记表、宿主、`compose.ts` 各有单元测试,证明不了 `src/index.ts` 真调了
 * `builtins.registerSources(engines)`、`compose.ts` 真调了 `engines.registerSource(...)`、
 * `engines.dispose()` 真收了来源 —— 这三处剪断,类型、构建、单元测试全绿,只是动态从此不拉。
 * 所以这条起一台真服务端(真入口、真 `compose.ts`、真 `createEngines`、真登记表、真来源上下文),
 * 只把造 B 站来源的工厂换成假来源(`start` 只记下 ctx、不起 cron、不碰网络)。
 *
 * 它证明不了的只有一件事:**真的** B 站来源起来以后真的在拉、真的在推 —— 真来源一拉就是打 B 站的关注流,
 * 零外连的测试里放不了,那是真机待看。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";

const fake = vi.hoisted(() => ({
	starts: [] as unknown[],
	stops: 0,
}));

vi.mock("../bilibili/source.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../bilibili/source.js")>();
	return {
		...real,
		createBiliSource: () => ({
			descriptor: { postNoun: "动态" },
			async start(ctx: unknown) {
				fake.starts.push(ctx);
			},
			async stop() {
				fake.stops += 1;
			},
			dynamic: () => undefined,
		}),
	};
});

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

describe("内置来源的登记接在开机与关停路径上", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-builtin-source-boot-e2e-"));
		fake.starts.length = 0;
		fake.stops = 0;
	});

	afterEach(async () => {
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		await rm(dataDir, { recursive: true, force: true });
	});

	it("开机后来源的 start 恰好一次,ctx 上三个方法都在;关服务之后 stop 恰好一次", async () => {
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
		expect(fake.starts).toHaveLength(1);
		const ctx = fake.starts[0] as SourceContext;
		expect(typeof ctx.subscriptions).toBe("function");
		expect(typeof ctx.onSubscriptionsChanged).toBe("function");
		expect(typeof ctx.reportPost).toBe("function");
		expect(ctx.subscriptions()).toEqual([]);
		expect(fake.stops).toBe(0);

		await handle.close("test");
		handle = undefined;
		expect(fake.stops).toBe(1);
	});
});
