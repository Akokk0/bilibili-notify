import type { TextValues } from "@bilibili-notify/internal/i18n";
import { type PackageTextKey, packageText } from "@bilibili-notify/internal/texts";
import { createContext, type ReactNode, useContext } from "react";
export type UiTextKey = Extract<PackageTextKey, `ui.${string}`>;
export type UiText = (key: UiTextKey, values?: TextValues) => string;
const UiTexts = createContext<UiText>(packageText);
export function UiTextProvider({ t, children }: { t: UiText; children: ReactNode }) {
	return <UiTexts value={t}>{children}</UiTexts>;
}
export function useUiText(): UiText {
	return useContext(UiTexts);
}
