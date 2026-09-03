import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolveNodePackageFromShasums } from "./prepare-resources.mjs";

const darwinArm64Target = {
	kind: "tar.gz",
	label: "darwin-arm64",
	filePattern: "node-v24\\.15\\.0-darwin-arm64\\.tar\\.gz",
	nodePath: (dir) => join(dir, "bin", "node"),
};

describe("prepare-resources pinned Node runtime", () => {
	it("resolves the exact pinned Node archive instead of a floating latest line", () => {
		const sha = "a".repeat(64);
		const result = resolveNodePackageFromShasums(
			`${"b".repeat(64)}  node-v24.16.0-darwin-arm64.tar.gz\n${sha}  node-v24.15.0-darwin-arm64.tar.gz\n`,
			darwinArm64Target,
			"https://nodejs.org/dist/v24.15.0",
		);

		expect(result.version).toBe("24.15.0");
		expect(result.sha256).toBe(sha);
		expect(result.fileName).toBe("node-v24.15.0-darwin-arm64.tar.gz");
		expect(result.url).toBe("https://nodejs.org/dist/v24.15.0/node-v24.15.0-darwin-arm64.tar.gz");
	});
});
