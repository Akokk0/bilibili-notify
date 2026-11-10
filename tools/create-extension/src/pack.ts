import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseExtensionManifest } from "@bilibili-notify/internal";
import { packExtension } from "../../../scripts/extension-package-files.mjs";
import { extensionAssetName } from "../../../scripts/release-urls.mjs";

export async function packProject(root = process.cwd()) {
	const dist = join(root, "dist");
	const files: Record<string, Uint8Array> = {};
	for (const name of ["extension.json", "index.mjs"])
		files[name] = await readFile(join(dist, name));
	for (const name of ["README.md", "CHANGELOG.md"]) {
		try {
			files[name] = await readFile(join(root, name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	try {
		for (const name of await readdir(join(dist, "locales")))
			files[`locales/${name}`] = await readFile(join(dist, "locales", name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const parsed = parseExtensionManifest(
		JSON.parse(Buffer.from(files["extension.json"] as Uint8Array).toString("utf8")),
	);
	if (!parsed.ok) throw new Error(parsed.message);
	const { manifest } = parsed;
	const { zip, sha256, size } = packExtension(files);
	const path = resolve(root, "artifacts", extensionAssetName(manifest.id, manifest.version));
	await mkdir(join(root, "artifacts"), { recursive: true });
	await writeFile(path, zip);
	await writeFile(
		`${path}.sha256`,
		`${sha256}  ${extensionAssetName(manifest.id, manifest.version)}\n`,
	);
	return { path, sha256, size, manifest };
}
