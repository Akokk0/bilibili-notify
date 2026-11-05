import type {
	LibraryFontsResponse,
	LibraryFontUploadResponse,
	LibraryImagesResponse,
	LibraryImageUploadResponse,
} from "@bilibili-notify/contract";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "../../services/api";

export type LibraryKind = "images" | "fonts";
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
export function deleteLibraryFile(kind: LibraryKind, id: string) {
	return api.delete(`${libraryPath(kind)}/${encodeURIComponent(id)}`);
}
export function invalidateLibrary(qc: QueryClient, kind: LibraryKind) {
	return qc.invalidateQueries({ queryKey: libraryQueryKey(kind) });
}
