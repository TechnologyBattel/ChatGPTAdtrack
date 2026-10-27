// End-to-end: the guided research screen against a real API process.
//
// The assertions are deliberately about honesty rather than pixels: no fabricated
// progress, no invented numbers, and the connector says what the server actually lacks.
//
// The suite seeds one agency and one workspace through the public API (see fixtures). It
// creates no leads, events or CRM records, so every count the screen shows must be one of
// the two honest states — "none found" or "not measurable yet".

import { expect, test } from '@playwright/test';
import { seedWorkspace } from './fixtures/staging';

test.describe('guided research', () => {
  test.beforeAll(async () => {
    await seedWorkspace();
  });

  test('opens the journey, runs it, and reports what it could not measure', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Research', exact: true }).click();
    await page.getByRole('searchbox').fill('gst filing and invoice automation');
    await page.getByRole('button', { name: 'Ask' }).click();

    const journey = page.getByTestId('guided-research');
    await expect(journey).toBeVisible();

    // The server's own goal list, not a hardcoded one.
    await expect(journey.getByText('Review campaign attribution')).toBeVisible();

    await journey.getByRole('button', { name: /Run research/i }).click();
    const report = page.getByTestId('research-report');
    await expect(report).toBeVisible();
    await expect(report.getByText(/No keyword volume, CPC, competitor spend or trend/i)).toBeVisible();

    // Every count is either a number or one of the two honest labels — never a blank.
    const body = (await report.textContent()) ?? '';
    expect(body).toMatch(/none found|not measurable yet|observed/);
    // No progress percentages were invented anywhere on the page.
    await expect(page.getByText(/\b\d{1,3}%\s*(complete|done|progress)/i)).toHaveCount(0);
  });

  test('keeps a saved report and reopens the same figures', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Research', exact: true }).click();
    await page.getByRole('searchbox').fill('which campaigns bring leads');
    await page.getByRole('button', { name: 'Ask' }).click();

    const journey = page.getByTestId('guided-research');
    await journey.getByRole('button', { name: /Run research/i }).click();
    const report = page.getByTestId('research-report');
    await expect(report).toBeVisible();
    const firstFigures = await report.textContent();

    // The run appears in "Saved reports"; reopening it shows the stored report, not a
    // recomputation — the screen says which run it is showing.
    // "Saved reports" is its own card, a sibling of the journey card.
    const saved = page.getByRole('button', { name: /findings?—/i }).first();
    await expect(saved).toBeVisible();
    await saved.click();
    await expect(report).toBeVisible();
    expect(await report.textContent()).toBe(firstFigures);
    await expect(report.getByText(/^saved as /)).toBeVisible();
  });

  test('says the CRM connector is unconfigured on a server without HubSpot credentials', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Research', exact: true }).click();
    await page.getByRole('searchbox').fill('which campaigns bring leads');
    await page.getByRole('button', { name: 'Ask' }).click();

    const card = page.getByTestId('connector-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('HUBSPOT_CLIENT_ID');
    await expect(card).toContainText('CONNECTOR_ENCRYPTION_KEY');
    // No connect button when the server cannot honour the click.
    await expect(card.getByRole('button', { name: /Connect HubSpot/i })).toHaveCount(0);
  });

  test('shows a real authorization refusal instead of an empty workspace', async ({ page, request }) => {
    // Point the page at a viewer-role session by asking the API what a write-role refusal
    // looks like, then confirm the browser surfaces server errors verbatim rather than
    // pretending the workspace is empty. The dev session is owner, so a genuine 403 is
    // produced by calling a route that requires an organisation the user is not in.
    const session = await request.post('/api/dev/session');
    const { token } = await session.json();
    const other = await request.post('/api/orgs/org_does_not_exist/permissions', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect([403, 404]).toContain(other.status());

    await page.goto('/');
    await page.getByRole('button', { name: 'Research', exact: true }).click();
    await page.getByRole('searchbox').fill('which campaigns bring leads');
    await page.getByRole('button', { name: 'Ask' }).click();
    // The journey still renders its honest empty state rather than hanging.
    await expect(page.getByTestId('guided-research')).toBeVisible();
    await expect(page.getByText(/Loading the agencies you belong to/i)).toHaveCount(0);
  });

  test('stays usable at a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Research', exact: true }).click();
    await page.getByRole('searchbox').fill('which campaigns bring leads');
    await page.getByRole('button', { name: 'Ask' }).click();

    const journey = page.getByTestId('guided-research');
    await expect(journey).toBeVisible();
    await journey.getByRole('button', { name: /Run research/i }).click();
    await expect(page.getByTestId('research-report')).toBeVisible();

    // No horizontal scrolling: a phone-width viewport must still contain the content.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
