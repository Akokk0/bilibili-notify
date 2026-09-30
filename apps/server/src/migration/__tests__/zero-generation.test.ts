/**
 * 第 0 代 → 新的一代(ADR-0022 决策 4、7;⑥b 第一版:只搬位置,格式一律不动)。
 *
 * 摆一棵 0.x 的夹具树,迁完看新代:每条 0.x 路径都到了代布局里该去的地方;追加写的 jsonl 是复制,
 * 其余是硬链接,软链重建同样的一条;残留、卡片皮肤、宿主的东西不带过来;第 0 代一个字节都没动。
 *
 * 最后一条是修订号的闸:迁移的产出(搬了什么、搬到哪、怎么搬、丢下了什么)变了,就必须抬
 * `MIGRATION_REVISION` —— 否则开发期迁出来的那一代不会重迁,新代码读着旧产出。
 */

import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	MIGRATION_REVISION,
	type MigrationProgress,
	migrateZeroGeneration,
	zeroGenerationExists,
} from "../zero-generation.js";

let root: string;
let zero: string;
let target: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bn-zero-generation-"));
	zero = join(root, "data");
	target = join(root, "data", "generations", "1.partial");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** 0.x 夹具:相对第 0 代根的路径 → 内容。 */
const ZERO_FILES: Record<string, string> = {
	// 老形状的设置与订阅(第二代附加项、第一代 routing + @全体):第二遍会改写它们。
	"state/globals.json": JSON.stringify({
		app: {},
		defaults: {
			features: { liveEnd: true, liveEndExtras: { wordcloud: true } },
			// 最老一代的扁平 AI 连接字段、历代旧默认模板
			ai: { apiKey: "sk-old", baseUrl: "https://api.example.com", model: "m" },
			templates: { liveEnd: "{name} 下播了，直播时长 {duration}" },
		},
		// 0.9.1 的「范围 + 白名单」
		linkParsing: {
			enabled: true,
			scope: "selected",
			targets: [{ targetId: "22222222-2222-4222-8222-222222222222" }],
		},
	}),
	"state/subscriptions.json": JSON.stringify([
		{
			id: "33333333-3333-4333-8333-333333333333",
			uid: "12345",
			routing: { liveEnd: [], wordcloud: ["22222222-2222-4222-8222-222222222222"] },
			atAll: { live: { "22222222-2222-4222-8222-222222222222": true } },
		},
	]),
	"state/extension-subscriptions.json": "[]",
	// v1 的连接与目标:第二遍会把它们改写成最新的形状。
	"state/connections.json": JSON.stringify([
		{
			id: "11111111-1111-4111-8111-111111111111",
			name: "NapCat",
			enabled: true,
			platform: "onebot",
			config: { transport: "http", baseUrl: "http://127.0.0.1:3000" },
		},
	]),
	"state/targets.json": JSON.stringify([
		{
			id: "22222222-2222-4222-8222-222222222222",
			name: "主群",
			adapterId: "11111111-1111-4111-8111-111111111111",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "111" },
		},
	]),
	"state/adapters.json": "[]",
	"state/sub-runtime.json": "{}",
	"state/roast-drafts.json": "[]",
	"secrets/master.key": "ab".repeat(32),
	"secrets/kdf.salt": "cd".repeat(16),
	"secrets/config-secrets.enc": "enc",
	"secrets/cookies.json": "{}",
	"history/2026-09-30.jsonl": '{"id":1}\n',
	"history/img/a.png": "png",
	"history/repush/2026-09-30/row-1.json": "{}",
	"stats/dyn/sub-1.jsonl": '{"k":"post"}\n',
	"stats/live/sub-1.jsonl": '{"k":"start"}\n',
	"stats/seen/sub-1.jsonl": '{"d":"2026-09-30"}\n',
	"stats/since": "2026-09-01",
	"fans/sub-1.jsonl": '{"value":1}\n',
	"assets/card-bg/0123abcd.png": "bg",
	"assets/font/index.json": "{}",
	"assets/font/f1.woff2": "font",
	"assets/chat/att-1.png": "chat",
	"avatars/sub-2.png": "avatar",
	"skins/skin-1/skin.json": "{}",
	"skins/active.json": '{"id":"panel-1"}',
	"card-skins/card-1/card-skin.json": "{}",
	"maid-skills/weekly/SKILL.md": "# weekly",
	"ai/chat/conv-1.json": "{}",
	"extensions/probe/extension.json": "{}",
	"extensions/probe/index.mjs": "export {}",
	"extensions/load-state.json": "{}",
	"extensions/.marketplace.json": "{}",
	"card-bg-cursors.json": "{}",
	// 残留:上个进程的临时文件、0.x 留下的备份与迁移中间件、storage 旧的缺省目录
	"state/globals.json.bn-tmp.123.abcdef": "half",
	"state/targets.json.bak": "old",
	"state/targets.json.restore.bak": "old",
	"history/2026-09-29.jsonl.tmp.99": "half",
	"bilibili-notify/cookies.json": "{}",
	// 宿主的东西:不属于任何一代
	"versions/1.0.0/index.mjs": "export {}",
	"logs/2026-09-30.jsonl": '{"msg":"x"}\n',
	// 认不得的一级项
	"notes.txt": "hello",
};

/** 期望的去向:相对第 0 代根 → 相对新代根。 */
const EXPECTED_MOVES: Record<string, string> = {
	"state/globals.json": "config/globals.json",
	"state/subscriptions.json": "config/subscriptions.json",
	"state/extension-subscriptions.json": "config/extension-subscriptions.json",
	"state/connections.json": "config/connections.json",
	"state/targets.json": "config/targets.json",
	"state/sub-runtime.json": "runtime/sub-runtime.json",
	"state/roast-drafts.json": "runtime/roast-drafts.json",
	"secrets/master.key": "secrets/master.key",
	"secrets/kdf.salt": "secrets/kdf.salt",
	"secrets/config-secrets.enc": "secrets/config-secrets.enc",
	"secrets/cookies.json": "secrets/cookies.json",
	"history/2026-09-30.jsonl": "history/2026-09-30.jsonl",
	"history/img/a.png": "history/img/a.png",
	"history/repush/2026-09-30/row-1.json": "history/repush/2026-09-30/row-1.json",
	"stats/dyn/sub-1.jsonl": "stats/dyn/sub-1.jsonl",
	"stats/live/sub-1.jsonl": "stats/live/sub-1.jsonl",
	"stats/seen/sub-1.jsonl": "stats/seen/sub-1.jsonl",
	"stats/since": "stats/since",
	"fans/sub-1.jsonl": "stats/followers/sub-1.jsonl",
	"assets/card-bg/0123abcd.png": "library/images/0123abcd.png",
	"assets/font/index.json": "library/fonts/index.json",
	"assets/font/f1.woff2": "library/fonts/f1.woff2",
	"assets/chat/att-1.png": "assets/chat/att-1.png",
	"avatars/sub-2.png": "avatars/sub-2.png",
	"skins/skin-1/skin.json": "skins/dashboard/skin-1/skin.json",
	"skins/active.json": "skins/dashboard/active.json",
	"maid-skills/weekly/SKILL.md": "maid-skills/weekly/SKILL.md",
	"ai/chat/conv-1.json": "ai/conversations/conv-1.json",
	"extensions/probe/extension.json": "extensions/probe/extension.json",
	"extensions/probe/index.mjs": "extensions/probe/index.mjs",
	"extensions/load-state.json": "extensions/load-state.json",
	"extensions/.marketplace.json": "extensions/.marketplace.json",
	"card-bg-cursors.json": "runtime/card-bg-cursors.json",
};

/** 第二遍改写成最新形状的(相对新代根):不再和第 0 代共用一个文件。 */
const REWRITTEN = [
	"config/connections.json",
	"config/globals.json",
	"config/subscriptions.json",
	"config/targets.json",
];

async function placeZeroGeneration(): Promise<void> {
	for (const [path, content] of Object.entries(ZERO_FILES)) {
		await mkdir(dirname(join(zero, path)), { recursive: true });
		await writeFile(join(zero, path), content);
	}
	// 开发版 devtools 链进来的拓展:软链,新代里重建同样的一条。
	await mkdir(join(root, "elsewhere"), { recursive: true });
	await symlink(join(root, "elsewhere"), join(zero, "extensions", "dev-bridge"));
}

/** 一棵树的全部文件(相对路径,不跟软链)。 */
async function listTree(dir: string, base = dir): Promise<string[]> {
	const out: string[] = [];
	for (const name of await readdir(dir).catch(() => [] as string[])) {
		const path = join(dir, name);
		const info = await lstat(path);
		if (info.isDirectory()) out.push(...(await listTree(path, base)));
		else out.push(relative(base, path).split(sep).join("/"));
	}
	return out.sort();
}

/** 整棵树(不含代目录)的摘要:路径 + 内容。 */
async function treeDigest(dir: string): Promise<string> {
	const hash = createHash("sha256");
	for (const path of await listTree(dir)) {
		if (path.startsWith("generations/")) continue;
		hash.update(path);
		const info = await lstat(join(dir, path));
		hash.update(info.isSymbolicLink() ? "->link" : await readFile(join(dir, path)));
	}
	return hash.digest("hex");
}

describe("zeroGenerationExists", () => {
	it("空目录、只有宿主的东西 → 没有第 0 代;有 0.x 的一级项 → 有", async () => {
		await mkdir(zero, { recursive: true });
		expect(await zeroGenerationExists(zero)).toBe(false);
		await mkdir(join(zero, "versions"), { recursive: true });
		await mkdir(join(zero, "logs"), { recursive: true });
		expect(await zeroGenerationExists(zero)).toBe(false);
		await mkdir(join(zero, "state"), { recursive: true });
		expect(await zeroGenerationExists(zero)).toBe(true);
	});
});

describe("migrateZeroGeneration", () => {
	it("每条 0.x 路径都到了代布局里该去的地方;没被改写的内容不变", async () => {
		await placeZeroGeneration();

		const report = await migrateZeroGeneration({ zeroRoot: zero, targetDir: target });

		expect(await listTree(target)).toEqual(
			[...Object.values(EXPECTED_MOVES), "extensions/dev-bridge"].sort(),
		);
		expect([...report.rewritten].sort()).toEqual(REWRITTEN);
		for (const [from, to] of Object.entries(EXPECTED_MOVES)) {
			if (REWRITTEN.includes(to)) continue;
			expect(await readFile(join(target, to), "utf8"), to).toBe(ZERO_FILES[from]);
		}
	});

	it("连接与目标改写成最新的形状", async () => {
		await placeZeroGeneration();

		await migrateZeroGeneration({ zeroRoot: zero, targetDir: target });

		const read = async (name: string) =>
			JSON.parse(await readFile(join(target, "config", name), "utf8")) as unknown[];
		expect(await read("connections.json")).toEqual([
			expect.objectContaining({ kind: "direct", connector: "http", platform: "onebot" }),
		]);
		expect(await read("targets.json")).toEqual([
			expect.objectContaining({
				connectionId: "11111111-1111-4111-8111-111111111111",
				kind: "session",
				address: "111",
			}),
		]);
	});

	it("追加写的 jsonl 是复制,其余是硬链接", async () => {
		await placeZeroGeneration();

		await migrateZeroGeneration({ zeroRoot: zero, targetDir: target });

		for (const [from, to] of Object.entries(EXPECTED_MOVES)) {
			const same = (await stat(join(target, to))).ino === (await stat(join(zero, from))).ino;
			// 改写过的是新文件:原地写的话,改的就是第 0 代那一份。
			const shared = !from.endsWith(".jsonl") && !REWRITTEN.includes(to);
			expect(same, `${to} 应当${shared ? "硬链接" : "是另一个文件"}`).toBe(shared);
		}
	});

	it("开发版链进来的拓展:新代里重建同样的一条软链,不拷内容", async () => {
		await placeZeroGeneration();

		await migrateZeroGeneration({ zeroRoot: zero, targetDir: target });

		const link = join(target, "extensions", "dev-bridge");
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect(await readlink(link)).toBe(join(root, "elsewhere"));
	});

	it("残留、卡片皮肤、宿主的东西不带过来,都记进报告;认不得的一级项也记", async () => {
		await placeZeroGeneration();

		const report = await migrateZeroGeneration({ zeroRoot: zero, targetDir: target });

		expect(report.skipped.map((s) => s.path).sort()).toEqual(
			[
				"bilibili-notify",
				"card-skins",
				"history/2026-09-29.jsonl.tmp.99",
				"notes.txt",
				"state/adapters.json",
				"state/globals.json.bn-tmp.123.abcdef",
				"state/targets.json.bak",
				"state/targets.json.restore.bak",
			].sort(),
		);
		for (const skipped of report.skipped) expect(skipped.reason.length).toBeGreaterThan(0);
	});

	it("第 0 代一个字节都没动", async () => {
		await placeZeroGeneration();
		const before = await treeDigest(zero);

		await migrateZeroGeneration({ zeroRoot: zero, targetDir: target });

		expect(await treeDigest(zero)).toBe(before);
	});

	it("按一级项报进度,最后一次是全部做完", async () => {
		await placeZeroGeneration();
		const seen: MigrationProgress[] = [];

		await migrateZeroGeneration({
			zeroRoot: zero,
			targetDir: target,
			onProgress: (progress) => seen.push(progress),
		});

		expect(seen.length).toBeGreaterThan(2);
		const last = seen.at(-1);
		expect(last?.done).toBe(last?.total);
		for (const progress of seen) expect(progress.label.length).toBeGreaterThan(0);
		expect(seen.map((p) => p.done)).toEqual([...seen.map((p) => p.done)].sort((a, b) => a - b));
	});

	it("产出变了就得抬 MIGRATION_REVISION", async () => {
		await placeZeroGeneration();

		const report = await migrateZeroGeneration({ zeroRoot: zero, targetDir: target });
		const hash = createHash("sha256");
		for (const t of [...report.transfers].sort((a, b) => a.from.localeCompare(b.from))) {
			hash.update(`${t.from} -> ${t.to} (${t.method})\n`);
		}
		for (const s of [...report.skipped].sort((a, b) => a.path.localeCompare(b.path))) {
			hash.update(`skip ${s.path}\n`);
		}
		for (const path of [...report.rewritten].sort()) {
			hash.update(`rewrite ${path}\n`).update(await readFile(join(target, path)));
		}

		// 迁移的产出一变,这一行就红:把 MIGRATION_REVISION 加 1,再把这里的两个值一起更新。
		// 只改了摘要、没抬修订号的话,开发期已经迁出来的那一代不会重迁,新代码读着旧产出。
		expect({ revision: MIGRATION_REVISION, output: hash.digest("hex") }).toEqual({
			revision: 6,
			output: "1852a9342ac57d9ab79bb993d2dfd6c665f0e03011539f9700e2c2f4318aade9",
		});
	});
});
