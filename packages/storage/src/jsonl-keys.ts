import { readdir } from "node:fs/promises";
import { isLeftoverName } from "./sweep";

/** 一个目录里的键(`<键>.jsonl` 的键,不含改名换写的临时残留);目录还没建回空。 */
export async function listJsonlKeys(root: string): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(root);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	return names
		.filter((name) => name.endsWith(".jsonl") && !isLeftoverName(name))
		.map((name) => name.slice(0, -".jsonl".length));
}
