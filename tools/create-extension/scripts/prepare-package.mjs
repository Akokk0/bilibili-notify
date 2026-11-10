import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const root = new URL("../../../", import.meta.url);
const pkgRoot = new URL("../", import.meta.url);
const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
const manifest = await readJson(new URL("package.json", pkgRoot));
const rootManifest = await readJson(new URL("package.json", root));
const sdk = await readJson(new URL("packages/extension/package.json", root));
const require = createRequire(new URL("package.json", root));
const sdkRequire = createRequire(new URL("packages/extension/package.json", root));
const version = (name, from = require) => from(`${name}/package.json`).version;
const versions = {
	tools: manifest.version,
	sdk: sdk.version,
	vitePlus: version("vite-plus"),
	typescript: version("typescript"),
	nodeTypes: version("@types/node"),
	zod: version("zod", sdkRequire),
	commitlint: version("@commitlint/cli"),
	commitlintConfig: version("@commitlint/config-conventional"),
	packageManager: rootManifest.packageManager,
	node: (await readFile(new URL(".node-version", root), "utf8")).trim(),
};
await mkdir(new URL("lib/", pkgRoot), { recursive: true });
await cp(new URL("templates/", pkgRoot), new URL("lib/templates/", pkgRoot), { recursive: true });
await writeFile(new URL("lib/versions.json", pkgRoot), `${JSON.stringify(versions, null, 2)}\n`);
const {
	private: _private,
	scripts: _scripts,
	dependencies: _dependencies,
	devDependencies: _devDependencies,
	publishConfig: _publishConfig,
	...published
} = manifest;
published.bin = Object.fromEntries(
	Object.entries(manifest.bin).map(([name, path]) => [name, path.replace(/^lib\//, "")]),
);
published.files = ["*.mjs", "versions.json", "templates", "README.md", "LICENSE"];
published.publishConfig = { access: "public" };
await writeFile(new URL("lib/package.json", pkgRoot), `${JSON.stringify(published, null, 2)}\n`);
await cp(new URL("README.md", pkgRoot), new URL("lib/README.md", pkgRoot));
await cp(new URL("LICENSE", root), new URL("lib/LICENSE", pkgRoot));
