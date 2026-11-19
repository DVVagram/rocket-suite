// Tiny static file server for the visual simulation (ES modules need http://).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Serve the repository root so the bundled OpenRocket example designs
// (core/src/main/resources/datafiles/examples) are reachable from the app.
const appDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(appDir);
const requestedPort = Number.parseInt(process.env.PORT ?? '', 10);
const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 8080;

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.ork': 'application/octet-stream',
	'.eng': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
	const url = decodeURIComponent((req.url || '/').split('?')[0]);
	let file = path.join(root, url === '/' ? 'visual-simulation/index.html' : url);
	if (!file.startsWith(root)) {
		res.writeHead(403).end('Forbidden');
		return;
	}
	fs.stat(file, (err, stat) => {
		if (!err && stat.isDirectory()) {
			file = path.join(file, 'index.html');
		}
		fs.readFile(file, (readErr, data) => {
			if (readErr) {
				res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found: ' + url);
				return;
			}
			res.writeHead(200, {
				'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
				'cache-control': 'no-store',
			});
			res.end(data);
		});
	});
});

// Windows can reserve individual ports (EACCES); fall back to the next
// candidate, ending with an ephemeral port so the server always starts.
const candidates = [...new Set([port, 8099, 5173, 4173, 3000, 0])];
let attempt = 0;

function listen() {
	const candidate = candidates[attempt];
	server.once('error', (err) => {
		if ((err.code === 'EACCES' || err.code === 'EADDRINUSE') && attempt < candidates.length - 1) {
			attempt += 1;
			console.warn(`Port ${candidate} unavailable (${err.code}), trying ${candidates[attempt]}…`);
			listen();
			return;
		}
		throw err;
	});
	server.listen(candidate, '127.0.0.1', () => {
		console.log(`Visual simulation running at http://127.0.0.1:${server.address().port}/visual-simulation/`);
	});
}

listen();
