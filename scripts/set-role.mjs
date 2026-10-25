#!/usr/bin/env node
// Set the `role` custom claim that server/auth.mjs reads from a Firebase ID token.
//
//   npm run set-role -- <uid-or-email> <viewer|analyst|admin|owner> [--dry-run] [--revoke]
//
// Why a script and not a UI: roles gate the only write path in the product
// (pushing context hints to a live ad group). Making them editable from the app
// would let an admin promote themselves; a claim that only an operator with
// service-account credentials can set keeps authorisation out of the app.
//
// First-admin bootstrap ("who sets the first owner?") is in docs/SECURITY.md.
// Short version: you do, once, from a machine holding the service account key,
// using this script. Until then every signed-in user is a `viewer`.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROLES = ['viewer', 'analyst', 'admin', 'owner'];
const USAGE = `Usage: npm run set-role -- <uid-or-email> <${ROLES.join('|')}> [options]

Options:
  --project <id>          Firebase project id (default: FIREBASE_PROJECT_ID)
  --credentials <path>    Service account JSON (default: GOOGLE_APPLICATION_CREDENTIALS)
  --dry-run               Print what would change, write nothing
  --revoke                Remove the role claim (server treats the user as viewer)
  --help

Roles:
  viewer   read-only (default for anyone without a claim)
  analyst  read-only, may export
  admin    may push context hints to the ad account
  owner    admin + audit log visibility for every actor
`;

function parseArgs(argv) {
  const positional = [];
  const flags = { dryRun: false, revoke: false, help: false, project: undefined, credentials: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--revoke') flags.revoke = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--project') flags.project = argv[++i];
    else if (arg === '--credentials') flags.credentials = argv[++i];
    else if (arg.startsWith('--')) fail(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags };
}

function fail(message, code = 1) {
  console.error(`[set-role] ${message}`);
  process.exit(code);
}

function loadEnvFile() {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
}

/**
 * firebase-admin is an optionalDependency, so this must explain itself instead of
 * throwing ERR_MODULE_NOT_FOUND at the operator.
 */
async function loadAdmin({ project, credentials }) {
  let admin;
  try {
    admin = await import('firebase-admin');
  } catch (error) {
    if (String(error?.code) === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String(error?.message))) {
      fail(
        'firebase-admin is not installed. It is an optional dependency: `npm install --include=optional` (or npm i -D firebase-admin) on the machine that administers roles.',
      );
    }
    throw error;
  }
  if (!project) fail('No project id. Pass --project <id> or set FIREBASE_PROJECT_ID.');
  const options = { projectId: project };
  if (credentials) {
    if (!existsSync(credentials)) fail(`Service account file not found: ${credentials}`);
    options.credential = admin.credential.cert(JSON.parse(readFileSync(credentials, 'utf8')));
  } else if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.warn(
      '[set-role] No credentials flag and no GOOGLE_APPLICATION_CREDENTIALS: relying on Application Default Credentials.',
    );
  }
  if (!admin.apps.length) admin.initializeApp(options);
  return admin;
}

async function resolveUid(admin, target) {
  if (target.includes('@')) {
    try {
      const user = await admin.auth().getUserByEmail(target);
      return { uid: user.uid, email: user.email };
    } catch (error) {
      if (error?.code === 'auth/user-not-found') fail(`No Firebase user with email ${target}. Invite them first.`);
      throw error;
    }
  }
  const user = await admin.auth().getUser(target);
  return { uid: user.uid, email: user.email };
}

async function main() {
  loadEnvFile();
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || positional.length === 0) {
    console.log(USAGE);
    process.exit(flags.help ? 0 : 2);
  }
  if (positional.length < 2) fail('Expected a user and a role.\n\n' + USAGE, 2);

  const [target, role] = positional;
  if (!flags.revoke && !ROLES.includes(role)) fail(`Unknown role "${role}". One of: ${ROLES.join(', ')}.`);

  if (process.env.AUTH_MODE === 'dev' && !process.env.FIREBASE_PROJECT_ID && !flags.project) {
    console.warn('[set-role] AUTH_MODE=dev in this environment: roles only matter once AUTH_MODE=firebase.');
  }

  const admin = await loadAdmin({
    project: flags.project ?? process.env.FIREBASE_PROJECT_ID,
    credentials: flags.credentials ?? process.env.GOOGLE_APPLICATION_CREDENTIALS,
  });

  const { uid, email } = await resolveUid(admin, target);
  const existing = (await admin.auth().getUser(uid)).customClaims ?? {};
  const nextClaims = { ...existing };
  if (flags.revoke) delete nextClaims.role;
  else nextClaims.role = role;

  const summary = flags.revoke ? `revoke role from ${email ?? uid}` : `set role=${role} for ${email ?? uid}`;

  if (flags.dryRun) {
    console.log(`[set-role] dry run — would ${summary}`);
    console.log(`[set-role] current claims: ${JSON.stringify(existing)}`);
    console.log(`[set-role] next claims:    ${JSON.stringify(nextClaims)}`);
    return;
  }

  await admin.auth().setCustomUserClaims(uid, nextClaims);
  // Refresh tokens so the claim is live: otherwise the user keeps a token that
  // says `viewer` (the fail-closed default) for up to an hour.
  await admin.auth().revokeRefreshTokens(uid);
  console.log(`[set-role] ${summary}`);
  console.log('[set-role] refresh tokens revoked — the user must sign in again for the claim to take effect.');
}

main().catch((error) => fail(error?.message ?? String(error)));
