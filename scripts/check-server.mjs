// Gate for `npm run verify`: the server must boot, answer /api/health, and
// report demo mode when no keys are present (never crash, never leak a key).
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = '8799';
const child = spawn(process.execPath, ['server/dev.mjs'], {
  env: { ...process.env, API_PORT: PORT, OPENAI_ADS_API_KEY: '', OPENAI_CONVERSIONS_API_KEY: '', OPENAI_PIXEL_ID: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => (out += d.toString()));
child.stderr.on('data', (d) => (out += d.toString()));

try {
  let body = null;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      body = await res.json();
      break;
    } catch {
      /* still booting */
    }
  }
  if (!body) throw new Error(`server did not answer /api/health\n${out}`);
  if (body.mode !== 'demo') throw new Error(`expected demo mode without keys, got ${body.mode}`);
  if (JSON.stringify(body).match(/sk-|ak_live|ck_live/)) throw new Error('health response leaked a key');
  if (body.configuration?.adsKey !== false) throw new Error('health must report keys as missing');

  const dataset = await fetch(`http://127.0.0.1:${PORT}/api/dataset?days=30`).then((r) => r.json());
  if (dataset.mode !== 'demo') throw new Error('dataset should fall back to demo');

  const track = await fetch(`http://127.0.0.1:${PORT}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventName: 'lead_created', eventId: 'x', sourceUrl: 'https://a.test', consent: false }),
  }).then((r) => r.json());
  if (track.error?.code !== 'consent_required') throw new Error('consent gate is not enforced');

  console.log('server ok: demo mode, consent gate enforced, no keys in responses');
} finally {
  child.kill('SIGTERM');
}
