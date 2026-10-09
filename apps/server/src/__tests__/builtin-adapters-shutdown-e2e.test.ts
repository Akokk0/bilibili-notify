/**
 * 🔴 **内置适配器的停下真的接在关停路径上**(`index.ts` 里 `serviceCtx.onDispose(() => builtinAdapters.dispose(), "stop")`)。
 *
 * 登记表与 `registerBuiltinAdapters` 各有单元测试,证明的是「叫它 dispose 它会停」;而关服务时有没有人叫它,
 * 类型、构建、单元测试全绿都证明不了。
 *
 * ⚠️ 不能拿「监听口放没放」当观察点:OneBot / QQ 官方各自还挂着一条 `serviceCtx.onDispose` 兜底,
 * 关服务时自己也会收干净 —— 钩子剪断了端口照样放(这个观察点试过,剪断不红)。能区分的是**登记表有没有叫它的
 * `stop()`**:包一层 `createOnebotAdapter`,数登记表调了几次 `stop`(兜底走的是适配器内部的收尾函数,不经这个包装)。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";

const stops = vi.hoisted(() => ({ count: 0 }));

vi.mock("../platforms/onebot.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../platforms/onebot.js")>();
	return {
		...real,
		createOnebotAdapter: (...args: Parameters<typeof real.createOnebotAdapter>) => {
			const adapter = real.createOnebotAdapter(...args);
			const stop = adapter.stop.bind(adapter);
			return {
				...adapter,
				stop: () => {
					stops.count += 1;
					return stop();
				},
			};
		},
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

describe("内置适配器的停下接在关停路径上", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-builtin-adapters-shutdown-e2e-"));
	});

	afterEach(async () => {
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		await rm(dataDir, { recursive: true, force: true });
	});

	it("关服务之后,登记表叫过内置适配器的 stop()", async () => {
		stops.count = 0;
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
		expect(stops.count).toBe(0);
		await handle.close("test");
		handle = undefined;
		expect(stops.count).toBe(1);
	});
});
