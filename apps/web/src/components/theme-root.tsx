import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import {
	getSystemPrefersDark,
	readThemePreference,
	subscribeSystemThemeChange,
	writeThemePreference,
} from "../services/theme";
import { type ResolvedTheme, useThemeStore } from "../store/theme";

export interface ThemeRootProps {
	children: ReactNode;
}

function applyDocumentTheme(theme: ResolvedTheme): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.colorScheme = theme;
}

export function ThemeRoot({ children }: ThemeRootProps) {
	const preference = useThemeStore((s) => s.preference);
	const resolved = useThemeStore((s) => s.resolved);
	const [hydrated, setHydrated] = useState(false);

	useLayoutEffect(() => {
		useThemeStore.getState().hydratePreference(readThemePreference(), getSystemPrefersDark());
		applyDocumentTheme(useThemeStore.getState().resolved);
		const unsubscribe = subscribeSystemThemeChange((matches) => {
			useThemeStore.getState().setSystemPrefersDark(matches);
		});
		setHydrated(true);
		return unsubscribe;
	}, []);

	useEffect(() => {
		applyDocumentTheme(resolved);
	}, [resolved]);

	useEffect(() => {
		if (hydrated) writeThemePreference(preference);
	}, [hydrated, preference]);

	return <>{children}</>;
}
