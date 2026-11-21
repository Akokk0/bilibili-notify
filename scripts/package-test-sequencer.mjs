import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BaseSequencer } from "vite-plus/test/node";

export class PackageTestSequencer extends BaseSequencer {
	async shard(files) {
		const selected = await super.shard(files);
		const cacheScript = process.env.BN_PACKAGE_TEST_CACHE_SCRIPT;
		if (
			cacheScript &&
			selected.some(({ moduleId }) => readFileSync(moduleId, "utf8").includes("--offline"))
		) {
			execFileSync("bash", [cacheScript], {
				cwd: this.ctx.config.root,
				stdio: "inherit",
			});
		}
		return selected;
	}

	async sort(files) {
		const sorted = await super.sort(files);
		if (!this.ctx.config.shard) return sorted;
		const root = this.ctx.config.root;
		const releaseTest = resolve(root, "scripts/__tests__/extension-project-release.test.mjs");
		const index = sorted.findIndex(({ moduleId }) => resolve(root, moduleId) === releaseTest);
		if (index > 0) {
			const [release] = sorted.splice(index, 1);
			sorted.unshift(release);
		}
		return sorted;
	}
}
