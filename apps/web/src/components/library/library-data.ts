import type {
	LibraryFontsResponse,
	LibraryFontUploadResponse,
	LibraryImagesResponse,
	LibraryImageUploadResponse,
	ResourceImportPreviewResponse,
} from "@bilibili-notify/contract";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "../../services/api";
import { downloadResource } from "../../services/resource-download";

export type LibraryKind = "images" | "fonts";
export type ResourceCategory =
	| LibraryKind
	| "dashboard-skins"
	| "card-skins"
	| "skills"
	| "personas";
export interface LibraryEntry {
	id: string;
	name?: string;
	size?: number;
}
export const libraryQueryKey = (kind: LibraryKind) => ["library", kind] as const;
const libraryPath = (kind: LibraryKind) => `/api/library/${kind}`;

/** Keep the existing resource DTOs in cache; both browser forms share one read side. */
export function useLibrary(kind: LibraryKind) {
	const query = useQuery<LibraryImagesResponse | LibraryFontsResponse>({
		queryKey: libraryQueryKey(kind),
		queryFn: () =>
			kind === "images"
				? api.get<LibraryImagesResponse>(libraryPath(kind))
				: api.get<LibraryFontsResponse>(libraryPath(kind)),
	});
	const entries: LibraryEntry[] = query.data
		? "ids" in query.data
			? query.data.ids.map((id) => ({ id }))
			: query.data.fonts
		: [];
	return { ...query, entries };
}
export function uploadLibraryFile(kind: LibraryKind, file: File) {
	const form = new FormData();
	form.append("file", file);
	return api.upload<LibraryImageUploadResponse | LibraryFontUploadResponse>(
		libraryPath(kind),
		form,
	);
}
export function previewLibraryFile(kind: LibraryKind, file: File) {
	const form = new FormData();
	form.set("file", file);
	return api.upload<ResourceImportPreviewResponse>(`${libraryPath(kind)}/import-preview`, form);
}
export function deleteLibraryFile(kind: LibraryKind, id: string) {
	return api.delete(`${libraryPath(kind)}/${encodeURIComponent(id)}`);
}
export function exportLibraryFile(kind: LibraryKind, entry: LibraryEntry) {
	return downloadResource(
		`${libraryPath(kind)}/${encodeURIComponent(entry.id)}?download=1`,
		entry.name ?? entry.id,
	);
}
export function invalidateLibrary(qc: QueryClient, kind: LibraryKind) {
	return qc.invalidateQueries({ queryKey: libraryQueryKey(kind) });
}
