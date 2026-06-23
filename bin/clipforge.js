#!/usr/bin/env node
// Launcher: start the server and open the editor in your browser.
import { spawn, exec } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 4178;
const srv = spawn('node', [path.join(dir, '..', 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
});
setTimeout(() => exec(`open http://localhost:${port}`), 1300);
process.on('SIGINT', () => { srv.kill(); process.exit(0); });
