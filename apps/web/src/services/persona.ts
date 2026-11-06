import type {
	PersonaCatalogResponse,
	PersonaImportPreviewResponse,
	PersonaWriteRequest,
	PersonaWriteResult,
} from "@bilibili-notify/contract";
import { api } from "./api";

export const personaQueryKey = ["ai", "personas"] as const;
export const listPersonas = () => api.get<PersonaCatalogResponse>("/api/ai/personas");
export const writePersona = (change: PersonaWriteRequest) =>
	api.post<PersonaWriteResult>("/api/ai/personas", change);
export function previewPersona(file: File) {
	const form = new FormData();
	form.set("file", file);
	return api.upload<PersonaImportPreviewResponse>("/api/ai/personas/import-preview", form);
}
export const exportPersona = (id: string) =>
	api.blob(`/api/ai/personas/${encodeURIComponent(id)}/export`);
