import { cp, readFile, writeFile } from "node:fs/promises";

const pkgRoot = new URL("../", import.meta.url);
const source = JSON.parse(await readFile(new URL("package.json", pkgRoot), "utf8"));
const {
	private: _private,
	scripts: _scripts,
	dependencies: _dependencies,
	devDependencies: _devDependencies,
	publishConfig: _publishConfig,
	...published
} = source;
published.dependencies = {
	"@voidzero-dev/vite-plus-core": source.dependencies["@voidzero-dev/vite-plus-core"],
};
published.scripts = { prepublishOnly: "node verify-release.mjs" };
published.bin = { bn: "cli.mjs" };
published.files = ["*.mjs", "runtime.json", "runtimes/*.zip", "README.md", "LICENSE"];
published.publishConfig = { access: "public" };
await writeFile(new URL("lib/package.json", pkgRoot), `${JSON.stringify(published, null, 2)}\n`);
await cp(new URL("README.md", pkgRoot), new URL("lib/README.md", pkgRoot));
await cp(new URL("../../LICENSE", pkgRoot), new URL("lib/LICENSE", pkgRoot));
const catalog = { schemaVersion: 1, runtimes: {} };
await writeFile(new URL("lib/runtime.json", pkgRoot), `${JSON.stringify(catalog, null, 2)}\n`);
await cp(
	new URL("scripts/verify-release.mjs", pkgRoot),
	new URL("lib/verify-release.mjs", pkgRoot),
);
