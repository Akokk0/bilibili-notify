import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
	ExtensionVersionSchema,
	MARKETPLACE_INDEX_ASSET,
	MARKETPLACE_RELEASE_TAG,
	MarketplaceEntrySchema,
} from "@bilibili-notify/internal";
import { checkProjectCommits } from "./commits";
import { GithubApi } from "./github";
import { nextMarketplace, readMarketplace, readProject } from "./marketplace";
import { packProject } from "./pack";
import { run } from "./process";

export async function releaseProject(args: string[], root = process.cwd()) {
	const { values } = parseArgs({
		args,
		options: {
			tag: { type: "string" },
			"dry-run": { type: "boolean" },
			"api-base": { type: "string" },
		},
	});
	const { config, manifest } = await readProject(root);
	const tag = values.tag;
	if (
		!tag?.startsWith("v") ||
		!ExtensionVersionSchema.safeParse(tag.slice(1)).success ||
		tag !== `v${manifest.version}`
	)
		throw new Error("The v<version> tag must match extension.json's version.");
	if (
		process.env.GITHUB_REPOSITORY &&
		process.env.GITHUB_REPOSITORY.toLowerCase() !== config.repository
	)
		throw new Error("GITHUB_REPOSITORY does not match .bn/marketplace.json.");
	checkProjectCommits([], root);
	const verificationEnv = { ...process.env };
	delete verificationEnv.GITHUB_TOKEN;
	delete verificationEnv.GH_TOKEN;
	run("vp", ["run", "verify"], root, verificationEnv);
	const artifact = await packProject(root);
	if (artifact.manifest.id !== manifest.id || artifact.manifest.version !== manifest.version)
		throw new Error("Built manifest does not match the root manifest.");
	const entry = MarketplaceEntrySchema.parse({
		id: manifest.id,
		name: manifest.name,
		description: manifest.description ?? "",
		version: manifest.version,
		apiVersion: manifest.apiVersion,
		...(manifest.apiRevision === undefined ? {} : { apiRevision: manifest.apiRevision }),
		prerelease: manifest.version.includes("-"),
		package: {
			url: `https://github.com/${config.repository}/releases/download/${tag}/${basename(artifact.path)}`,
			sha256: artifact.sha256,
			size: artifact.size,
		},
		releaseUrl: `https://github.com/${config.repository}/releases/tag/${tag}`,
	});
	await writeFile(
		join(root, "artifacts/marketplace-entry.json"),
		`${JSON.stringify(entry, null, 2)}\n`,
	);
	const preview = {
		tag,
		artifact: { path: artifact.path, sha256: artifact.sha256, size: artifact.size },
		entry,
	};
	if (values["dry-run"]) return { dryRun: true, ...preview };
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (!token) throw new Error("Set GITHUB_TOKEN (contents: write) to publish, or use --dry-run.");
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	if (git("status", "--porcelain")) throw new Error("Commit project changes before publishing.");
	const head = git("rev-parse", "HEAD");
	if (git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`) !== head)
		throw new Error("The local tag must point to the checked-out commit.");
	const api = new GithubApi(config.repository, token, values["api-base"]);
	await api.assertTag(tag, head);
	let rolling = await api.findRelease(MARKETPLACE_RELEASE_TAG);
	if (rolling?.immutable) throw new Error("The rolling marketplace release must remain mutable.");
	const currentAsset =
		rolling?.assets.find((asset) => asset.name === MARKETPLACE_INDEX_ASSET) ??
		rolling?.assets.find((asset) => asset.name === "marketplace.previous.json");
	const current = currentAsset
		? readMarketplace(
				JSON.parse(Buffer.from(await api.readAsset(currentAsset)).toString("utf8")),
				config,
			)
		: undefined;
	const index = nextMarketplace(config, entry, current);
	await writeFile(join(root, "artifacts/marketplace.json"), `${JSON.stringify(index, null, 2)}\n`);
	let version = await api.findRelease(tag);
	version ??= await api.createRelease(tag, head, true, entry.prerelease === true);
	await api.ensureAsset(version, basename(artifact.path), await readFile(artifact.path));
	await api.ensureAsset(
		version,
		`${basename(artifact.path)}.sha256`,
		await readFile(`${artifact.path}.sha256`),
	);
	if (version.draft) await api.publish(version);
	if (
		index !== current ||
		!rolling?.assets.some((asset) => asset.name === MARKETPLACE_INDEX_ASSET)
	) {
		rolling ??= await api.createRelease(MARKETPLACE_RELEASE_TAG, head, true, true);
		await api.writeIndex(rolling, Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
	} else if (rolling.draft) {
		// 附件已就位但上次公开草稿失败；相同索引仍须完成公开，不能误报成功。
		await api.publish(rolling);
	}
	return {
		dryRun: false,
		...preview,
		marketplace: `https://github.com/${config.repository}/releases/download/${MARKETPLACE_RELEASE_TAG}/${MARKETPLACE_INDEX_ASSET}`,
	};
}
