import { isPlainObject } from "./files.js";

/** Rename only stored search switches; defaults and invalid-cell handling remain schema-owned. */
export function renameAiSearchScenes(raw: unknown): unknown {
	if (!isPlainObject(raw) || !isPlainObject(raw.ai) || !isPlainObject(raw.ai.search)) return raw;
	const search = raw.ai.search;
	const hasEngines = Object.hasOwn(search, "engines");
	const selected = Object.hasOwn(search, "scenes") ? search.scenes : search.engines;
	const hasDynamic = isPlainObject(selected) && Object.hasOwn(selected, "dynamic");
	if (!hasEngines && !hasDynamic) return raw;
	let scenes = selected;
	if (hasDynamic && isPlainObject(selected)) {
		const { dynamic, ...rest } = selected;
		scenes = Object.hasOwn(selected, "post") ? rest : { ...rest, post: dynamic };
	}
	const { engines: _engines, ...rest } = search;
	return { ...raw, ai: { ...raw.ai, search: { ...rest, scenes } } };
}
