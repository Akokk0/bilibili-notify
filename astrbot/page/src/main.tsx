import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ConfirmProvider } from "./components/ui";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
	<StrictMode>
		<ConfirmProvider>
			<App />
		</ConfirmProvider>
	</StrictMode>,
);
