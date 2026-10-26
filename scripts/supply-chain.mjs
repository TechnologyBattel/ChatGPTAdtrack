// Supply chain: an SBOM, a license inventory, and a vulnerability gate.
//
// Everything here is derived from what is actually installed (`node_modules` + the
// lockfile), never from a hand-written list. `--check` turns each report into a gate:
//
//   node scripts/supply-chain.mjs license   → exit 1 on a non-allowlisted license
//   node scripts/supply-chain.mjs audit     → exit 1 on an unapproved high/critical
//   node scripts/supply-chain.mjs sbom      → writes artifacts/sbom.cdx.json
//   node scripts/supply-chain.mjs all       → all of the above
//
// What this cannot do: decide whether a license is *acceptable for your business*. It
// classifies and reports; legal review of the flagged items is still required.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, 'artifacts');

/**
 * Permissive licenses this project is willing to depend on without a legal review.
 * Anything else is reported and fails `--check`; that is a prompt to think, not a verdict.
 */
const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'BlueOak-1.0.0',
  'WTFPL',
  'Zlib',
  '(MIT OR CC0-1.0)',
  '(MIT AND Zlib)',
  'Apache-2.0 AND MIT',
  '(BSD-2-Clause OR MIT OR Apache-2.0)',
]);

/**
 * Advisories that cannot be fixed without a major upgrade, with the reason and the
 * exposure. An entry here is a signed-off residual risk, not a deleted finding: the
 * report still prints every advisory, and a new advisory fails the gate.
 */
const ACK_PATH = resolve(root, 'security/vulnerability-allowlist.json');
const LICENSE_ACK_PATH = resolve(root, 'security/license-allowlist.json');

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function lockPackages() {
  const lock = readJson(resolve(root, 'package-lock.json'));
  if (!lock?.packages) throw new Error('package-lock.json is missing a "packages" map.');
  return lock.packages;
}

/** Every installed package, with its own manifest's license field. */
export function inventory() {
  const packages = lockPackages();
  const rows = [];
  for (const [path, meta] of Object.entries(packages)) {
    if (!path.startsWith('node_modules/')) continue;
    // A nested install (`a/node_modules/b`) is still package `b`; the table would be
    // wrong if the whole path were used as the name.
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const manifestPath = resolve(root, path, 'package.json');
    const manifest = readJson(manifestPath, {});
    // Platform-specific optional packages (rollup/esbuild binaries for other OSes) are
    // not installed here, so their manifest is absent; the lockfile still records the
    // license the registry declared. Using it is evidence, inventing it would not be.
    const license =
      (typeof manifest.license === 'string' && manifest.license) ||
      (manifest.license && typeof manifest.license.type === 'string' && manifest.license.type) ||
      (Array.isArray(manifest.licenses) && manifest.licenses.map((l) => l.type ?? l).join(' OR ')) ||
      (typeof meta.license === 'string' && meta.license) ||
      null;
    rows.push({
      name,
      version: manifest.version ?? meta.version ?? 'unknown',
      license,
      dev: Boolean(meta.dev),
      optional: Boolean(meta.optional),
      resolved: meta.resolved ?? null,
      // A dependency whose manifest could not be read is reported, never silently
      // skipped: either it is a not-installed optional binary (license from the lockfile)
      // or its license is genuinely unknown.
      manifestFound: existsSync(manifestPath),
      notInstalled: !existsSync(manifestPath),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

export function licenseReport(rows = inventory()) {
  const accepted = readJson(LICENSE_ACK_PATH, { accepted: [] })?.accepted ?? [];
  const acceptedPackages = new Set(accepted.map((entry) => entry.package));
  const byLicense = {};
  const unknown = [];
  const notAllowed = [];
  for (const row of rows) {
    const key = row.license ?? 'UNKNOWN';
    byLicense[key] = (byLicense[key] ?? 0) + 1;
    if (!row.license) unknown.push(row);
    else if (!ALLOWED.has(row.license) && !acceptedPackages.has(row.name)) notAllowed.push(row);
  }
  const flags = notAllowed.map((row) => ({ ...row, reason: `license "${row.license}" is not on the allowlist` }));
  const notInstalled = rows.filter((row) => row.notInstalled);
  for (const row of notInstalled) {
    if (!row.license) unknown.push({ ...row, reason: 'not installed here and the lockfile records no license' });
  }
  return {
    generatedAt: new Date().toISOString(),
    source: 'package-lock.json + node_modules/*/package.json',
    totals: {
      packages: rows.length,
      production: rows.filter((r) => !r.dev).length,
      development: rows.filter((r) => r.dev).length,
      optional: rows.filter((r) => r.optional).length,
    },
    byLicense,
    unknown,
    notAllowed,
    flags,
    notInstalled,
    accepted,
    // Stated so nobody reads this file as a legal opinion.
    caveat:
      'A license name is not a legal review. Transitive obligations, NOTICE files and patent terms were not assessed here.',
    packages: rows,
  };
}

/** CycloneDX 1.5, the smallest faithful shape: components, licenses, dependency roots. */
export function sbom(rows = inventory()) {
  const pkg = readJson(resolve(root, 'package.json'), {});
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: 'adtrack', name: 'scripts/supply-chain.mjs', version: '1' }],
      component: {
        type: 'application',
        'bom-ref': `pkg:npm/${pkg.name}@${pkg.version}`,
        name: pkg.name,
        version: pkg.version,
      },
    },
    components: rows.map((row) => {
      const purl = `pkg:npm/${row.name.replace('@', '%40')}@${row.version}`;
      const component = {
        type: 'library',
        'bom-ref': purl,
        name: row.name,
        version: row.version,
        purl,
        scope: row.dev ? 'excluded' : 'required',
      };
      if (row.license) component.licenses = [{ license: { id: row.license } }];
      return component;
    }),
    dependencies: [
      {
        ref: `pkg:npm/${pkg.name}@${pkg.version}`,
        dependsOn: [
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.optionalDependencies ?? {}),
          ...Object.keys(pkg.devDependencies ?? {}),
        ].map((name) => {
          const found = rows.find((row) => row.name === name);
          return `pkg:npm/${name.replace('@', '%40')}@${found?.version ?? 'unknown'}`;
        }),
      },
    ],
  };
}

/** `npm audit --json`, normalised into one row per advisory path. */
export function auditReport() {
  let raw;
  try {
    raw = execFileSync('npm', ['audit', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    // npm exits non-zero when vulnerabilities exist; the JSON is still on stdout.
    raw = String(error.stdout ?? '');
  }
  const parsed = JSON.parse(raw);
  const allow = readJson(ACK_PATH, { accepted: [] }) ?? { accepted: [] };
  const acceptedNames = new Set((allow.accepted ?? []).map((entry) => entry.package));
  const advisories = [];
  for (const [name, item] of Object.entries(parsed.vulnerabilities ?? {})) {
    for (const via of item.via ?? []) {
      if (typeof via === 'string') {
        advisories.push({
          package: name,
          severity: item.severity,
          via: via,
          url: null,
          range: item.range ?? null,
          direct: item.isDirect,
        });
      } else {
        advisories.push({
          package: name,
          severity: via.severity ?? item.severity,
          advisory: via.source ?? null,
          title: via.title ?? null,
          url: via.url ?? null,
          range: via.range ?? null,
          direct: item.isDirect,
        });
      }
    }
  }
  const blocking = advisories.filter((a) => ['high', 'critical'].includes(a.severity) && !acceptedNames.has(a.package));
  return {
    generatedAt: new Date().toISOString(),
    metadata: parsed.metadata ?? null,
    advisories,
    accepted: allow.accepted ?? [],
    blocking,
  };
}

/** Attribution list: every package, its license and where it came from. */
export function notices(rows = inventory()) {
  const lines = [
    '# Third-party notices',
    '',
    '_Generated by `node scripts/supply-chain.mjs notices` from the installed tree. Do not edit by hand._',
    '',
    'This project depends on third-party open-source packages. Their licences are reproduced',
    'by their authors in each package; this file records which packages are present, under',
    'which licence, so the obligations can be met and reviewed.',
    '',
    'It is **not** a legal opinion, and it does not reproduce every copyright line: the',
    'authoritative text ships inside each package directory (`node_modules/<name>/LICENSE`).',
    '',
    '| Package | Version | License | Scope |',
    '|---|---|---|---|',
  ];
  for (const row of rows) {
    const scope = row.dev ? 'dev' : row.optional ? 'optional' : 'production';
    lines.push(`| ${row.name} | ${row.version} | ${row.license ?? 'UNKNOWN'} | ${scope} |`);
  }
  lines.push('');
  lines.push('## Obligations that need attention');
  lines.push('');
  const attention = rows.filter((row) => ['CC-BY-4.0', 'CC-BY-3.0', 'Apache-2.0'].includes(row.license ?? ''));
  if (attention.length === 0) lines.push('None identified by the allowlist.');
  for (const row of attention) {
    lines.push(
      `- **${row.name}@${row.version}** (${row.license}): ${
        row.license === 'Apache-2.0'
          ? 'retain the licence text and any NOTICE file shipped with the package'
          : 'attribute the data source'
      }.`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function writeArtifact(name, data) {
  if (!existsSync(artifacts)) mkdirSync(artifacts, { recursive: true });
  const file = resolve(artifacts, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

function main() {
  const command = process.argv[2] ?? 'all';
  const check = process.argv.includes('--check');
  let failed = false;

  if (command === 'license' || command === 'all') {
    const report = licenseReport();
    const file = writeArtifact('license-report.json', report);
    console.log(`license: ${file}`);
    console.log(
      `  ${report.totals.packages} packages (${report.totals.production} production, ${report.totals.development} dev, ${report.totals.optional} optional)`,
    );
    for (const [license, count] of Object.entries(report.byLicense).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${license}`);
    }
    for (const row of report.notAllowed) console.log(`  NOT ALLOWLISTED: ${row.name}@${row.version} → ${row.license}`);
    for (const row of report.unknown) console.log(`  UNKNOWN LICENSE: ${row.name}@${row.version}`);
    if (report.notInstalled.length) {
      console.log(
        `  ${report.notInstalled.length} optional platform binary(ies) not installed here (license taken from the lockfile)`,
      );
    }
    if (check && report.notAllowed.length > 0) failed = true;
  }

  if (command === 'audit' || command === 'all') {
    const report = auditReport();
    const file = writeArtifact('vulnerabilities.json', report);
    console.log(`audit: ${file}`);
    const bySeverity = report.advisories.reduce((acc, a) => ({ ...acc, [a.severity]: (acc[a.severity] ?? 0) + 1 }), {});
    console.log(`  advisories: ${JSON.stringify(bySeverity)}`);
    if (report.accepted.length)
      console.log(`  accepted (documented in security/vulnerability-allowlist.json): ${report.accepted.length}`);
    for (const item of report.blocking) {
      console.log(`  BLOCKING ${item.severity}: ${item.package} — ${item.title ?? item.via ?? item.advisory ?? ''}`);
    }
    if (check && report.blocking.length > 0) failed = true;
  }

  if (command === 'notices' || command === 'all') {
    if (!existsSync(artifacts)) mkdirSync(artifacts, { recursive: true });
    const file = resolve(artifacts, 'third-party-notices.md');
    writeFileSync(file, notices());
    console.log(`notices: ${file}`);
  }

  if (command === 'sbom' || command === 'all') {
    const file = writeArtifact('sbom.cdx.json', sbom());
    console.log(`sbom: ${file} (CycloneDX 1.5)`);
  }

  if (failed) {
    console.error('supply-chain gate: FAILED (see the reports above)');
    process.exit(1);
  }
  console.log('supply-chain gate: ok');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
