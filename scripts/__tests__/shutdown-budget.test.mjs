/**
 * 服务端的关停预算必须小于每个宿主的硬杀时限，还要留出余量:宿主先到点的话，它会在服务端落盘的
 * 最后一刻整组 SIGKILL,关停预算形同虚设。2026-09-29 dev 启动器的宽限期与服务端预算同为 8 秒，
 * 零余量，没有任何门拦着。
 *
 * 四个数住在四种文件里(TS 常量、.mjs 常量、compose YAML、Rust 常量),只能按源码读。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { shutdownGraceMs } from "../dev-apps.mjs";
import { repoRoot } from "../vite-alias.mjs";

const MARGIN_MS = 1_000;

function read(path) {
	return readFileSync(join(repoRoot(), path), "utf8");
}

function capture(source, pattern, what) {
	const match = source.match(pattern);
	if (!match) throw new Error(`没找到${what}`);
	return Number(match[1].replaceAll("_", ""));
}

const serverBudgetMs = capture(
	read("apps/server/src/index.ts"),
	/^const DEFAULT_SHUTDOWN_TIMEOUT_MS = ([\d_]+);$/m,
	"服务端的关停预算 DEFAULT_SHUTDOWN_TIMEOUT_MS",
);

describe("关停预算小于每个宿主的硬杀时限", () => {
	it("dev 启动器(scripts/dev-apps.mjs)", () => {
		expect(shutdownGraceMs).toBeGreaterThanOrEqual(serverBudgetMs + MARGIN_MS);
	});

	it("compose 样例写明了 stop_grace_period", () => {
		const seconds = capture(
			read("apps/docker-compose.example.yaml"),
			/^ {4}stop_grace_period: (\d+)s$/m,
			"bilibili-notify 服务的 stop_grace_period",
		);
		expect(seconds * 1_000).toBeGreaterThanOrEqual(serverBudgetMs + MARGIN_MS);
	});

	it("桌面壳(SHUTDOWN_TIMEOUT)", () => {
		const seconds = capture(
			read("apps/desktop/src-tauri/src/main.rs"),
			/^const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs\((\d+)\);$/m,
			"桌面壳的 SHUTDOWN_TIMEOUT",
		);
		expect(seconds * 1_000).toBeGreaterThanOrEqual(serverBudgetMs + MARGIN_MS);
	});
});
