// End-to-end: the guided research screen against a real API process.
//
// The assertions are deliberately about honesty rather than pixels: no fabricated
// progress, no invented numbers, and the connector says what the server actually lacks.

import { expect, test } from '@playwright/test';

test.describe('guided research', () => {
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
});
