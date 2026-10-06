/**
 * 运行记录接在开机与关停路径上(㉗a):开机在数据那一代就位之后 `start()`,关停把当前不满的这一小时补记一行。
 *
 * 记录器与仓各自有直测,证明不了 `index.ts` 里那一行 `uptimeRecorder.start()` 真的写上了 ——
 * 漏了的症状是:一切照常、盘上永远没有 `uptime/`,门禁全绿。这里走真的 `startServer`(不带订阅,不联网)。
 * 只拨 Date:开机时刻定在 08:20、关停前拨到 08:50,补的那一行是 30 分钟。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";

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

describe("运行记录接在开机路径上 e2e", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-uptime-boot-e2e-"));
	});
	afterEach(async () => {
		vi.useRealTimers();
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		await rm(dataDir, { recursive: true, force: true });
	});

	it("开机 start、关停补记:新一代的 uptime/hours.jsonl 里有那一小时的分钟数", async () => {
		const port = await findFreePort();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-06T08:20:00.000Z"));
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
		vi.setSystemTime(new Date("2026-10-06T08:50:00.000Z"));
		await handle.close("test");
		handle = undefined;
		vi.useRealTimers();

		const text = await readFile(join(dataDir, "generations", "1", "uptime", "hours.jsonl"), "utf8");
		expect(
			text
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([{ hourStartedAt: "2026-10-06T08:00:00.000Z", minutes: 30 }]);
	});
});
