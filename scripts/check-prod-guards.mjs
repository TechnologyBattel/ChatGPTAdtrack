// The server must refuse to start in an unsafe production configuration rather
// than silently downgrading to dev auth. Each case is run as a child process and
// expected to exit non-zero with a specific message.
import { spawn } from 'node:child_process';

const cases = [
  {
    name: 'NODE_ENV=production without AUTH_MODE',
    env: {
      NODE_ENV: 'production',
      AUTH_MODE: '',
      DEV_AUTH_TOKEN: '',
      CONSENT_SECRET: 'prod-consent-secret-0123456789',
    },
    expect: /AUTH_MODE must be "firebase"/,
  },
  {
    name: 'AUTH_MODE=dev in production',
    env: {
      NODE_ENV: 'production',
      AUTH_MODE: 'dev',
      DEV_AUTH_TOKEN: 'x'.repeat(24),
      CONSENT_SECRET: 'prod-consent-secret-0123456789',
    },
    expect: /AUTH_MODE=dev is not allowed/,
  },
  {
    name: 'production without CONSENT_SECRET',
    env: { NODE_ENV: 'production', AUTH_MODE: 'firebase', CONSENT_SECRET: '' },
    expect: /CONSENT_SECRET is required/,
  },
  {
    name: 'unknown AUTH_MODE',
    env: { NODE_ENV: 'development', AUTH_MODE: 'off', CONSENT_SECRET: 'dev-consent-secret-0123456789' },
    expect: /Unsupported AUTH_MODE/,
  },
];

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server/server.mjs'], {
      env: { ...process.env, API_PORT: '8801', ...env },
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
