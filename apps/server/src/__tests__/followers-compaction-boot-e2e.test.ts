/**
 * 🔴 **粉丝样本的定时压缩接在开机上了**(ADR-0027 决策 15;㉘c)。
 *
 * 仓的 `compact`、定时活 `startFollowersCompaction` 各有单测,证明不了 `index.ts` 里真的把它起了 —— 漏掉那一行的症状是
 * 一切照常,只是盘上的粉丝样本再也不缩,门禁全绿。所以起一台真 BN(数据那一代开机前摆好,一份攒着旧样本的文件),
 * 开机那一轮压缩就该把它压成段。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { FOLLOWERS_DIR } from "../followers/store.js";
import { type ServerHandle, startServer } from "../index.js";
import { openTestGeneration } from "./support/generation.js";

const KEY = "b0000000-0000-4000-8000-000000000001";
const row = (sampledAt: string, followers: number) => JSON.stringify({ sampledAt, followers });

/** 全是远早于「现在」的样本:00 点那小时有两条、00–02 点同值 100、03 点 105。 */
const RAW = `${[
	row("2026-06-10T00:10:00.000Z", 100),
	row("2026-06-10T00:50:00.000Z", 100),
	row("2026-06-10T01:20:00.000Z", 100),
	row("2026-06-10T02:05:00.000Z", 100),
	row("2026-06-10T03:00:00.000Z", 105),
].join("\n")}\n`;
const COMPACTED = `${[
	JSON.stringify({
		sampledAt: "2026-06-10T00:50:00.000Z",
		followers: 100,
		lastSampledAt: "2026-06-10T02:05:00.000Z",
	}),
	row("2026-06-10T03:00:00.000Z", 105),
].join("\n")}\n`;

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

describe("粉丝样本压缩 e2e:开机那一轮就压", () => {
	let dataDir: string;
	let file: string;
	let handle: ServerHandle | undefined;

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-followers-compaction-e2e-"));
		const gen = await openTestGeneration(dataDir);
		await mkdir(join(gen, ...FOLLOWERS_DIR), { recursive: true });
		file = join(gen, ...FOLLOWERS_DIR, `${KEY}.jsonl`);
		await writeFile(file, RAW);
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
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	it("盘上攒着的旧样本被压成段", async () => {
		await vi.waitFor(async () => expect(await readFile(file, "utf8")).toBe(COMPACTED), {
			timeout: 5_000,
			interval: 50,
		});
	});
});
