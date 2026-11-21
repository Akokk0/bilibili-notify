import { readFileSync } from "node:fs";
import { compareVersions } from "../apps/server/src/update/version-order.ts";

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function readManifest(path) {
	const envelope = JSON.parse(readFileSync(path, "utf8"));
	const manifest = JSON.parse(envelope.manifest);
	const revoked = manifest.revoked ?? [];
	if (
		typeof envelope.signature !== "string" ||
		!envelope.signature ||
		typeof manifest.version !== "string" ||
		!versionPattern.test(manifest.version) ||
		!Array.isArray(revoked) ||
		!revoked.every((v) => typeof v === "string" && versionPattern.test(v))
	) {
		throw new Error("Invalid update channel manifest");
	}
	return { version: manifest.version, revoked };
}

const [currentPath, candidatePath] = process.argv.slice(2);
const current = readManifest(currentPath);
const candidate = readManifest(candidatePath);
// A normal publish must not undo a recall. Only move past its revoked versions,
// so a later rerun of any of those tags remains older than the channel.
const older = compareVersions(candidate.version, current.version) < 0;
const predatesRecall = current.revoked.some(
	(version) => compareVersions(candidate.version, version) <= 0,
);
process.stdout.write(older || predatesRecall ? "skip" : "publish");
