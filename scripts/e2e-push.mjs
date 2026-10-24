// End-to-end check of the push/undo path through the real HTTP server.
//
// The OpenAI Ads hosts are replaced by a local stub via ADS_API_BASE, so this
// proves our routing, JSON handling, previous-set capture and error mapping.
// It does NOT prove the real API accepts the payload — see docs/API.md.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const STUB = 8898;
const API = 8897;

const state = {
  hints: ['an accountant filing returns manually', 'someone who is behind on GST filing'],
  writes: 0,
  failNextWrite: null,
};

const stub = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/v1/ad_account') {
    return send(200, { id: 'adacct_stub', name: 'Stub Ads', status: 'active', currency_code: 'INR', timezone: 'Asia/Kolkata', review: { status: 'approved' } });
  }
  if (req.method === 'GET' && req.url.startsWith('/v1/campaigns')) {
    return send(200, {
      object: 'list',
      has_more: false,
      data: [{ id: 'cmpn_stub', name: 'Intent — accounting', status: 'active', bidding_type: 'clicks', budget: { daily_spend_limit_micros: 2500000000 } }],
    });
  }
  if (req.method === 'GET' && req.url.startsWith('/v1/ad_groups?')) {
    return send(200, { object: 'list', data: [{ id: 'adgrp_stub', campaign_id: 'cmpn_stub', name: 'GST filing stress', context_hints: state.hints }] });
  }
  if (req.method === 'GET' && req.url === '/v1/ad_groups/adgrp_stub') {
    return send(200, { id: 'adgrp_stub', campaign_id: 'cmpn_stub', name: 'GST filing stress', context_hints: state.hints });
  }
  if (req.method === 'POST' && req.url === '/v1/ad_groups/adgrp_stub') {
    const body = await new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve(JSON.parse(raw || '{}')));
    });
    if (state.failNextWrite) {
      const failure = state.failNextWrite;
      state.failNextWrite = null;
      return send(failure.status, { error: { message: failure.message } });
    }
    if (!Array.isArray(body.context_hints)) return send(400, { error: { message: 'context_hints must be an array' } });
    state.hints = body.context_hints;
    state.writes += 1;
    return send(200, { id: 'adgrp_stub', context_hints: state.hints });
  }
  if (req.method === 'GET' && req.url.startsWith('/v1/ad_account/insights')) {
    const daily = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.UTC(2026, 9, 24 - i));
      daily.push({
        readable_time: d.toISOString().slice(0, 10),
        campaign_id: 'cmpn_stub',
        country: 'IN',
        device: 'mobile',
        impressions: 1200 + i * 7,
        clicks: 60 + i,
        spend: '1378.50',
        conversions: 4,
        view_through_conversions: 1,
      });
    }
    return send(200, { object: 'list', account_currency: 'INR', data: daily, count: daily.length });
  }
  return send(404, { error: { message: `stub has no route for ${req.method} ${req.url}` } });
});

function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const call = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${API}${path}`, init);
  return { status: res.status, body: await res.json() };
};

await new Promise((r) => stub.listen(STUB, '127.0.0.1', r));

const api = spawn(process.execPath, ['server/dev.mjs'], {
  env: {
    ...process.env,
    API_PORT: String(API),
    OPENAI_ADS_API_KEY: 'test_ads_key',
    OPENAI_CONVERSIONS_API_KEY: 'test_capi_key',
    OPENAI_PIXEL_ID: 'px_stub',
    ADS_API_BASE: `http://127.0.0.1:${STUB}/v1`,
    FIRST_PARTY_SOURCE: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
api.stdout.on('data', (d) => (logs += d));
api.stderr.on('data', (d) => (logs += d));

try {
  let health = null;
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    try {
      health = (await call('/api/health')).body;
      break;
    } catch {
      /* booting */
    }
  }
  check(health?.mode === 'live', `expected live mode, got ${health?.mode}`);
  check(health.account?.name === 'Stub Ads', 'account name should come from the API');
  console.log('ok  health reports live mode and the account');

  const dataset = (await call('/api/dataset?days=30')).body;
  check(dataset.mode === 'live', 'dataset should be live');
  check(dataset.dataset.rows[0].spendMinor === 137850, 'spend must arrive as integer paise');
  check(dataset.dataset.firstPartyAvailable === false, 'first-party columns must be flagged unavailable');
  console.log('ok  insights map to minor units and flag missing first-party data');

  const pushed = ['someone who is behind on GST filing', 'a business owner asking how to reconcile GSTR-2B'];
  const push = await call('/api/adgroups/adgrp_stub/hints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hints: pushed }),
  });
  check(push.status === 200, `push failed: ${JSON.stringify(push.body)}`);
  check(push.body.previousHints.length === 2, 'the previous set must be returned for rollback');
  check(push.body.pushedHints.join('|') === pushed.join('|'), 'the pushed set must be read back from the API');
  check(state.writes === 1, 'exactly one upstream write');
  console.log('ok  push writes once and returns the previous set');

  // Guard rails before the undo: empty and PII sets must be refused locally.
  for (const [hints, code] of [[[], 'empty_hints'], [['mail me at a@b.com'], 'pii_in_hint']]) {
    const res = await call('/api/adgroups/adgrp_stub/hints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hints }),
    });
    check(res.status === 400 && res.body.error.code === code, `expected ${code}, got ${JSON.stringify(res.body)}`);
  }
  check(state.writes === 1, 'refused pushes must not reach upstream');
  console.log('ok  empty and PII sets are refused before any upstream call');

  const undo = await call('/api/adgroups/adgrp_stub/hints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hints: push.body.previousHints }),
  });
  check(undo.status === 200, `undo failed: ${JSON.stringify(undo.body)}`);
  check(undo.body.pushedHints.join('|') === push.body.previousHints.join('|'), 'undo must restore the previous set');
  check(state.hints.length === 2, 'upstream should hold the restored set again');
  console.log('ok  undo restores the previous set');

  state.failNextWrite = { status: 403, message: 'missing scope ads_write' };
  const failure = await call('/api/adgroups/adgrp_stub/hints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hints: pushed }),
  });
  check(failure.status === 403, 'upstream status must be preserved');
  check(failure.body.error.message === 'missing scope ads_write', 'upstream message must pass through verbatim');
  console.log('ok  upstream errors surface verbatim with their status');

  const leak = JSON.stringify([health, dataset, push.body]);
  check(!leak.includes('test_ads_key') && !leak.includes('test_capi_key'), 'no key may appear in any response');
  console.log('ok  no key material in any response');
} catch (error) {
  console.error(String(error));
  console.error(logs);
  process.exitCode = 1;
} finally {
  api.kill('SIGTERM');
  stub.close();
}
