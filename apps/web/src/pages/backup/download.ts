/**
 * Save a JSON document to the user's disk. Isolated in its own module so the
 * backup section can be tested without a real Blob/objectURL/anchor-click (jsdom
 * implements none of them faithfully) — tests mock this one function.
 */
export function downloadJson(filename: string, doc: unknown): void {
	const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
