// Static checks on the production image definition.
//
// This is NOT a substitute for building the image — a build is the only proof that the
// Dockerfile works, and it is recorded as UNKNOWN wherever Docker is unavailable. What
// this catches is the class of mistake that a build would *not* catch: an image that
// builds fine and then runs as root, ships a secret, or starts without a health probe.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dockerfilePath = resolve(root, 'Dockerfile');
const ignorePath = resolve(root, '.dockerignore');

if (!existsSync(dockerfilePath)) {
  console.error('FAIL: no Dockerfile');
  process.exit(1);
}

const dockerfile = readFileSync(dockerfilePath, 'utf8');
const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
const instructions = dockerfile
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .join('\n');

const checks = [];
const check = (ok, label, detail = '') => checks.push({ ok, label, detail });

check(/^FROM node:22/m.test(instructions), 'base image is Node 22 (matches .nvmrc major)', 'FROM node:22-…');
check(/\bUSER\s+node\b/.test(instructions), 'runs as the unprivileged node user', 'USER node');
check(!/^USER\s+root\b/m.test(instructions), 'never switches to root');
check(/HEALTHCHECK[\s\S]*\/api\/health/.test(instructions), 'declares a health probe against /api/health');
check(/npm ci\b/.test(instructions), 'installs from the lockfile with npm ci');
check(/--omit=dev\b/.test(instructions), 'omits dev dependencies from the runtime image');
check(/COPY package\.json package-lock\.json/.test(instructions), 'copies the lockfile before the source');
check(!/COPY\s+\.\s+\./.test(instructions), 'does not copy the whole build context');
check(!/^(COPY|ADD)\s+[^\n]*\.env/m.test(instructions), 'does not copy any .env file', 'COPY/ADD lines only');
check(!/ENV\s+[A-Z_]*(SECRET|TOKEN|KEY|PASSWORD)/.test(instructions), 'bakes no secret into an ENV layer');
check(/ENTRYPOINT\s+\[?"?\/sbin\/tini/.test(instructions), 'uses tini so SIGTERM reaches node (graceful drain)');
check(/EXPOSE\s+8080/.test(instructions), 'exposes the documented API port');

for (const needle of ['.env', 'node_modules', '.git']) {
  check(
    ignore.split('\n').some((line) => line.trim() === needle || line.trim() === `${needle}*`),
    `.dockerignore excludes ${needle}`,
  );
}

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed += 1;
  console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.label}${item.detail ? ` (${item.detail})` : ''}`);
}

console.log('');
console.log('NOTE: a static check cannot prove the image builds, starts, or drops privileges.');
console.log('      That evidence requires `docker build` + `docker run` and is UNKNOWN until CI runs it.');

if (failed > 0) {
  console.error(`\nDockerfile static check: ${failed} problem(s)`);
  process.exit(1);
}
console.log('\nDockerfile static check: ok');
