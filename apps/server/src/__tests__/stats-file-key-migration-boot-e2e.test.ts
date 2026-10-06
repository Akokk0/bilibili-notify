/**
 * 🔴 **开机迁移接上了,而且跑在写它们的人前面**(ADR-0020 决策 2 的 🔗)。
 *
 * 迁移函数自己的单测证明不了它在真 BN 里被调用、更证明不了顺序:粉丝轮询一起来就按订阅 id
 * 读盘恢复首屏、之后按订阅 id 往里写;统计记录器只在引擎发事件时写,引擎是它唯一的事件来源。
 * 迁移若跑在它们后面(或压根没接上),轮询读到的是空文件、写出一份新的 id 文件,老的 uid 文件
 * 再并进来就成了「新的在前、老的在后」—— 读的人按「时间只增不减」扫文件,数全都错,而且没人报错。
 *
 * 所以起一台真 BN,在轮询与引擎被建起来的**那一刻**看一眼盘:老文件必须已经挪到位。订阅是
 * **停用**的 —— 迁移照样要管它(统计页照样列着停用的),而停用的订阅不会让引擎或轮询去连 B 站。
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { FOLLOWERS_DIR } from "../fans/store.js";
import { type ServerHandle, startServer } from "../index.js";
import { zeroBiliRow } from "../migration/__tests__/zero-fixtures.js";
import { activeGeneration } from "./support/generation.js";

const SUB_ID = "5a000000-0000-4000-8000-000000000101";
const UID = "101";
const ORPHAN_UID = "999";

/** 轮询 / 引擎被建起来那一刻,盘上老文件与新文件各在不在。 */
const probe = vi.hoisted(() => ({
	dataDir: "",
	atPoller: undefined as Record<string, boolean> | undefined,
	atEngines: undefined as Record<string, boolean> | undefined,
}));

/**
 * 开机从 0.x 的根上迁出来的那一代(建造函数是同步的,所以同步看盘)。数据根是它,不是 `dataDir` 本身;
 * 还没有一代就回 `dataDir`(下面的存在性判断于是全是 false)。
 */
function generationDirSync(dataDir: string): string {
	try {
		const seqs = readdirSync(join(dataDir, "generations"))
			.filter((name) => /^\d+$/.test(name))
			.map(Number);
		return seqs.length > 0 ? join(dataDir, "generations", String(Math.max(...seqs))) : dataDir;
	} catch {
		return dataDir;
	}
}

function look(): Record<string, boolean> {
	const root = generationDirSync(probe.dataDir);
	const at = (dir: string, key: string) => existsSync(join(root, dir, `${key}.jsonl`));
	const fans = join(...FOLLOWERS_DIR);
	return {
		fansUid: at(fans, UID),
		fansId: at(fans, SUB_ID),
		dynUid: at(join("stats", "dyn"), UID),
		dynId: at(join("stats", "posts"), SUB_ID),
		liveUid: at(join("stats", "live"), UID),
		liveId: at(join("stats", "live"), SUB_ID),
	};
}

vi.mock("../runtime/fans-poller.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/fans-poller.js")>();
	return {
		...real,
		startFansPoller: (opts: Parameters<typeof real.startFansPoller>[0]) => {
			probe.atPoller = look();
			return real.startFansPoller(opts);
		},
	};
});

vi.mock("../runtime/engines.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/engines.js")>();
	return {
		...real,
		createEngines: (opts: Parameters<typeof real.createEngines>[0]) => {
			probe.atEngines = look();
			return real.createEngines(opts);
		},
	};
});

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const p = createServer();
		p.on("error", reject);
		p.listen(0, "127.0.0.1", () => {
			const address = p.address();
			if (!address || typeof address === "string") {
				p.close(() => reject(new Error("failed to allocate test port")));
				return;
			}
			const { port } = address;
			p.close(() => resolve(port));
		});
	});
}

/** 老文件都已挪到订阅 id 名下的样子。 */
const MIGRATED = {
	fansUid: false,
	fansId: true,
	dynUid: false,
	dynId: true,
	liveUid: false,
	liveId: true,
};

const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const FANS = jsonl([
	{ ts: "2026-05-10T00:00:00.000Z", value: 100 },
	{ ts: "2026-05-11T00:00:00.000Z", value: 110 },
]);

describe("开机迁移 e2e:老的 <uid>.jsonl 在轮询 / 引擎起来之前就挪到了 <订阅 id>.jsonl", () => {
	let handle: ServerHandle | undefined;
	let port: number;

	beforeAll(async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-stats-migrate-e2e-"));
		probe.dataDir = dataDir;
		// 0.x 的布局原样摆在根上(第 0 代):开机先把它迁进新的一代,再由统计迁移改按订阅 id 命名。
		// 所以开机前不能先开一代(有了合用的一代就不迁了)。
		await mkdir(join(dataDir, "state"), { recursive: true });
		await mkdir(join(dataDir, "fans"), { recursive: true });
		await mkdir(join(dataDir, "stats", "dyn"), { recursive: true });
		await mkdir(join(dataDir, "stats", "live"), { recursive: true });
		// 0.x 盘上的 B 站订阅:身份在顶层 uid、没有 identity。迁移器在开机时把它收进 identity。
		// 用冻住的 0.x 夹具摆(不取活工厂:活工厂的键已经是 1.0 的,摆进第 0 代迁移器就没有东西可改了)。
		const sub = zeroBiliRow({ id: SUB_ID, uid: UID }, { enabled: false });
		await writeFile(join(dataDir, "state", "subscriptions.json"), JSON.stringify([sub]));
		await writeFile(join(dataDir, "fans", `${UID}.jsonl`), FANS);
		await writeFile(join(dataDir, "fans", `${ORPHAN_UID}.jsonl`), FANS);
		const now = new Date().toISOString();
		await writeFile(
			join(dataDir, "stats", "dyn", `${UID}.jsonl`),
			jsonl([{ id: "d1", type: "DYNAMIC_TYPE_AV", ts: now }]),
		);
		await writeFile(
			join(dataDir, "stats", "live", `${UID}.jsonl`),
			jsonl([{ k: "start", ts: now }]),
		);

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
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		if (probe.dataDir) await rm(probe.dataDir, { recursive: true, force: true });
	});

	it("粉丝轮询建起来的那一刻,三份老文件都已经挪到订阅 id 名下", () => {
		expect(probe.atPoller).toEqual(MIGRATED);
	});

	it("引擎(统计记录器唯一的事件来源)建起来的那一刻也一样", () => {
		expect(probe.atEngines).toEqual(MIGRATED);
	});

	it("找不到订阅的 uid 文件原样留着", async () => {
		expect(
			await readFile(
				join(await activeGeneration(probe.dataDir), ...FOLLOWERS_DIR, `${ORPHAN_UID}.jsonl`),
				"utf-8",
			),
		).toBe(FANS);
	});

	it("统计页读得到挪过去的数据(停用的订阅照样列着)", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/stats/overview?days=7&tz=0`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as StatsOverviewResponse;
		expect(body.rows).toHaveLength(1);
		expect(body.rows[0]).toMatchObject({
			identity: { sourceKey: "bilibili", externalId: UID },
			videoPosts: 1,
			liveSessions: 1,
		});
	});
});
