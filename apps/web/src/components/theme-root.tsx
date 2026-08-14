import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import {
	getSystemPrefersDark,
	readThemePreference,
	subscribeSystemThemeChange,
	writeThemePreference,
} from "../services/theme";
import { useSkinStore } from "../store/skin";
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
	// 单套皮肤锁模式:锁优先于用户偏好。dataset.theme 只在这里写(SkinRoot 只写锁),
	// 否则两个 effect 抢同一属性,执行顺序决定谁赢。
	const lockedTheme = useSkinStore((s) => s.lockedTheme);
	const [hydrated, setHydrated] = useState(false);

	useLayoutEffect(() => {
		useThemeStore.getState().hydratePreference(readThemePreference(), getSystemPrefersDark());
		applyDocumentTheme(useSkinStore.getState().lockedTheme ?? useThemeStore.getState().resolved);
		const unsubscribe = subscribeSystemThemeChange((matches) => {
			useThemeStore.getState().setSystemPrefersDark(matches);
		});
		setHydrated(true);
		return unsubscribe;
	}, []);

	useEffect(() => {
		applyDocumentTheme(lockedTheme ?? resolved);
	}, [lockedTheme, resolved]);

	useEffect(() => {
		if (hydrated) writeThemePreference(preference);
	}, [hydrated, preference]);

	return <>{children}</>;
}
