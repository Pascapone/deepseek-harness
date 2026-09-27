import { spawn } from 'node:child_process';

const port = process.env.DSH_DEV_GATEWAY_PORT ?? process.env.DEV_GATEWAY_PORT ?? process.env.PORT;
if (!/^\d{4,5}$/.test(port ?? '')) throw new Error('Managed gateway port is required');
const child = spawn(process.execPath,
  ['apps/cli/lib/bin.js', 'web', '--host', '127.0.0.1', '--port', port, '--no-open'],
  { stdio: 'inherit', env: process.env });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
