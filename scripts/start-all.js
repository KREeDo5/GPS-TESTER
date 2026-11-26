import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const children = [
  spawn(process.execPath, [path.join(root, 'apps/receiver/server.js')], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  }),
  spawn(process.execPath, [path.join(root, 'apps/sender/server.js')], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  }),
];

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
  setTimeout(() => process.exit(0), 300).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

for (const child of children) {
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`[start-all] child exited with code ${code}, stopping others`);
    shutdown('SIGTERM');
  });
}

console.log('GPS-TESTER started');
console.log('  receiver: http://localhost:4000');
console.log('  sender:   http://localhost:3000');
