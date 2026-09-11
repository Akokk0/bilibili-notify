import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
			// 🔴 两个开关都是「三路输出共用一个终端」逼出来的:
			// - `--clear-screen=false`:tsx 默认每次重跑先清整个终端,Vite+ 的地址、拓展打包
			//   的状态会一起被擦掉。
			// - `--ignore ../../extensions/**`:装载器 import 过的拓展产物 tsx 也盯着,打包器
			//   起步那一下重写 dist 就让 server 整个重启一次(断直播间、重连一遍)。拓展改了
			//   由 devtools 自己热重载,不归 tsx 管。
			args: [
				"exec",
				"tsx",
				"watch",
				"--clear-screen=false",
				"--ignore",
				"../../extensions/**",
				"--tsconfig",
				"tsconfig.dev.json",
				"src/index.ts",
			],
			cwd: resolve(root, "apps/server"),
		},
		{
			name: "apps/web dev",
			command: "vp",
			args: ["dev"],
			cwd: resolve(root, "apps/web"),
		},
		// 仓里的拓展顺带 watch 打包:改一行 30ms 重建,配 devtools 的「改完自动重载」
		// 就是保存即生效。装载器只认构建产物,所以没有这一条就得手动 build 一次。
		...repoExtensionIds(root).map((id) => ({
			name: `extensions/${id} pack -w`,
			command: "vp",
			// 🔴 `--no-clean`:清一次 dist 会让装载器**在开机那一眼**看见一个空目录,而软链
			// 正指着它 —— 症状是拓展页上那条突然变成「装不起来」,而代码一个字都没错。
			args: ["pack", "-w", "--no-clean"],
			cwd: resolve(root, "extensions", id),
		})),
	];
}

/** 仓里哪些目录是拓展 —— **有清单才算**(`node_modules`、临时目录都会落在那底下)。 */
function repoExtensionIds(root) {
	try {
		return readdirSync(resolve(root, "extensions"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => {
				try {
					return readdirSync(join(resolve(root, "extensions"), name)).includes("extension.json");
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		return [];
	}
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

/**
 * 轮询到后端可连接为止。
 *
 * 🔴 `signal` 是**停机口**:后端起步的那 20 秒里按 Ctrl-C,子进程收到信号就退了,而这个
 * 轮询还在自己的 setTimeout 上睡着 —— runner 早已 resolve,node 的事件循环却被那串定时器
 * 吊着,终端要一直挂到 deadline 才回来。所以每一轮开头、以及睡觉那一下,都要认这个信号。
 */
export async function waitForHttpReachable(
	url,
	{
		timeoutMs = backendReadyTimeoutMs,
		intervalMs = backendReadyIntervalMs,
		fetchImpl = globalThis.fetch,
		sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
		signal,
	} = {},
) {
	if (typeof fetchImpl !== "function") throw new Error("global fetch is not available");
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() <= deadline) {
		if (signal?.aborted) throw new Error(`停止等待 ${url}(收到停机信号)`);
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), Math.min(intervalMs, 1_000));
			timer.unref?.();
			try {
				// 手里这一发也跟着停机信号走,不然最多还要等它自己那一秒。
				const tries = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
				await fetchImpl(url, { method: "GET", signal: tries });
			} finally {
				clearTimeout(timer);
			}
			return;
		} catch (err) {
			lastError = err;
			if (Date.now() >= deadline) break;
			await raceAbort(sleep(intervalMs), signal);
		}
	}
	const detail =
		lastError instanceof Error ? `: ${lastError.message}` : lastError ? `: ${lastError}` : "";
	throw new Error(`timed out waiting for ${url}${detail}`);
}

/** 等 `promise`,但停机信号一来就不等了(下一轮开头会把这件事变成一次 throw)。 */
function raceAbort(promise, signal) {
	if (!signal || signal.aborted) return promise;
	let onAbort;
	const aborted = new Promise((resolveAbort) => {
		onAbort = () => resolveAbort();
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([promise, aborted]).finally(() =>
		signal.removeEventListener("abort", onAbort),
	);
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
	groupPollMs = 100,
	probeGroupAlive = (child) => isProcessGroupAlive(child, processPlatform),
	sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
	const specs = createDevProcessSpecs(root);
	const children = [];
	/** 停机信号 —— 起步那段等后端的轮询靠它当场收手,见 `waitForHttpReachable`。 */
	const stopProbe = new AbortController();
	let intentionalStop = false;
	let requestedExitCode = 0;
	let settled = 0;
	let forceTimer;
	let forced = false;
	const statuses = new Map();

	return await new Promise((resolveRun) => {
		const cleanup = () => {
			process.off("SIGINT", onSigint);
			process.off("SIGTERM", onSigterm);
			process.off("SIGHUP", onSighup);
			if (forceTimer) clearTimeout(forceTimer);
		};

		const exitCodeNow = () => {
			if (intentionalStop) return requestedExitCode;
			const failed = [...statuses.values()].find((status) => !isCleanStatus(status, false));
			return failed ? statusToExitCode(failed) : 0;
		};

		// 🔴 直接子进程只是 `vp exec` 那层壳,它一收到信号就退;真正的 tsx / server / vite 在它
		// 下面,**同一个进程组里**,还在走优雅退出。壳退了就返回,等于把宽限期扔了 —— 组里谁
		// 卡住了都没人管,主人 Ctrl-C 之后 server 照跑。所以直接子进程全退之后,还要等每个
		// 进程组真的空了;宽限期到了还有人,整组 SIGKILL。
		const drainGroups = async () => {
			const alive = () => children.filter(({ child }) => probeGroupAlive(child));
			while (alive().length > 0 && !forced) await sleep(groupPollMs);
			if (!forced) return;
			// 已经下过 SIGKILL —— 再给一个宽限期让内核收尸,之后不再等(不能让停机挂死)。
			const deadline = Date.now() + graceMs;
			while (alive().length > 0 && Date.now() < deadline) await sleep(groupPollMs);
		};

		const finishIfDone = () => {
			if (settled < children.length) return;
			const exitCode = exitCodeNow();
			void drainGroups().then(() => {
				cleanup();
				resolveRun(exitCode);
			});
		};

		const stopAll = (reason, exitCode, signal = "SIGINT") => {
			if (!intentionalStop) log(`[dev:apps] ${reason}; stopping dev servers…`);
			intentionalStop = true;
			// 还在等后端的话,当场把轮询叫停:不然它的定时器会把进程吊到 deadline。
			stopProbe.abort();
			requestedExitCode = exitCode;
			for (const { child } of children) sendSignal(child, signal, processPlatform);
			if (!forceTimer) {
				forceTimer = setTimeout(() => {
					log(`[dev:apps] dev servers did not exit within ${graceMs}ms; force killing…`);
					forced = true;
					for (const { child } of children) sendSignal(child, "SIGKILL", processPlatform);
				}, graceMs);
				forceTimer.unref?.();
			}
		};

		const onSigint = () => stopAll("received SIGINT", 0, "SIGINT");
		const onSigterm = () => stopAll("received SIGTERM", 0, "SIGTERM");
		// 终端被关掉时 shell 发的是 SIGHUP;不接的话 runner 当场死、整棵树留成孤儿。
		const onSighup = () => stopAll("received SIGHUP", 0, "SIGTERM");
		process.on("SIGINT", onSigint);
		process.on("SIGTERM", onSigterm);
		process.on("SIGHUP", onSighup);

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
						signal: stopProbe.signal,
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

/**
 * 信号打给**整个进程组**,不只打给直接子进程:子进程是 `detached` 起的,自己就是组长,
 * 它退了组还可能在(tsx / server 都在它底下)。所以这里**不**按「子进程已退出」短路。
 */
function sendSignal(child, signal, processPlatform = platform) {
	if (processPlatform === "win32" && child.pid) {
		if (child.exitCode !== null || child.signalCode !== null) return;
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
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill(signal);
		} catch (fallbackErr) {
			if (fallbackErr?.code !== "ESRCH") throw fallbackErr;
		}
	}
}

/** 这个子进程的进程组里还有没有活人 —— `kill(-pgid, 0)` 只探不打。 */
export function isProcessGroupAlive(child, processPlatform = platform) {
	// Windows 没有进程组,taskkill /T 已经把整棵树带走了。
	if (processPlatform === "win32" || !child.pid) return false;
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (err) {
		// EPERM = 组里有人、只是不归我们管;当活着算。
		return err?.code === "EPERM";
	}
}

function killWindowsProcessTree(pid) {
	const [command, args] = buildWindowsTreeKillArgs(pid);
	const result = spawnSync(command, args, { stdio: "ignore" });
	if (result.error && result.error.code !== "ENOENT") throw result.error;
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
	// 终端没了之后往 stdout / stderr 写会 EIO;不接住的话 runner 会在收摊半路上炸掉。
	for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
	process.exitCode = await runDevApps();
}
