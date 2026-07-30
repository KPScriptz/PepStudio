#!/usr/bin/env node
// Launcher: start the server and open the editor in your browser.
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 4178;
const srv = spawn('node', [path.join(dir, '..', 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
});
// No shell, and no macOS-only 'open': pick the platform's URL handler.
const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', `http://localhost:${port}`]]
  : process.platform === 'darwin' ? ['open', [`http://localhost:${port}`]]
  : ['xdg-open', [`http://localhost:${port}`]];
setTimeout(() => execFile(opener[0], opener[1], () => {}), 1300);
process.on('SIGINT', () => { srv.kill(); process.exit(0); });
