import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { run } from "./process";

/** 本地/CI共用commitlint配置；无from（含新分支零SHA）时连首条提交也检查。 */
export function checkProjectCommits(args: string[] = [], root = process.cwd()): void {
	const { values } = parseArgs({
		args,
		options: { from: { type: "string" }, to: { type: "string" } },
	});
	const head = values.to ?? "HEAD";
	const from = values.from;
	for (const ref of [head, from])
		if (ref && ref !== "HEAD" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref))
			throw new Error("Commit range must use HEAD or full commit hashes.");
	const env = { ...process.env };
	delete env.GITHUB_TOKEN;
	delete env.GH_TOKEN;
	if (from && !/^0+$/.test(from)) {
		run("vp", ["exec", "commitlint", "--from", from, "--to", head, "--verbose"], root, env);
		return;
	}
	const git = (...argv: string[]) =>
		execFileSync("git", argv, { cwd: root, encoding: "utf8", env }).trim();
	const first = git("rev-list", "--max-parents=0", head).split("\n")[0];
	if (!first) throw new Error("Commit the project before checking a release.");
	const message = git("show", "-s", "--format=%B", first);
	const checked = spawnSync("vp", ["exec", "commitlint", "--verbose"], {
		cwd: root,
		env,
		input: message,
		stdio: ["pipe", "inherit", "inherit"],
	});
	if (checked.error) throw checked.error;
	if (checked.status !== 0) throw new Error("Commit message validation failed.");
	run("vp", ["exec", "commitlint", "--from", first, "--to", head, "--verbose"], root, env);
}
