import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shouldCopyPath } from "./prepare-resources.mjs";

const source = "/runtime-package";

function shouldCopyRuntimePath(rel) {
	return shouldCopyPath(source, join(source, rel), { runtimePackage: true });
}

describe("prepare-resources runtime package pruning", () => {
	it("keeps runtime entrypoints and package metadata", () => {
		expect(shouldCopyRuntimePath("package.json")).toBe(true);
		expect(shouldCopyRuntimePath("lib/index.js")).toBe(true);
		expect(shouldCopyRuntimePath("LICENSE")).toBe(true);
	});

	it("drops package manager internals and generated caches", () => {
		expect(shouldCopyRuntimePath("node_modules/nested/package.json")).toBe(false);
		expect(shouldCopyRuntimePath("coverage/lcov.info")).toBe(false);
		expect(shouldCopyRuntimePath(".vite/deps/chunk.js")).toBe(false);
	});

	it("drops top-level docs, examples, fixtures, and test directories", () => {
		expect(shouldCopyRuntimePath("docs/api.md")).toBe(false);
		expect(shouldCopyRuntimePath("examples/demo.js")).toBe(false);
		expect(shouldCopyRuntimePath("fixtures/sample.json")).toBe(false);
		expect(shouldCopyRuntimePath("__tests__/index.test.js")).toBe(false);
	});

	it("keeps nested doc directories that can be imported at runtime", () => {
		expect(shouldCopyRuntimePath("dist/doc/directives.js")).toBe(true);
	});

	it("drops non-runtime test, source-map, and tool config files", () => {
		expect(shouldCopyRuntimePath("lib/index.test.js")).toBe(false);
		expect(shouldCopyRuntimePath("lib/index.spec.ts")).toBe(false);
		expect(shouldCopyRuntimePath("lib/index.js.map")).toBe(false);
		expect(shouldCopyRuntimePath("tsconfig.json")).toBe(false);
		expect(shouldCopyRuntimePath("vitest.config.ts")).toBe(false);
		expect(shouldCopyRuntimePath("pnpm-lock.yaml")).toBe(false);
	});
});
