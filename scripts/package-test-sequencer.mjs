import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BaseSequencer } from "vite-plus/test/node";

export class PackageTestSequencer extends BaseSequencer {
	async shard(files) {
		const selected = await super.shard(files);
		if (selected.some(({ moduleId }) => readFileSync(moduleId, "utf8").includes("--offline"))) {
			execFileSync("bash", [process.env.BN_PACKAGE_TEST_CACHE_SCRIPT], {
				cwd: this.ctx.config.root,
				stdio: "inherit",
			});
		}
		return selected;
	}
}
