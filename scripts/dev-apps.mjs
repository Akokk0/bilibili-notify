import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { argv, env, platform } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const shutdownGraceMs = 8_000;
const backendReadyUrl = "http://127.0.0.1:8787/api/health";
const backendReadyTimeoutMs = 20_000;
const backendReadyIntervalMs = 200;

export function createDevProcessSpecs(root = repoRoot) {
	return [
		{
			name: "apps/server dev",
			command: "vp",
			args: ["exec", "tsx", "watch", "--tsconfig", "tsconfig.dev.json", "src/index.ts"],
			cwd: resolve(root, "apps/server"),
		},
		{
			name: "apps/web dev",
			command: "vp",
			args: ["dev"],
			cwd: resolve(root, "apps/web"),
		},
	];
}

export function statusToExitCode(status) {
	if (status.error) return 1;
	if (typeof status.code === "number") return status.code;
	if (status.signal === "SIGINT") return 130;
	if (status.signal === "SIGTERM") return 143;
	return 1;
}

export function isCleanStatus(status, intentionalStop = false) {
	if (status.error) return false;
	if (status.code === 0) return true;
	if (!intentionalStop) return false;
	return status.signal === "SIGINT" || status.signal === "SIGTERM";
}

export function formatStatus(status) {
	if (status.error) return `failed to start: ${status.error.message}`;
	if (typeof status.code === "number") return `exited with code ${status.code}`;
	return `exited with signal ${status.signal ?? "unknown"}`;
}

export function buildWindowsTreeKillArgs(pid) {
	return ["taskkill", ["/pid", String(pid), "/T", "/F"]];
}

export async function waitForHttpReachable(
	url,
	{
		timeoutMs = backendReadyTimeoutMs,
		intervalMs = backendReadyIntervalMs,
		fetchImpl = globalThis.fetch,
		sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
	} = {},
) {
	if (typeof fetchImpl !== "function") throw new Error("global fetch is not available");
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() <= deadline) {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), Math.min(intervalMs, 1_000));
			timer.unref?.();
			try {
				await fetchImpl(url, { method: "GET", signal: controller.signal });
			} finally {
				clearTimeout(timer);
			}
			return;
		} catch (err) {
			lastError = err;
			if (Date.now() >= deadline) break;
			await sleep(intervalMs);
		}
	}
	const detail =
		lastError instanceof Error ? `: ${lastError.message}` : lastError ? `: ${lastError}` : "";
	throw new Error(`timed out waiting for ${url}${detail}`);
}

export async function runDevApps({
	root = repoRoot,
	spawnProcess = spawn,
	processEnv = env,
	processPlatform = platform,
	log = console.error,
	graceMs = shutdownGraceMs,
	waitForBackendReady = waitForHttpReachable,
	readyUrl = backendReadyUrl,
	readyTimeoutMs = backendReadyTimeoutMs,
	readyIntervalMs = backendReadyIntervalMs,
} = {}) {
	const specs = createDevProcessSpecs(root);
	const children = [];
	let intentionalStop = false;
	let requestedExitCode = 0;
	let settled = 0;
	let forceTimer;
	const statuses = new Map();

	return await new Promise((resolveRun) => {
		const cleanup = () => {
			process.off("SIGINT", onSigint);
			process.off("SIGTERM", onSigterm);
			if (forceTimer) clearTimeout(forceTimer);
		};

		const finishIfDone = () => {
			if (settled < children.length) return;
			cleanup();
			if (intentionalStop) {
				resolveRun(requestedExitCode);
				return;
			}
			const failed = [...statuses.values()].find((status) => !isCleanStatus(status, false));
			resolveRun(failed ? statusToExitCode(failed) : 0);
		};

		const stopAll = (reason, exitCode, signal = "SIGINT") => {
			if (!intentionalStop) log(`[dev:apps] ${reason}; stopping dev servers…`);
			intentionalStop = true;
			requestedExitCode = exitCode;
			for (const { child } of children) sendSignal(child, signal, processPlatform);
			if (!forceTimer) {
				forceTimer = setTimeout(() => {
					log(`[dev:apps] dev servers did not exit within ${graceMs}ms; force killing…`);
					for (const { child } of children) sendSignal(child, "SIGKILL", processPlatform);
				}, graceMs);
				forceTimer.unref?.();
			}
		};

		const onSigint = () => stopAll("received SIGINT", 0, "SIGINT");
		const onSigterm = () => stopAll("received SIGTERM", 0, "SIGTERM");
		process.on("SIGINT", onSigint);
		process.on("SIGTERM", onSigterm);

		const startProcess = (spec) => {
			if (intentionalStop) return undefined;
			log(`[dev:apps] starting ${spec.name}: ${spec.command} ${spec.args.join(" ")}`);
			const running = {
				spec,
				child: spawnProcess(spec.command, spec.args, {
					cwd: spec.cwd,
					detached: processPlatform !== "win32",
					env: processEnv,
					stdio: "inherit",
				}),
			};
			children.push(running);
			const settle = (status) => {
				if (statuses.has(running.child)) return;
				statuses.set(running.child, { ...status, spec: running.spec });
				settled += 1;
				const fullStatus = statuses.get(running.child);
				if (!intentionalStop) {
					const clean = isCleanStatus(fullStatus, false);
					const reason = `${running.spec.name} ${formatStatus(fullStatus)}`;
					stopAll(reason, clean ? 0 : statusToExitCode(fullStatus), clean ? "SIGTERM" : "SIGINT");
				}
				finishIfDone();
			};
			running.child.once("error", (error) => settle({ error }));
			running.child.once("exit", (code, signal) => settle({ code, signal }));
			return running;
		};

		void (async () => {
			startProcess(specs[0]);
			if (waitForBackendReady && specs.length > 1) {
				log(`[dev:apps] waiting for backend: ${readyUrl}`);
				try {
					await waitForBackendReady(readyUrl, {
						timeoutMs: readyTimeoutMs,
						intervalMs: readyIntervalMs,
					});
					if (!intentionalStop) log("[dev:apps] backend ready; starting web dev server…");
				} catch (err) {
					if (!intentionalStop) {
						const message = err instanceof Error ? err.message : String(err);
						log(
							`[dev:apps] backend not ready after ${readyTimeoutMs}ms (${message}); starting web anyway…`,
						);
					}
				}
			}
			if (intentionalStop) return;
			for (const spec of specs.slice(1)) startProcess(spec);
		})();
	});
}

function sendSignal(child, signal, processPlatform = platform) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (processPlatform === "win32" && child.pid) {
		killWindowsProcessTree(child.pid);
		return;
	}
	try {
		if (!child.pid) {
			child.kill(signal);
			return;
		}
		process.kill(-child.pid, signal);
	} catch (err) {
		if (err?.code === "ESRCH") return;
		try {
			child.kill(signal);
		} catch (fallbackErr) {
			if (fallbackErr?.code !== "ESRCH") throw fallbackErr;
		}
	}
}

function killWindowsProcessTree(pid) {
	const [command, args] = buildWindowsTreeKillArgs(pid);
	const result = spawnSync(command, args, { stdio: "ignore" });
	if (result.error && result.error.code !== "ENOENT") throw result.error;
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
	process.exitCode = await runDevApps();
}
