#!/usr/bin/env node
// Minimal static server for trying the site locally (browsers block fetch() on file:// pages).
//   node scripts/serve.mjs [port]     → http://localhost:8080/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const port = Number(process.argv[2] || process.env.PORT || 8080);
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

createServer(async (req, res) => {
    try {
        const { pathname } = new URL(req.url, 'http://localhost');
        let file = resolve(join(root, decodeURIComponent(pathname)));
        if (file !== root && !file.startsWith(root + sep)) {
            res.writeHead(403).end('Forbidden');
            return;
        }
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(body);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
}).listen(port, () => {
    console.log(`Serving ${root}\n  → http://localhost:${port}/  (Ctrl+C to stop)`);
});
