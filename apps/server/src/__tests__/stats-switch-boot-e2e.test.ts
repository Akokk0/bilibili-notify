/**
 * **数据统计关着时,压缩与运行记录照跑**(ADR-0027 决策 9、15;ADR-0033 决策 3;㉙a)。
 *
 * 开关只在记录器入口与粉丝轮询那一处拦「新记的数据」,压缩(`startStatsCompaction`)压的是已经攒下的、
 * 运行记录(`uptime/`)根本不是统计 —— 关着不该让它们停。起一台真 BN:数据那一代开机前摆好 `stats.enabled = false`
 * 的核心设置、一份攒着旧样本的粉丝文件、一份攒着首尾相接小时的账;开机那一轮压缩照样压了,关停照样补记运行记录。
 * 用「关着」这个前提真的生效作对照:开机后读 `/api/settings`,`stats.enabled` 确是 false。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CORE_SETTINGS_FILE } from "../config/store.js";
import { FOLLOWERS_DIR } from "../followers/store.js";
import { type ServerHandle, startServer } from "../index.js";
import { STATS_RECORDING_DIR } from "../stats/store.js";
import { openTestGeneration } from "./support/generation.js";

const KEY = "b0000000-0000-4000-8000-000000000001";
const row = (sampledAt: string, followers: number) => JSON.stringify({ sampledAt, followers });
const entry = (kind: string, startedAt: string, endedAt: string) =>
	JSON.stringify({ kind, startedAt, endedAt });

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
const LEDGER_RAW = `${[
	entry("posts", "2026-06-10T00:00:00.000Z", "2026-06-10T01:00:00.000Z"),
	entry("posts", "2026-06-10T01:00:00.000Z", "2026-06-10T02:00:00.000Z"),
	entry("live", "2026-06-10T00:00:00.000Z", "2026-06-10T01:00:00.000Z"),
].join("\n")}\n`;
const LEDGER_COMPACTED = `${[
	entry("live", "2026-06-10T00:00:00.000Z", "2026-06-10T01:00:00.000Z"),
	entry("posts", "2026-06-10T00:00:00.000Z", "2026-06-10T02:00:00.000Z"),
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

describe("统计关着:压缩与运行记录照跑 e2e", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-stats-switch-boot-e2e-"));
	});
	afterEach(async () => {
		vi.useRealTimers();
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		await rm(dataDir, { recursive: true, force: true });
	});

	it("开机那一轮压缩照压、关停照补记运行记录", async () => {
		const gen = await openTestGeneration(dataDir);
		const settings = join(gen, ...CORE_SETTINGS_FILE);
		await mkdir(dirname(settings), { recursive: true });
		await writeFile(
			settings,
			JSON.stringify({ ...makeDefaultGlobalConfig(), stats: { enabled: false } }),
		);
		const fansFile = join(gen, ...FOLLOWERS_DIR, `${KEY}.jsonl`);
		await mkdir(dirname(fansFile), { recursive: true });
		await writeFile(fansFile, RAW);
		const ledger = join(gen, ...STATS_RECORDING_DIR, `${KEY}.jsonl`);
		await mkdir(dirname(ledger), { recursive: true });
		await writeFile(ledger, LEDGER_RAW);

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

		// 前提确实生效:服务端读到的设置里统计是关着的。
		const settingsRes = await fetch(`${handle.url}/api/settings`);
		expect(((await settingsRes.json()) as { stats: { enabled: boolean } }).stats.enabled).toBe(
			false,
		);

		// 压缩:开机那一轮就压(两份都压)。不用 vi.waitFor —— 只拨了 Date,自己轮询。
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		let fansNow = "";
		let ledgerNow = "";
		for (let i = 0; i < 100; i++) {
			fansNow = await readFile(fansFile, "utf8");
			ledgerNow = await readFile(ledger, "utf8");
			if (fansNow === COMPACTED && ledgerNow === LEDGER_COMPACTED) break;
			await sleep(50);
		}
		expect(fansNow).toBe(COMPACTED);
		expect(ledgerNow).toBe(LEDGER_COMPACTED);

		// 运行记录:关停时把 08:00 这一小时已跑的 30 分钟补记上。
		vi.setSystemTime(new Date("2026-10-06T08:50:00.000Z"));
		await handle.close("test");
		handle = undefined;
		vi.useRealTimers();
		const hours = await readFile(join(gen, "uptime", "hours.jsonl"), "utf8");
		expect(
			hours
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([{ hourStartedAt: "2026-10-06T08:00:00.000Z", minutes: 30 }]);
	});
});
