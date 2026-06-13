import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SidecarSnapshot } from "./state.js";

export async function writeReadyFile(filePath: string, snapshot: SidecarSnapshot): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
	await rename(tmpPath, filePath);
}

export async function readReadyFile(filePath: string): Promise<SidecarSnapshot> {
	return JSON.parse(await readFile(filePath, "utf8")) as SidecarSnapshot;
}

export async function removeReadyFile(filePath: string | undefined): Promise<void> {
	if (!filePath) return;
	await rm(filePath, { force: true });
}
