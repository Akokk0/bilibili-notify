import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ThemeRoot } from "./components/theme-root";
import "./styles.css";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { staleTime: 5_000, refetchOnWindowFocus: false },
	},
});

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<ThemeRoot>
				<BrowserRouter>
					<App />
				</BrowserRouter>
			</ThemeRoot>
		</QueryClientProvider>
	</StrictMode>,
);
