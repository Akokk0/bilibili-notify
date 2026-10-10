/**
 * 守卫 8:服务关停返回以后，数据目录不再变化(docs/1.0/architecture.md「其余守卫」)。
 *
 * 关停后还落盘的写入平时只差几毫秒，直接跑几十次也撞不上一回(ENOTEMPTY 那条偶发就是这样藏住的)。
 * 所以这里给存储层的写入垫延迟，按写入**发出的时刻**分快慢:关停开始前已经在路上的写入慢
 * (`IN_FLIGHT_DELAY_MS`),关停开始以后才发的快。关停该等的它都得等满那段慢的;没等到的，一定落在
 * 关停返回之后，前后两次快照必然对不上 —— 每次都红，不靠运气。
 *
 * 🔴 两种写入要是垫一样长，关停自己要等的那次日志落盘会恰好替没被等到的写入把时间耗掉(先发出
 * 的那笔在它之前落地),守卫为错误的理由绿。搭场景那段不垫，只是省时间。
 *
 * 这条链上的已知晚到写入：送达回调把目标的可达性写回 `config/targets.json`(发出去就不管的那种)、
 * 日志归档的定时落盘(`logs/`)。
 */

import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";

const IN_FLIGHT_DELAY_MS = 1_500;
const DURING_CLOSE_DELAY_MS = 50;

const writes = vi.hoisted(() => ({ phase: "setup" as "setup" | "in-flight" | "closing" }));

vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const storage = await importOriginal<typeof import("@bilibili-notify/storage")>();
	const later = () => {
		const ms =
			writes.phase === "setup"
				? 0
				: writes.phase === "in-flight"
					? IN_FLIGHT_DELAY_MS
					: DURING_CLOSE_DELAY_MS;
		return new Promise((resolve) => setTimeout(resolve, ms));
	};
	return {
		...storage,
		atomicWriteFile: async (...args: Parameters<typeof storage.atomicWriteFile>) => {
			await later();
			return storage.atomicWriteFile(...args);
		},
		atomicWriteJson: async (...args: Parameters<typeof storage.atomicWriteJson>) => {
			await later();
			return storage.atomicWriteJson(...args);
		},
		appendLines: async (...args: Parameters<typeof storage.appendLines>) => {
			await later();
			return storage.appendLines(...args);
		},
		appendJsonl: async (...args: Parameters<typeof storage.appendJsonl>) => {
			await later();
			return storage.appendJsonl(...args);
		},
		replaceDirectory: async (...args: Parameters<typeof storage.replaceDirectory>) => {
			await later();
			return storage.replaceDirectory(...args);
		},
		removeDirectory: async (...args: Parameters<typeof storage.removeDirectory>) => {
			await later();
			return storage.removeDirectory(...args);
		},
	};
});

const WEBHOOK = "5b000000-0000-4000-8000-00000000c0b2";

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

/** 整棵目录的样子：每个条目的相对路径、大小、修改时刻、内容摘要。 */
async function snapshot(root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			const rel = relative(root, path);
			if (entry.isDirectory()) {
				out.push(`${rel}/`);
				await walk(path);
				continue;
			}
			const info = await stat(path);
			const digest = createHash("sha256")
				.update(await readFile(path))
				.digest("hex");
			out.push(`${rel} ${info.size} ${info.mtimeMs} ${digest}`);
		}
	};
	await walk(root);
	return out.sort();
}

describe("守卫 8:关停返回以后数据目录不再变化", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;
	let hookServer: Server;
	let port: number;
	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
	const json = (body: unknown): RequestInit => ({
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

	beforeAll(async () => {
		hookServer = createHttpServer((req, res) => {
			req.resume();
			req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
		});
		await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", resolve));
		const address = hookServer.address();
		if (!address || typeof address === "string") throw new Error("webhook 没起来");

		dataDir = await mkdtemp(join(tmpdir(), "bn-data-dir-still-e2e-"));
		port = await findFreePort();
		handle = await startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"info",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});
		const created = await api("/api/connections", {
			method: "POST",
			...json({
				id: WEBHOOK,
				name: "本地 webhook",
				enabled: true,
				adapterKey: "webhook",
				platform: "generic",
				settings: { url: `http://127.0.0.1:${address.port}/hook`, headers: {} },
			}),
		});
		if (!created.ok) throw new Error(`建连接失败:${created.status} ${await created.text()}`);
	});

	afterAll(async () => {
		await handle?.close("test cleanup");
		await new Promise<void>((resolve) => hookServer.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	it("送达一次测试推送后立刻关停，关停返回之后目录一个字节都不再动", async () => {
		const targets = (await (await api("/api/targets")).json()) as Array<{
			id: string;
			connectionId: string;
		}>;
		const target = targets.find((t) => t.connectionId === WEBHOOK);
		if (!target) throw new Error("webhook 连接没带出目标");
		writes.phase = "in-flight";
		const pushed = await api(`/api/targets/${target.id}/test`, {
			method: "POST",
			...json({ kind: "text" }),
		});
		expect(((await pushed.json()) as { ok: boolean }).ok).toBe(true);

		writes.phase = "closing";
		await handle?.close("guard 8");
		handle = undefined;
		const atClose = await snapshot(dataDir);
		await new Promise((resolve) => setTimeout(resolve, IN_FLIGHT_DELAY_MS * 2));

		expect(await snapshot(dataDir)).toEqual(atClose);
	});
});
