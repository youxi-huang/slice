import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

/**
 * A loopback npm registry for install acceptance. It serves the given archives under their own unscoped names, so a
 * host installs `slice-pi`, `slice-opencode` or `slice-dsh` by name exactly as it would from npm, before anything is
 * published. Every other package is redirected to `upstream`, where the client fetches it itself, or answered 404
 * when there is no upstream. It accepts reads only.
 *
 * @param {{ packages: { manifest: { name: string, version: string }, archive: string }[], upstream?: string }} options
 * @returns {Promise<{ url: string, requests: string[], close(): Promise<void> }>}
 */
export async function startLoopbackRegistry({ packages, upstream }) {
	const local = new Map();
	for (const { manifest, archive } of packages) {
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) throw new Error(`Loopback registry serves unscoped names only: ${manifest.name}`);
		const bytes = readFileSync(archive);
		const entry = local.get(manifest.name) ?? { versions: new Map(), files: new Map() };
		const file = `${manifest.name}-${manifest.version}.tgz`;
		entry.versions.set(manifest.version, {
			manifest,
			file,
			shasum: createHash("sha1").update(bytes).digest("hex"),
			integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
		});
		entry.files.set(file, bytes);
		local.set(manifest.name, entry);
	}
	const requests = [];
	const published = new Date().toISOString();
	let base = "";
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		requests.push(`${request.method} ${url.pathname}`);
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405).end();
			return;
		}
		const [name, separator, file, ...rest] = decodeURIComponent(url.pathname).slice(1).split("/");
		const entry = local.get(name);
		if (entry) {
			if (separator === undefined) {
				const versions = Object.fromEntries([...entry.versions].map(([version, item]) => [version, {
					...item.manifest,
					_id: `${name}@${version}`,
					dist: { tarball: `${base}/${name}/-/${item.file}`, shasum: item.shasum, integrity: item.integrity },
				}]));
				const latest = [...entry.versions.keys()].at(-1);
				// pnpm reads publication times for its minimum release age.
				const time = Object.fromEntries([...entry.versions.keys()].map((version) => [version, published]));
				const body = JSON.stringify({ _id: name, name, "dist-tags": { latest }, versions, time: { created: published, modified: published, ...time } });
				response.writeHead(200, { "content-type": "application/json" }).end(request.method === "HEAD" ? undefined : body);
				return;
			}
			const bytes = separator === "-" && rest.length === 0 ? entry.files.get(file) : undefined;
			if (!bytes) {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
			response.end(request.method === "HEAD" ? undefined : bytes);
			return;
		}
		if (!upstream) {
			response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
			return;
		}
		response.writeHead(302, { location: new URL(`${url.pathname.slice(1)}${url.search}`, `${upstream.replace(/\/$/, "")}/`).href }).end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Loopback registry did not bind a port");
	base = `http://127.0.0.1:${address.port}`;
	return {
		url: `${base}/`,
		requests,
		close: () => new Promise((done) => server.close(() => done())),
	};
}
