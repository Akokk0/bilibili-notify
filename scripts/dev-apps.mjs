import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { argv, env, platform } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const shutdownGraceMs = 8_000;

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

export async function runDevApps({
	root = repoRoot,
	spawnProcess = spawn,
	processEnv = env,
	processPlatform = platform,
	log = console.error,
	graceMs = shutdownGraceMs,
} = {}) {
	const specs = createDevProcessSpecs(root);
	const children = specs.map((spec) => {
		log(`[dev:apps] starting ${spec.name}: ${spec.command} ${spec.args.join(" ")}`);
		return {
			spec,
			child: spawnProcess(spec.command, spec.args, {
				cwd: spec.cwd,
				detached: processPlatform !== "win32",
				env: processEnv,
				stdio: "inherit",
			}),
		};
	});

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

		for (const running of children) {
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
		}
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
