import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vite-plus/test";
import launcherMessages from "../../apps/desktop/src-tauri/locales/zh-CN.json" with {
	type: "json",
};
import { readDesktopLayoutFile, repoRoot } from "../desktop-layout.mjs";

async function stopFixture(app, exited) {
	if (!app?.pid) return;
	try {
		process.kill(-app.pid, "SIGTERM");
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
	await exited;
}

// Opt in on a macOS machine with a GUI session. Exercise the real launcher, bundle layout,
// child monitor and health deadline. A separate bundle identifier isolates single-instance IPC.
it.runIf(process.platform === "darwin" && process.env.BN_DESKTOP_LIFECYCLE === "1")(
	"a stale startup timeout cannot stop the replacement sidecar",
	async () => {
		// Tauri requires a canonical executable path on macOS, including its parent directories.
		const dir = await mkdtemp(join(await realpath(tmpdir()), "bn-native-lifecycle-"));
		const id = `moe.bn.lifecycle.p${process.pid}`;
		const layout = readDesktopLayoutFile();
		let app;
		let exited;
		let stderr = "";
		const logs = join(dir, "Library/Logs/bilibili-notify/launcher");
		try {
			const manifest = join(repoRoot, "apps/desktop/src-tauri/Cargo.toml");
			const output = execFileSync(
				"cargo",
				["build", "--locked", "--manifest-path", manifest, "--message-format=json"],
				{
					env: { ...process.env, TAURI_CONFIG: JSON.stringify({ identifier: id }) },
					encoding: "utf8",
					maxBuffer: 16 * 1024 * 1024,
				},
			);
			const binary = output
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.find(
					(line) => line.target?.name === "bilibili-notify-desktop" && line.executable,
				)?.executable;
			const contents = join(dir, "Fixture.app/Contents");
			const resources = join(contents, "Resources/resources");
			const node = join(resources, layout.nodeBinary.macos);
			const bin = join(contents, "MacOS/launcher");
			const lib = join(resources, layout.serverDir, layout.libDir);
			await mkdir(join(contents, "MacOS"), { recursive: true });
			await mkdir(dirname(node), { recursive: true });
			await mkdir(join(lib, layout.webDistDir), { recursive: true });
			await writeFile(
				join(contents, "Info.plist"),
				`<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>launcher</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`,
			);
			await copyFile(binary, bin);
			await symlink(process.execPath, node);
			await writeFile(join(lib, layout.webDistDir, "index.html"), "fixture");
			await writeFile(
				join(lib, layout.entry),
				`import {createServer} from "node:http";
import {existsSync, writeFileSync} from "node:fs";
import {join} from "node:path";
const file = join(process.env.LIFECYCLE_FIXTURE, "child");
if (!existsSync(file)) { writeFileSync(file, "first"); process.exit(0); }
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = createServer((_req, res) => res.end(String(process.pid)));
server.listen(port, "127.0.0.1", () => writeFileSync(file, JSON.stringify({ port, pid: process.pid })));
`,
			);
			app = spawn(bin, [], {
				cwd: dir,
				env: { ...process.env, HOME: dir, LIFECYCLE_FIXTURE: dir },
				detached: true,
				stdio: ["ignore", "ignore", "pipe"],
			});
			app.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			exited = once(app, "exit");
			await expect
				.poll(
					async () => {
						try {
							return JSON.parse(await readFile(join(dir, "child"), "utf8"));
						} catch {
							return null;
						}
					},
					{ timeout: 20000 },
				)
				.not.toBeNull();
			const replacement = JSON.parse(await readFile(join(dir, "child"), "utf8"));
			const health = async () =>
				(await fetch(`http://127.0.0.1:${replacement.port}/api/health`)).text();
			expect(await health()).toBe(String(replacement.pid));
			await delay(32_000);
			expect(await health()).toBe(String(replacement.pid));
			const lifecycle = await readFile(join(logs, "launcher.log"), "utf8");
			expect(lifecycle).toContain(launcherMessages["log.desktop.sidecarReady"]);
			expect(lifecycle).not.toContain(launcherMessages["log.desktop.sidecarStartFailed"]);
		} catch (cause) {
			const diagnostic = await readFile(join(logs, "launcher.log"), "utf8").catch(() => "");
			const childError = await readFile(join(logs, "sidecar.stderr.log"), "utf8").catch(() => "");
			throw new Error(
				`Native fixture exited=${app?.exitCode} signal=${app?.signalCode}: ${stderr}\n${diagnostic}\n${childError}`,
				{ cause },
			);
		} finally {
			await stopFixture(app, exited);
			await rm(dir, { recursive: true, force: true });
			await rm(join("/tmp", `${id.replaceAll(".", "_")}_si.sock`), { force: true });
		}
	},
	180000,
);
