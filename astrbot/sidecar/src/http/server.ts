import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SidecarSnapshot } from "../runtime/state.js";

export type SnapshotProvider = () => SidecarSnapshot;

export function createSidecarRequestListener(getSnapshot: SnapshotProvider) {
	return (req: IncomingMessage, res: ServerResponse): void => {
		const method = req.method ?? "GET";
		const pathname = getPathname(req);
		if (method === "GET" && pathname === "/api/health") {
			writeJson(res, 200, getSnapshot());
			return;
		}
		if (method === "GET" && pathname === "/api/meta") {
			writeJson(res, 200, getSnapshot());
			return;
		}
		if (method === "GET" && pathname === "/") {
			writeText(res, 200, "bilibili-notify AstrBot sidecar");
			return;
		}
		writeJson(res, 404, { error: "not_found" });
	};
}

export async function listenSidecarServer(
	server: Server,
	host: string,
	port: number,
): Promise<{ host: string; port: number }> {
	return new Promise((resolve, reject) => {
		const onError = (err: Error) => {
			server.off("error", onError);
			reject(err);
		};
		server.once("error", onError);
		server.listen(port, host, () => {
			server.off("error", onError);
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				reject(new Error("sidecar server did not expose a TCP address"));
				return;
			}
			resolve({ host, port: address.port });
		});
	});
}

export async function closeSidecarServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

export function createSidecarHttpServer(getSnapshot: SnapshotProvider): Server {
	return createServer(createSidecarRequestListener(getSnapshot));
}

function getPathname(req: IncomingMessage): string {
	const host = req.headers.host ?? "127.0.0.1";
	return new URL(req.url ?? "/", `http://${host}`).pathname;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
	res.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
	});
	res.end(`${JSON.stringify(payload)}\n`);
}

function writeText(res: ServerResponse, statusCode: number, text: string): void {
	res.writeHead(statusCode, {
		"content-type": "text/plain; charset=utf-8",
	});
	res.end(`${text}\n`);
}
