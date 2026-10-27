// Stream E — context-hint research pipeline.
// ChatGPT Ads has no keyword box, no negatives and no search-terms report, so
// "keyword research" here means: seeds -> scrub -> intent -> cluster -> score ->
// conversation-shaped hints -> validators -> export. All deterministic, no deps.

export type SeedIntent = 'transactional' | 'comparison' | 'problem' | 'informational' | 'navigational';

export interface Seed {
  id: string;
  text: string;
  clean: string;
  source: string;
  intent: SeedIntent;
  tokens: string[];
  clusterId?: string;
  removed?: 'pii' | 'duplicate' | 'too-short';
}

export interface ValidatorIssue {
  code: 'length' | 'keyword-soup' | 'claim' | 'pii' | 'vague' | 'ok';
  message: string;
  severity: 'block' | 'warn' | 'ok';
}

export interface Hint {
  id: string;
  clusterId: string;
  text: string;
  intent: SeedIntent;
  issues: ValidatorIssue[];
  blocked: boolean;
  score: number;
}

export interface Cluster {
  id: string;
  name: string;
  intent: SeedIntent;
  seedIds: string[];
  size: number;
  tightness: number;
  relevance: number;
  intentScore: number;
  /**
   * How much material the cluster has — a structural proxy from its seed count.
   * NOT revenue, NOT expected ₹: first-party value is not connected yet, so the
   * score must not claim to know it. Renamed from `valueScore` when this was fixed.
   */
  sizeScore: number;
  coverageGap: boolean;
  risk: number;
  score: number;
  hints: string[];
  landingPath: string;
  checks: { label: string; value: string }[];
}

export interface ResearchResult {
  granularity: number;
  stats: {
    input: number;
    unique: number;
    piiRemoved: number;
    tooShort: number;
    clusters: number;
    hints: number;
    blockedHints: number;
  };
  clusters: Cluster[];
  hints: Hint[];
  gaps: string[];
}

const STOPWORDS = new Set(
  `a an the for to of and or in on at is are was were be been being i my me we our you your it its this that these those how what why when where which who whom do does did can could should would will with without from into about as if then than so very just really need want looking looking for help best top good bad new old more most less least some any all also not no yes`.split(
    /\s+/,
  ),
);

const SYNONYMS: Record<string, string> = {
  software: 'tool',
  tools: 'tool',
  app: 'tool',
  applications: 'tool',
  application: 'tool',
  bookkeeping: 'accounting',
  books: 'accounting',
  invoices: 'invoice',
  bills: 'invoice',
  billing: 'invoice',
  gst: 'tax',
  gstr: 'tax',
  tax: 'tax',
  returns: 'filing',
  filing: 'filing',
  file: 'filing',
  automated: 'automation',
  automate: 'automation',
  automating: 'automation',
  migration: 'switch',
  migrate: 'switch',
  migrating: 'switch',
  switching: 'switch',
  move: 'switch',
  compare: 'comparison',
  comparing: 'comparison',
  versus: 'comparison',
  vs: 'comparison',
  alternative: 'comparison',
  alternatives: 'comparison',
  smb: 'smallbusiness',
  small: 'smallbusiness',
  firm: 'smallbusiness',
  startup: 'smallbusiness',
  team: 'smallbusiness',
  teams: 'smallbusiness',
  spreadsheet: 'excel',
  spreadsheets: 'excel',
  excel: 'excel',
  manual: 'manual',
  manually: 'manual',
  typing: 'manual',
  dataentry: 'manual',
  entry: 'manual',
  deadline: 'urgency',
  deadlines: 'urgency',
  last: 'urgency',
  late: 'urgency',
  behind: 'urgency',
  overtime: 'urgency',
  hours: 'urgency',
};

const INTENT_RULES: { intent: SeedIntent; words: string[]; weight: number }[] = [
  {
    intent: 'transactional',
    words: [
      'buy',
      'pricing',
      'price',
      'cost',
      'subscribe',
      'signup',
      'demo',
      'quote',
      'trial',
      'hire',
      'purchase',
      'plan',
    ],
    weight: 1,
  },
  {
    intent: 'comparison',
    words: ['comparison', 'versus', 'alternative', 'better', 'instead', 'switch', 'migrate', 'replace', 'difference'],
    weight: 0.9,
  },
  {
    intent: 'problem',
    words: [
      'manual',
      'urgency',
      'stress',
      'mess',
      'wrong',
      'error',
      'late',
      'struggle',
      'pain',
      'hours',
      'tired',
      'confus',
    ],
    weight: 0.8,
  },
  {
    intent: 'navigational',
    words: ['login', 'log', 'portal', 'download', 'support', 'contact', 'account', 'brand', 'app store'],
    weight: 0.5,
  },
  {
    intent: 'informational',
    words: ['how', 'what', 'why', 'guide', 'meaning', 'explain', 'tutorial', 'learn'],
    weight: 0.4,
  },
];

const INTENT_VALUE: Record<SeedIntent, number> = {
  transactional: 1,
  comparison: 0.86,
  problem: 0.74,
  navigational: 0.55,
  informational: 0.32,
};

const CLAIM_WORDS = ['guaranteed', 'cheapest', 'best in', '100%', 'risk-free', 'instant results', 'number one', '#1'];
const PII_PATTERNS = [/[\w.+-]+@[\w-]+\.[\w.]+/g, /(\+?\d[\d\s-]{8,}\d)/g, /\b\d{4}\s?\d{4}\s?\d{4}\b/g];

export const SAMPLE_SEEDS = `gst filing last date for small business
how to file gstr-2b reconciliation quickly
accounting software for 10 person firm
compare cloud accounting vs desktop software
automate invoice data entry from pdf
bills coming on whatsapp how to record
excel bookkeeping outgrown need proper software
migrate tally data to cloud accounting
ca firm managing bookkeeping for 30 clients
best way to stop manual data entry in accounts
gst return filing help for proprietorship
how much does accounting software cost per month
invoice scanning app for accountants india
how to reconcile bank statement with books
temporary accountant for tax season
which accounting software shares work across branches
manual entry errors in purchase ledger
accounting software pricing for sme
switch from spreadsheets to accounting software
gst late fee calculation
invoice data entry job work from home
accounting software login
download accounting software for windows
how to track expenses for a small business
one person accounting team too much work
software to automate purchase invoice capture
compare accounting tools for indian sme
month end closing checklist for bookkeeper
how to avoid gst notice for late filing
bookkeeping automation for ca firm
contact 9876543210 for accounting help
hello@example.com accounting software demo
best accounting software india`;

function cleanText(raw: string): { clean: string; pii: boolean; tooShort: boolean } {
  let text = raw.trim().replace(/\s+/g, ' ');
  let pii = false;
  for (const re of PII_PATTERNS) {
    if (re.test(text)) {
      pii = true;
      text = text.replace(re, ' ');
    }
    re.lastIndex = 0;
  }
  const clean = text
    .toLowerCase()
    .replace(/[^a-z0-9\s&+#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { clean, pii, tooShort: clean.split(' ').filter(Boolean).length < 2 };
}

function tokenize(clean: string): string[] {
  const words = clean.split(' ').filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const mapped = words.map((w) => SYNONYMS[w] ?? w.replace(/(ing|ed|es|s)$/, (m) => (w.length > 5 ? '' : m)));
  return [...new Set(mapped)];
}

function classify(clean: string, tokens: string[]): SeedIntent {
  let best: SeedIntent = 'informational';
  let bestScore = 0;
  for (const rule of INTENT_RULES) {
    let hits = 0;
    for (const w of rule.words) if (clean.includes(w) || tokens.includes(w)) hits += 1;
    const score = hits * rule.weight;
    if (score > bestScore) {
      best = rule.intent;
      bestScore = score;
    }
  }
  return bestScore === 0 ? 'informational' : best;
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let inter = 0;
  for (const t of a) if (setB.has(t)) inter += 1;
  return inter / (a.length + b.length - inter);
}

export function normalizeSeeds(raw: string): Seed[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const seen = new Set<string>();
  const seeds: Seed[] = [];
  let i = 0;
  for (const line of lines) {
    i += 1;
    const { clean, pii, tooShort } = cleanText(line);
    if (pii || tooShort) {
      seeds.push({
        id: `s${i}`,
        text: line,
        clean,
        source: 'paste',
        intent: 'informational',
        tokens: tokenize(clean),
        removed: pii ? 'pii' : 'too-short',
      });
      continue;
    }
    if (seen.has(clean)) {
      seeds.push({
        id: `s${i}`,
        text: line,
        clean,
        source: 'paste',
        intent: classify(clean, tokenize(clean)),
        tokens: tokenize(clean),
        removed: 'duplicate',
      });
      continue;
    }
    seen.add(clean);
    const tokens = tokenize(clean);
    seeds.push({ id: `s${i}`, text: line, clean, source: 'paste', intent: classify(clean, tokens), tokens });
  }
  return seeds;
}

/**
 * Greedy semantic clustering. `granularity` 0..100: higher means tighter, more
 * clusters (the granularity slider every clustering tool has, for good reason).
 */
function clusterSeeds(seeds: Seed[], granularity: number): { clusters: Seed[][]; threshold: number } {
  const threshold = 0.1 + (granularity / 100) * 0.32; // 0.10 (broad) .. 0.42 (fine)
  const clusters: Seed[][] = [];
  for (const seed of seeds) {
    let placed = false;
    let bestIdx = -1;
    let bestSim = 0;
    clusters.forEach((group, idx) => {
      const centroid = [...new Set(group.flatMap((s) => s.tokens))];
      const sim = jaccard(seed.tokens, centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = idx;
      }
    });
    if (bestSim >= threshold && bestIdx >= 0) {
      clusters[bestIdx].push(seed);
      placed = true;
    }
    if (!placed) clusters.push([seed]);
  }
  return { clusters, threshold };
}

function clusterName(seeds: Seed[], intent: SeedIntent): string {
  const counts = new Map<string, number>();
  for (const s of seeds) for (const t of s.tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
  const label = top.length ? top.join(' · ') : 'misc';
  const prefix =
    intent === 'comparison'
      ? 'Comparing'
      : intent === 'problem'
        ? 'Pain'
        : intent === 'transactional'
          ? 'Buying'
          : intent === 'navigational'
            ? 'Brand'
            : 'Learning';
  return `${prefix}: ${label}`;
}

const LANDING: Record<SeedIntent, string> = {
  transactional: '/pricing',
  comparison: '/compare',
  problem: '/automation',
  navigational: '/',
  informational: '/guides',
};

/** Turn a cluster into hints that describe a moment, not a phrase. */
function buildHints(cluster: Seed[], intent: SeedIntent): string[] {
  const examples = cluster
    .slice()
    .sort((a, b) => b.tokens.length - a.tokens.length)
    .slice(0, 3)
    .map((s) => s.clean);
  const a = examples[0] ?? 'the problem';
  const b = examples[1] ?? a;
  const c = examples[2] ?? b;

  const byIntent: Record<SeedIntent, string[]> = {
    problem: [
      `someone describing the frustration of ${a} and asking whether it can be avoided`,
      `an accounts team explaining how much time ${b} takes every month`,
      `a business owner saying ${c} keeps going wrong and they want it fixed before the next deadline`,
    ],
    comparison: [
      `someone weighing two options and asking which is better for their situation: ${a}`,
      `a team that has outgrown ${b} and is comparing what switching would actually involve`,
      `an accountant asking for an honest difference between the two approaches to ${c}`,
    ],
    transactional: [
      `someone ready to buy asking what ${a} costs for a small team`,
      `a founder comparing plans and asking what is included before paying`,
      `a buyer who needs ${b} this week and is checking pricing and onboarding`,
    ],
    navigational: [
      `someone looking for the product they already use by name, to sign in`,
      `an existing customer trying to find the right page for ${a}`,
    ],
    informational: [
      `someone learning how ${a} works and what the steps are`,
      `a first-time reader asking what ${b} means in practice for a small business`,
    ],
  };
  return byIntent[intent];
}

export function validateHint(text: string): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 6)
    issues.push({
      code: 'length',
      message: `Only ${words.length} words — describe the situation, not a phrase.`,
      severity: 'block',
    });
  if (words.length > 40)
    issues.push({
      code: 'length',
      message: `${words.length} words is too long; keep one need per hint.`,
      severity: 'warn',
    });
  const situational =
    /\b(someone|a team|an?\s+\w+|business owner|founder|accountant|buyer|customer|people|reader|user)\b/i.test(text);
  const hasVerb =
    /\b(is|are|was|asks|asking|wants|want|needs|need|looking|describing|explaining|deciding|comparing|weighing|trying|checking|learning|saying|ready|has|have)\b/i.test(
      text,
    );
  if (!situational || !hasVerb)
    issues.push({
      code: 'keyword-soup',
      message: 'Reads like a keyword list. Wrap it in a situation with a subject and a verb.',
      severity: 'block',
    });
  for (const claim of CLAIM_WORDS) {
    if (text.toLowerCase().includes(claim))
      issues.push({
        code: 'claim',
        message: `Contains a claim ("${claim}") that ad copy must not assert.`,
        severity: 'block',
      });
  }
  for (const re of PII_PATTERNS) {
    if (re.test(text)) issues.push({ code: 'pii', message: 'Contains personal data.', severity: 'block' });
    re.lastIndex = 0;
  }
  if (/\b(best|top|cheapest)\b/i.test(text))
    issues.push({
      code: 'vague',
      message: 'Superlatives do not help relevance matching; describe the need instead.',
      severity: 'warn',
    });
  if (!issues.some((i) => i.severity !== 'ok'))
    issues.push({ code: 'ok', message: 'Passes all checks.', severity: 'ok' });
  return issues;
}

export function runResearch(raw: string, granularity = 50): ResearchResult {
  const seeds = normalizeSeeds(raw);
  const usable = seeds.filter((s) => !s.removed);
  const { clusters: rawClusters } = clusterSeeds(usable, granularity);

  const clusters: Cluster[] = rawClusters
    .map((group, idx) => {
      const intent = dominantIntent(group);
      const tightness = tightnessOf(group);
      const relevance = 0.55 + tightness * 0.45;
      const intentScore = INTENT_VALUE[intent];
      const sizeScore = Math.min(1, 0.25 + group.length / 14);
      const risk = group.some((s) => s.clean.includes('best') || s.clean.includes('cheap')) ? 0.18 : 0.06;
      const coverageGap = group.length <= 2;
      const hints = buildHints(group, intent);
      const components = { relevance, intentScore, sizeScore, coverageGap, risk };
      return {
        id: `c${idx + 1}`,
        name: clusterName(group, intent),
        intent,
        seedIds: group.map((s) => s.id),
        size: group.length,
        tightness,
        relevance,
        intentScore,
        sizeScore,
        coverageGap,
        risk,
        // The displayed parts *are* the score: one function, used both places, so a
        // cluster can never show bars that do not add up to its badge.
        score: scoreOf(components),
        hints,
        landingPath: LANDING[intent],
        checks: [
          { label: 'Tightness', value: `${(tightness * 100).toFixed(0)}%` },
          { label: 'Intent', value: intent },
          { label: 'Seeds', value: `${group.length}` },
          { label: 'Landing', value: LANDING[intent] },
        ],
      };
    })
    .sort((a, b) => b.score - a.score);

  for (const c of clusters) {
    for (const s of seeds) if (c.seedIds.includes(s.id)) s.clusterId = c.id;
  }

  const hints: Hint[] = [];
  clusters.forEach((c, ci) => {
    c.hints.forEach((text, hi) => {
      const issues = validateHint(text);
      hints.push({
        id: `h${ci + 1}_${hi + 1}`,
        clusterId: c.id,
        text,
        intent: c.intent,
        issues,
        blocked: issues.some((i) => i.severity === 'block'),
        score: c.score,
      });
    });
  });

  const gaps = clusters.filter((c) => c.coverageGap).map((c) => c.name);

  return {
    granularity,
    stats: {
      input: seeds.length,
      unique: usable.length,
      piiRemoved: seeds.filter((s) => s.removed === 'pii').length,
      tooShort: seeds.filter((s) => s.removed === 'too-short').length,
      clusters: clusters.length,
      hints: hints.length,
      blockedHints: hints.filter((h) => h.blocked).length,
    },
    clusters,
    hints,
    gaps,
  };
}

function dominantIntent(group: Seed[]): SeedIntent {
  const counts = new Map<SeedIntent, number>();
  for (const s of group) counts.set(s.intent, (counts.get(s.intent) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function tightnessOf(group: Seed[]): number {
  if (group.length < 2) return 0.6;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      sum += jaccard(group[i].tokens, group[j].tokens);
      pairs += 1;
    }
  }
  return pairs ? sum / pairs : 0.6;
}

export function toCsv(result: ResearchResult): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = ['cluster,intent,hint,score,status,issues,landing_path'];
  for (const h of result.hints) {
    const cluster = result.clusters.find((c) => c.id === h.clusterId);
    lines.push(
      [
        esc(cluster?.name ?? ''),
        h.intent,
        esc(h.text),
        h.score.toFixed(3),
        h.blocked ? 'blocked' : 'ready',
        esc(h.issues.map((i) => i.code).join('|')),
        cluster?.landingPath ?? '',
      ].join(','),
    );
  }
  return lines.join('\n');
}

/**
 * The five components of a cluster score. `points` is what the component actually
 * contributes, so the parts sum to `score` exactly — the previous version mixed a
 * hardcoded term into the score and then displayed a different "Coverage" value,
 * which made the bars and the badge disagree.
 *
 * Labels describe what is measured. "Size" is the seed count, not revenue: until
 * first-party value is connected, ranking by expected ₹ would be a guess wearing a
 * percentage.
 */
export const SCORE_WEIGHTS = {
  relevance: 0.3,
  intent: 0.25,
  size: 0.25,
  coverage: 0.1,
  safety: 0.1,
} as const;

function componentsOf(c: Pick<Cluster, 'relevance' | 'intentScore' | 'sizeScore' | 'coverageGap' | 'risk'>) {
  return [
    { key: 'relevance' as const, label: 'Relevance', value: c.relevance, weight: SCORE_WEIGHTS.relevance },
    { key: 'intent' as const, label: 'Intent', value: c.intentScore, weight: SCORE_WEIGHTS.intent },
    { key: 'size' as const, label: 'Size', value: c.sizeScore, weight: SCORE_WEIGHTS.size },
    { key: 'coverage' as const, label: 'Coverage', value: c.coverageGap ? 0 : 1, weight: SCORE_WEIGHTS.coverage },
    { key: 'safety' as const, label: 'Safety', value: 1 - c.risk, weight: SCORE_WEIGHTS.safety },
  ].map((part) => ({ ...part, points: part.value * part.weight }));
}

function scoreOf(c: Pick<Cluster, 'relevance' | 'intentScore' | 'sizeScore' | 'coverageGap' | 'risk'>): number {
  const total = componentsOf(c).reduce((sum, part) => sum + part.points, 0);
  // Weights sum to 1 and every value is in [0, 1], so this is already in range; the
  // clamp only guards against a future edit that breaks that invariant.
  return Math.min(1, Math.max(0, total));
}

export function scoreBreakdown(
  c: Cluster,
): { key: string; label: string; value: number; weight: number; points: number }[] {
  return componentsOf(c);
}
