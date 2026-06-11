import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	buildWindowsTreeKillArgs,
	createDevProcessSpecs,
	formatStatus,
	isCleanStatus,
	runDevApps,
	statusToExitCode,
	waitForHttpReachable,
} from "./dev-apps.mjs";

class FakeChild extends EventEmitter {
	exitCode = null;
	signalCode = null;
	signals = [];

	kill(signal) {
		this.signalCode = signal;
		this.signals.push(signal);
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}
}

function createFakeSpawn() {
	const children = [];
	const spawnProcess = vi.fn(() => {
		const child = new FakeChild();
		children.push(child);
		return child;
	});
	return { children, spawnProcess };
}

function runDevAppsNoWait(options) {
	return runDevApps({ ...options, waitForBackendReady: null });
}

describe("dev-apps supervisor", () => {
	it("直接用 vp 启动 server/web,避免 pnpm recursive Ctrl-C 被报告为失败", () => {
		const specs = createDevProcessSpecs("/repo");

		expect(specs).toEqual([
			expect.objectContaining({
				name: "apps/server dev",
				command: "vp",
				args: ["exec", "tsx", "watch", "--tsconfig", "tsconfig.dev.json", "src/index.ts"],
				cwd: "/repo/apps/server",
			}),
			expect.objectContaining({
				name: "apps/web dev",
				command: "vp",
				args: ["dev"],
				cwd: "/repo/apps/web",
			}),
		]);
		expect(specs.flatMap((spec) => [spec.command, ...spec.args])).not.toContain("pnpm");
	});

	it("等待后端可连接后再启动 web,避免 Vite 首次请求打到未监听的 8787", async () => {
		const { children, spawnProcess } = createFakeSpawn();
		let markReady;
		const waitForBackendReady = vi.fn(
			() =>
				new Promise((resolveReady) => {
					markReady = resolveReady;
				}),
		);
		const run = runDevApps({
			spawnProcess,
			processPlatform: "test",
			log: () => {},
			graceMs: 100,
			waitForBackendReady,
		});

		expect(children).toHaveLength(1);
		expect(waitForBackendReady).toHaveBeenCalledWith("http://127.0.0.1:8787/api/health", {
			timeoutMs: 20_000,
			intervalMs: 200,
		});
		markReady();
		await new Promise((r) => setImmediate(r));

		expect(children).toHaveLength(2);
		process.emit("SIGINT");
		await expect(run).resolves.toBe(0);
	});

	it("把有意停止时的 SIGINT/SIGTERM 视为干净退出", () => {
		expect(isCleanStatus({ code: 0 }, false)).toBe(true);
		expect(isCleanStatus({ signal: "SIGINT" }, true)).toBe(true);
		expect(isCleanStatus({ signal: "SIGTERM" }, true)).toBe(true);
		expect(isCleanStatus({ signal: "SIGINT" }, false)).toBe(false);
	});

	it("保留非交互失败的退出码", () => {
		expect(statusToExitCode({ code: 7 })).toBe(7);
		expect(statusToExitCode({ signal: "SIGINT" })).toBe(130);
		expect(statusToExitCode({ error: new Error("spawn failed") })).toBe(1);
		expect(formatStatus({ code: 7 })).toBe("exited with code 7");
	});

	it("SIGINT 后停止两个 dev 子进程并返回 0", async () => {
		const { children, spawnProcess } = createFakeSpawn();
		const run = runDevAppsNoWait({
			spawnProcess,
			processPlatform: "test",
			log: () => {},
			graceMs: 100,
		});

		expect(children).toHaveLength(2);
		process.emit("SIGINT");

		await expect(run).resolves.toBe(0);
		expect(children.map((child) => child.signals)).toEqual([["SIGINT"], ["SIGINT"]]);
	});

	it("子进程非 0 退出时停止另一个 dev 子进程并保留退出码", async () => {
		const { children, spawnProcess } = createFakeSpawn();
		const run = runDevAppsNoWait({
			spawnProcess,
			processPlatform: "test",
			log: () => {},
			graceMs: 100,
		});

		expect(children).toHaveLength(2);
		children[0].exitCode = 7;
		children[0].emit("exit", 7, null);

		await expect(run).resolves.toBe(7);
		expect(children[1].signals).toEqual(["SIGINT"]);
	});

	it("waitForHttpReachable 在 HTTP 可达后返回", async () => {
		const fetchImpl = vi
			.fn()
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockResolvedValueOnce({});
		const sleep = vi.fn(async () => {});

		await expect(
			waitForHttpReachable("http://127.0.0.1:8787/api/health", {
				fetchImpl,
				sleep,
				intervalMs: 1,
				timeoutMs: 100,
			}),
		).resolves.toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(1);
	});

	it("Windows 下终止整棵 dev 进程树", () => {
		expect(buildWindowsTreeKillArgs(1234)).toEqual(["taskkill", ["/pid", "1234", "/T", "/F"]]);
	});
});
