import { cp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await rm('dist', { recursive: true, force: true });
const build = spawnSync('npm', ['run', 'build', '--', '--mode', 'sites', '--outDir', '../dist/client'], { cwd: 'web', stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await cp('sites/worker.mjs', 'dist/server/index.js');
await cp('.openai/hosting.json', 'dist/.openai/hosting.json');
