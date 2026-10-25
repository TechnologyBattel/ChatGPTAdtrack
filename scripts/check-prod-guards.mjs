// The server must refuse to start in an unsafe production configuration rather
// than silently downgrading to dev auth. Each case is run as a child process and
// expected to exit non-zero with a specific message.
import { spawn } from 'node:child_process';

const SECRET = 'prod-consent-secret-0123456789';

const cases = [
  {
    name: 'NODE_ENV=production without AUTH_MODE',
    env: {
      NODE_ENV: 'production',
      AUTH_MODE: '',
      DEV_AUTH_TOKEN: '',
      CONSENT_SECRETS: `v1:${SECRET}`,
    },
    expect: /AUTH_MODE must be "firebase"/,
  },
  {
    name: 'AUTH_MODE=dev in production',
    env: {
      NODE_ENV: 'production',
      AUTH_MODE: 'dev',
      DEV_AUTH_TOKEN: 'x'.repeat(24),
      CONSENT_SECRETS: `v1:${SECRET}`,
    },
    expect: /AUTH_MODE=dev is not allowed/,
  },
  {
    // Gap 1: dev auth plus a real ad account is a write path with no login.
    name: 'AUTH_MODE=dev plus a live ad account key',
    env: {
      NODE_ENV: 'development',
      AUTH_MODE: 'dev',
      DEV_AUTH_TOKEN: 'x'.repeat(24),
      CONSENT_SECRETS: `v1:${SECRET}`,
      OPENAI_ADS_API_KEY: 'sk-live-looking-value',
    },
    expect: /AUTH_MODE=dev cannot be combined with real ad account keys/,
  },
  {
    name: 'AUTH_MODE=dev plus a pixel id only',
    env: {
      NODE_ENV: 'development',
      AUTH_MODE: 'dev',
      DEV_AUTH_TOKEN: 'x'.repeat(24),
      CONSENT_SECRETS: `v1:${SECRET}`,
      OPENAI_PIXEL_ID: 'px_123',
    },
    expect: /AUTH_MODE=dev cannot be combined with real ad account keys.*OPENAI_PIXEL_ID/,
  },
  {
    name: 'production without a consent signing secret',
    env: {
      NODE_ENV: 'production',
      AUTH_MODE: 'firebase',
      FIREBASE_PROJECT_ID: 'proj',
      STORAGE: 'firestore',
      TRACK_ORIGINS: 'https://app.example',
      CONSENT_SECRETS: '',
    },
    expect: /CONSENT_SECRETS \(or CONSENT_SECRET\) is required/,
  },
  {
    name: 'production on the in-memory store',
    env: {
      NODE_ENV: 'production',
      AUTH_MODE: 'firebase',
      FIREBASE_PROJECT_ID: 'proj',
      STORAGE: 'memory',
      TRACK_ORIGINS: 'https://app.example',
      CONSENT_SECRETS: `v1:${SECRET}`,
    },
    expect: /STORAGE=memory is not allowed in production/,
  },
  {
    name: 'production with no TRACK_ORIGINS',
    env: {
      NODE_ENV: 'production',
      AUTH_MODE: 'firebase',
      FIREBASE_PROJECT_ID: 'proj',
      STORAGE: 'firestore',
      TRACK_ORIGINS: '',
      CONSENT_SECRETS: `v1:${SECRET}`,
    },
    expect: /TRACK_ORIGINS must list the allowed origins/,
  },
  {
    name: 'an impossible TRUST_PROXY hop count',
    env: {
      NODE_ENV: 'development',
      AUTH_MODE: 'dev',
      DEV_AUTH_TOKEN: 'x'.repeat(24),
      CONSENT_SECRETS: `v1:${SECRET}`,
      TRUST_PROXY: '99',
    },
    expect: /TRUST_PROXY must be an integer between 0 and 10/,
  },
  {
    name: 'unknown AUTH_MODE',
    env: { NODE_ENV: 'development', AUTH_MODE: 'off', CONSENT_SECRETS: `v1:${SECRET}` },
    expect: /Unsupported AUTH_MODE/,
  },
];

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server/server.mjs'], {
      // A clean slate: the parent shell may export keys that would mask a case.
      env: {
        ...process.env,
        API_PORT: '8801',
        OPENAI_ADS_API_KEY: '',
        OPENAI_CONVERSIONS_API_KEY: '',
        OPENAI_PIXEL_ID: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, out, timedOut: true });
    }, 4000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut: false });
    });
  });
}

let failures = 0;
for (const testCase of cases) {
  const result = await run(testCase.env);
  if (result.timedOut) {
    console.error(`FAIL: ${testCase.name} started instead of refusing`);
    failures += 1;
    continue;
  }
  if (result.code === 0) {
    console.error(`FAIL: ${testCase.name} exited 0`);
    failures += 1;
    continue;
  }
  if (!testCase.expect.test(result.out)) {
    console.error(`FAIL: ${testCase.name} exited but without the expected message\n${result.out}`);
    failures += 1;
    continue;
  }
  console.log(`ok  refuses to start: ${testCase.name}`);
}

if (failures > 0) process.exit(1);
