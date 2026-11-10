import {
	createContext,
	type ReactNode,
	type RefObject,
	useContext,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useLocation } from "react-router-dom";

type DraftTable = Map<string, RefObject<unknown>>;

const ResourceDraftContext = createContext<{
	current: DraftTable;
	saved: DraftTable;
	origin: string | null;
} | null>(null);

/** 只在管理资源的往返期间保留内存草稿；普通切页、退出登录或重启不留存。 */
export function ResourceDraftProvider({ children }: { children: ReactNode }) {
	const { pathname } = useLocation();
	const [drafts] = useState(() => ({
		current: new Map() as DraftTable,
		saved: new Map() as DraftTable,
		origin: null as string | null,
	}));
	useLayoutEffect(() => {
		if (
			pathname === drafts.origin ||
			pathname === "/library" ||
			pathname.startsWith("/cards/skins/")
		)
			return;
		drafts.saved.clear();
		drafts.origin = null;
	}, [drafts, pathname]);
	return <ResourceDraftContext.Provider value={drafts}>{children}</ResourceDraftContext.Provider>;
}

/** 管理按钮在导航前同步取当前值，不等灵动岛的 debounce，也不提交任何设置。 */
export function usePreserveResourceDrafts() {
	const drafts = useContext(ResourceDraftContext);
	const { pathname } = useLocation();
	return () => {
		if (!drafts) return;
		drafts.origin = pathname;
		drafts.saved = new Map(drafts.current);
	};
}

/** 与 useState 同样的编辑语义；有明确键的原页状态才参与资源往返。 */
export function useResourceState<T>(key: string | undefined, initial: T | (() => T)) {
	const drafts = useContext(ResourceDraftContext);
	const [value, setValue] = useState<T>(() => {
		const saved = key === undefined ? undefined : drafts?.saved.get(key);
		if (saved) return saved.current as T;
		return typeof initial === "function" ? (initial as () => T)() : initial;
	});
	const current = useRef(value);
	useLayoutEffect(() => {
		current.current = value;
	}, [value]);
	useLayoutEffect(() => {
		if (!drafts || key === undefined) return;
		drafts.current.set(key, current);
		if (drafts.saved.has(key)) drafts.saved.set(key, current);
		return () => {
			drafts.current.delete(key);
		};
	}, [drafts, key]);
	return [value, setValue] as const;
}
