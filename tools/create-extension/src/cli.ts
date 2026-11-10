#!/usr/bin/env node
import { checkProjectCommits } from "./commits";
import { packProject } from "./pack";
import { enableProjectHooks } from "./process";
import { releaseProject } from "./release";

async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (!command || command === "--help" || command === "-h") {
		console.log(
			"bn-extension pack | hooks | check-commits [--from <sha>] [--to <sha>] | release --tag v<version> [--dry-run]",
		);
		return;
	}
	if (command === "check-commits") {
		checkProjectCommits(args);
		return;
	}
	if (command === "release") {
		console.log(JSON.stringify(await releaseProject(args)));
		return;
	}
	if (command === "hooks" && args.length === 0) {
		enableProjectHooks();
		return;
	}
	if (command !== "pack" || args.length > 0)
		throw new Error("Unknown command. Run bn-extension --help.");
	console.log(JSON.stringify(await packProject()));
}

main().catch((error: unknown) => {
	console.error(`bn-extension: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
