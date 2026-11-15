import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";

const execute = promisify(execFile);
const script = fileURLToPath(
	new URL("../../.claude/skills/verify-ui/scripts/dev.sh", import.meta.url),
);
const repo = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const curl = execFileSync("bash", ["-c", "command -v curl"], { encoding: "utf8" }).trim();
const cleanups = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(respond, commands = {}) {
	const dir = await mkdtemp(join(tmpdir(), "bn-verify-ui-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const bin = join(dir, "bin");
	await mkdir(bin);
	const server = createServer(respond);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});
	// Keep real curl/HTTP semantics, but route the helper's fixed ports to this test's server.
	const adapter = join(bin, "curl");
	await writeFile(
		adapter,
		`#!/usr/bin/env bash
args=()
for arg in "$@"; do
  case "$arg" in
    http://localhost:1421/*) args+=("$BN_UI_TEST_ORIGIN/launcher/\${arg#http://localhost:1421/}") ;;
    http://localhost:5173/*) args+=("$BN_UI_TEST_ORIGIN/web/\${arg#http://localhost:5173/}") ;;
    http://127.0.0.1:8787/*) args+=("$BN_UI_TEST_ORIGIN/backend/\${arg#http://127.0.0.1:8787/}") ;;
    *) args+=("$arg") ;;
  esac
done
exec "$BN_UI_TEST_CURL" --noproxy '*' "\${args[@]}"
`,
	);
	await chmod(adapter, 0o755);
	for (const [name, body] of Object.entries({
		lsof: "exit 1",
		pgrep: "exit 1",
		ps: "echo 999991",
		...commands,
	})) {
		const path = join(bin, name);
		await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
		await chmod(path, 0o755);
	}
	// stop tests cannot signal real processes, even if a fixture accidentally reports a real PID.
	const bashEnv = join(dir, "bash-env");
	const signals = join(dir, "signals");
	await writeFile(signals, "");
	// 超时与重试仍走脚本自己的 SECONDS 判据，只在 sleep 边界推进时钟；curl 保留真实超时。
	await writeFile(
		bashEnv,
		`kill() { printf "%s\\n" "$*" >> "$BN_UI_TEST_SIGNALS"; }
sleep() { SECONDS=$((SECONDS + $1)); }
`,
	);
	return async (...args) => {
		const options = {
			cwd: dir,
			encoding: "utf8",
			timeout: args[0] === "stop" ? 18000 : 4000,
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				BASH_ENV: bashEnv,
				BN_UI_TEST_CURL: curl,
				BN_UI_TEST_REPO: repo,
				BN_UI_TEST_SIGNALS: signals,
				BN_UI_TEST_ORIGIN: `http://127.0.0.1:${server.address().port}`,
			},
		};
		let result;
		try {
			result = { ...(await execute("bash", [script, ...args], options)), status: 0 };
		} catch (error) {
			result = {
				stdout: error.stdout,
				stderr: error.stderr,
				status: error.code,
				signal: error.signal,
			};
		}
		return { ...result, signals: await readFile(signals, "utf8") };
	};
}

describe("verify-ui dev helper", () => {
	it.each([302, 401, 404, 503])(
		"wait rejects HTTP %s instead of reporting ready",
		async (status) => {
			const run = await fixture((_request, response) => {
				response.writeHead(status).end("not ready");
			});
			const result = await run("wait", "desktop", "1");
			expect(result.status, result.stderr).toBe(1);
			expect(result.stdout).not.toContain("ready:");
			expect(result.stderr).toContain(`HTTP ${status}`);
		},
	);

	it("wait succeeds once a temporarily unavailable launcher recovers", async () => {
		let ready = false;
		const run = await fixture((_request, response) => {
			response.writeHead(ready ? 200 : 503).end();
			ready = true;
		});
		const result = await run("wait", "desktop", "3");
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("ready: launcher 1421");
	});

	it.each(["/backend/api/health", "/web/"])(
		"web wait requires a successful response from %s",
		async (unavailable) => {
			const run = await fixture((request, response) => {
				response.writeHead(request.url === unavailable ? 503 : 200).end();
			});
			const result = await run("wait", "web", "1");
			expect(result.status, result.stderr).toBe(1);
			expect(result.stdout).not.toContain("ready:");
		},
	);

	it("web wait reports session information while tolerating absent optional devtools", async () => {
		const run = await fixture((request, response) => {
			if (request.url === "/web/api/dev") response.writeHead(404).end();
			else if (request.url === "/web/api/session") response.end('{"authenticated":false}');
			else response.writeHead(200).end();
		});
		const result = await run("wait", "web", "1");
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain('ready: session={"authenticated":false} /api/dev=404');
	});

	it("wait fails within its limit when the connection never responds", async () => {
		const run = await fixture(() => {});
		const result = await run("wait", "desktop", "1");
		expect(result.status, result.stderr).toBe(1);
		expect(result.signal).toBeNull();
		expect(result.stdout).not.toContain("ready:");
		expect(result.stderr).toContain("curl exit 28");
	});

	it("wait rejects an invalid deadline without reporting ready", async () => {
		const run = await fixture((_request, response) => response.end());
		const result = await run("wait", "desktop", "0");
		expect(result.status, result.stderr).toBe(2);
		expect(result.stdout).not.toContain("ready:");
	});

	it("status treats lsof's empty no-match result as a free port", async () => {
		const run = await fixture((_request, response) => response.end());
		const result = await run("status");
		expect(result.status, result.stderr).toBe(0);
		for (const port of [8787, 5173, 1421]) expect(result.stdout).toContain(`port ${port}: free`);
	});

	it("status preserves a port inspection failure instead of reporting free", async () => {
		const run = await fixture((_request, response) => response.end(), {
			lsof: 'echo "lsof: permission denied" >&2; exit 1',
		});
		const result = await run("status");
		expect(result.status, result.stderr).toBe(1);
		expect(result.stdout).not.toContain(": free");
		expect(result.stderr).toContain("permission denied");
	});

	it("status recognizes a listener in this repository", async () => {
		const run = await fixture((_request, response) => response.end(), {
			lsof: `case "$*" in
  *"-d cwd"*) printf 'p999991\\nfcwd\\nn%s\\n' "$BN_UI_TEST_REPO/apps/web" ;;
  *) echo 999991 ;;
esac`,
		});
		const result = await run("status");
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(`pid 999991 (this-repo) cwd=${repo}/apps/web`);
	});

	it("status reports unknown when the inspection tool is unavailable", async () => {
		const run = await fixture((_request, response) => response.end(), {
			lsof: 'echo "lsof: command not found" >&2; exit 127',
		});
		const result = await run("status");
		expect(result.status, result.stderr).toBe(1);
		expect(result.stdout).not.toContain(": free");
		expect(result.stderr).toContain("command not found");
	});

	it("status reports unknown ownership when the process directory cannot be inspected", async () => {
		const run = await fixture((_request, response) => response.end(), {
			lsof: `case "$*" in
  *"-d cwd"*) echo "lsof: cwd permission denied" >&2; exit 1 ;;
  *) echo 999991 ;;
esac`,
		});
		const result = await run("status");
		expect(result.status, result.stderr).toBe(1);
		expect(result.stdout).toContain("pid 999991 (unknown)");
		expect(result.stderr).toContain("cwd permission denied");
	});

	it("stop preserves listeners that belong to another repository", async () => {
		const run = await fixture((_request, response) => response.end(), {
			lsof: `case "$*" in
  *"-d cwd"*) printf 'p999991\\nfcwd\\nn/foreign-project\\n' ;;
  *) echo 999991 ;;
esac`,
		});
		const result = await run("stop");
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("pid 999991 (foreign) cwd=/foreign-project");
		expect(result.signals).toBe("");
	});

	it("stop fails when a port probe fails even if later probes could succeed", async () => {
		const run = await fixture((_request, response) => response.end(), {
			lsof: `if [[ ! -f probe-failed ]]; then
  touch probe-failed
  echo "lsof: permission denied" >&2
fi
exit 1`,
		});
		const result = await run("stop");
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("permission denied");
		expect(result.signals).toBe("");
	});

	it("stop fails without signaling when process ownership cannot be determined", async () => {
		const run = await fixture((_request, response) => response.end(), {
			lsof: `case "$*" in
  *"-d cwd"*) echo "lsof: cwd permission denied" >&2; exit 1 ;;
  *) echo 999991 ;;
esac`,
		});
		const result = await run("stop");
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("cwd permission denied");
		expect(result.signals).toBe("");
	});

	it("stop rejects a failed runner search rather than treating it as no runners", async () => {
		const run = await fixture((_request, response) => response.end(), {
			pgrep: 'echo "pgrep: operation not permitted" >&2; exit 3',
		});
		const result = await run("stop");
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("operation not permitted");
		expect(result.signals).toBe("");
	});

	it("stop succeeds after its listener releases the ports", async () => {
		const run = await fixture((_request, response) => response.end(), {
			lsof: `[[ -s "$BN_UI_TEST_SIGNALS" ]] && exit 1
case "$*" in
  *"-d cwd"*) printf 'p999991\\nfcwd\\nn%s\\n' "$BN_UI_TEST_REPO/apps/web" ;;
  *) echo 999991 ;;
esac`,
		});
		const result = await run("stop");
		expect(result.status, result.stderr).toBe(0);
		expect(result.signals).toContain("-TERM -999991");
		for (const port of [8787, 5173, 1421]) expect(result.stdout).toContain(`port ${port}: free`);
	});

	it("stop preserves an inspection failure while waiting for a signaled listener to exit", async () => {
		const run = await fixture((_request, response) => response.end(), {
			lsof: `case "$*" in
  *"-d cwd"*) printf 'p999991\\nfcwd\\nn%s\\n' "$BN_UI_TEST_REPO/apps/web" ;;
  *"-iTCP:8787"*)
    if [[ -s "$BN_UI_TEST_SIGNALS" ]]; then echo "lsof: permission denied" >&2; exit 1; fi
    echo 999991 ;;
  *) exit 1 ;;
esac`,
		});
		const result = await run("stop");
		expect(result.status, result.stderr).toBe(1);
		expect(result.signals).toContain("-TERM -999991");
		expect(result.stdout).toContain("port 8787: unknown");
		expect(result.stderr).toContain("permission denied");
	});

	it("stop fails when its listener remains after the shutdown deadline", async () => {
		const run = await fixture((_request, response) => response.end(), {
			lsof: `case "$*" in
  *"-d cwd"*) printf 'p999991\\nfcwd\\nn%s\\n' "$BN_UI_TEST_REPO/apps/web" ;;
  *) echo 999991 ;;
esac`,
		});
		const result = await run("stop");
		expect(result.status, result.stderr).toBe(1);
		expect(result.signals).toContain("-TERM -999991");
		expect(result.stderr).toContain("未能确认本仓开发进程已停止");
	}, 20000);
});
