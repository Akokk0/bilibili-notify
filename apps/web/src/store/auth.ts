import { create } from "zustand";
import type { LoginSnapshot } from "../types/auth";

interface AuthState {
	snapshot: LoginSnapshot | null;
	cookiesRefreshedAt: string | null;
	setSnapshot: (snap: LoginSnapshot) => void;
	setCookiesRefreshed: (ts: string) => void;
	clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
	snapshot: null,
	cookiesRefreshedAt: null,
	setSnapshot: (snap) => set({ snapshot: snap }),
	setCookiesRefreshed: (ts) => set({ cookiesRefreshedAt: ts }),
	clear: () => set({ snapshot: null, cookiesRefreshedAt: null }),
}));
