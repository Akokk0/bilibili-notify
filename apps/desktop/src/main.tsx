import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./launcher.css";

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
