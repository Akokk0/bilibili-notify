import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** 所有本地工程命令都经vp；不把用户输入拼进shell。 */
export function run(command: string, args: string[], cwd: string, env = process.env): void {
	const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

/** Git会向上寻找仓库；未初始化的子工程不能借此改掉外层的hooks。 */
export function enableProjectHooks(): void {
	const cwd = process.cwd();
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
	if (result.status !== 0 || realpathSync(result.stdout.trim()) !== realpathSync(cwd)) {
		console.log(
			"Skipped hooks: initialize this project as its own Git repository, then run vp hooks enable.",
		);
		return;
	}
	run("vp", ["hooks", "enable"], cwd);
}
