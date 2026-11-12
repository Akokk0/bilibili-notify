import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	checkMarketplaceIndex,
	extensionNamespaceOf,
	type MarketplaceEntry,
	type MarketplaceIndex,
	MarketplaceIndexSchema,
	parseExtensionManifest,
} from "@bilibili-notify/internal";
import { z } from "zod";
import { compareEntryVersions } from "../../../scripts/extension-version-order.mjs";

export const MARKETPLACE_CONFIG_PATH = "bn-extension/marketplace.json";

const ConfigSchema = MarketplaceIndexSchema.pick({ name: true, namespace: true, owner: true })
	.required({ namespace: true, owner: true })
	.extend({ schemaVersion: z.literal(1) })
	.strict();

export type MarketplaceConfig = z.infer<typeof ConfigSchema>;

export function readMarketplace(raw: unknown, config: MarketplaceConfig): MarketplaceIndex {
	const index = MarketplaceIndexSchema.parse(raw);
	const checked = checkMarketplaceIndex(index, { official: false });
	if (!checked.ok) throw new Error(checked.message);
	if (index.namespace !== config.namespace)
		throw new Error("Existing marketplace namespace does not match this project.");
	return index;
}

export function nextMarketplace(
	config: MarketplaceConfig,
	entry: MarketplaceEntry,
	current?: MarketplaceIndex,
): MarketplaceIndex {
	if (current?.revoked?.includes(`${entry.id}@${entry.version}`))
		throw new Error("This version was revoked; use a new version.");
	const extensions = [...(current?.extensions ?? [])];
	const slot = extensions.findIndex(
		(old) =>
			old.id === entry.id &&
			old.apiVersion === entry.apiVersion &&
			(old.prerelease === true) === (entry.prerelease === true),
	);
	if (slot < 0) extensions.push(entry);
	else {
		const old = extensions[slot] as MarketplaceEntry;
		const order = compareEntryVersions(entry.version, old.version);
		if (
			order === 0 &&
			(old.package.sha256 !== entry.package.sha256 || old.package.size !== entry.package.size)
		)
			throw new Error("This indexed version has different bytes; use a new version.");
		if (order >= 0) extensions[slot] = entry;
	}
	extensions.sort((a, b) =>
		a.id < b.id
			? -1
			: a.id > b.id
				? 1
				: a.apiVersion - b.apiVersion ||
					Number(a.prerelease === true) - Number(b.prerelease === true),
	);
	const index = readMarketplace(
		{ ...current, name: config.name, namespace: config.namespace, owner: config.owner, extensions },
		config,
	);
	if (
		current &&
		JSON.stringify({ ...index, issuedAt: 0 }) === JSON.stringify({ ...current, issuedAt: 0 })
	)
		return current;
	return {
		...index,
		issuedAt: Math.max(Math.floor(Date.now() / 1000), (current?.issuedAt ?? 0) + 1),
	};
}

export async function readProject(root: string) {
	const configText = await readFile(join(root, MARKETPLACE_CONFIG_PATH), "utf8").catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			throw new Error(
				`Missing ${MARKETPLACE_CONFIG_PATH}. To upgrade an older project, move .bn/marketplace.json there and remove its repository field.`,
			);
		},
	);
	const config = ConfigSchema.parse(JSON.parse(configText));
	const parsed = parseExtensionManifest(
		JSON.parse(await readFile(join(root, "extension.json"), "utf8")),
	);
	if (!parsed.ok) throw new Error(parsed.message);
	if (extensionNamespaceOf(parsed.manifest.id) !== config.namespace)
		throw new Error(`The manifest id must use the namespace in ${MARKETPLACE_CONFIG_PATH}.`);
	return { config, manifest: parsed.manifest };
}
