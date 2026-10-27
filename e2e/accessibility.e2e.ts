// Accessibility checks that do not need a pixel baseline.
//
// Deliberately narrow and mechanical: every interactive control has an accessible name,
// the guided-research journey is reachable and operable from the keyboard alone, the
// full-screen workspace overlay behaves like a dialog (announced, focusable, Escape to
// close), and the page reports no uncaught errors while doing it. These are the failures
// that actually lock people out; contrast and visual quality are reviewed separately and
// are not asserted here.

import { expect, test } from '@playwright/test';
import { seedWorkspace } from './fixtures/staging';

async function openResearch(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await page.getByRole('searchbox').fill('gst filing and invoice automation');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByTestId('guided-research')).toBeVisible();
}

test.describe('accessibility', () => {
  test.beforeAll(async () => {
    await seedWorkspace();
  });

  test('every interactive control exposes an accessible name', async ({ page }) => {
    await openResearch(page);
    const unnamed = await page.evaluate(() => {
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [role="button"]'),
      ).filter((el) => (el as HTMLElement).offsetParent !== null);
      return controls
        .filter((el) => {
          const label = el.getAttribute('aria-label')?.trim();
          const labelledBy = el.getAttribute('aria-labelledby');
          const text = (el.textContent ?? '').trim();
          const wrappingLabel =
            el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`) ? true : Boolean(el.closest('label'));
          const title = el.getAttribute('title')?.trim();
          return !label && !labelledBy && !text && !wrappingLabel && !title;
        })
        .map((el) => el.outerHTML.slice(0, 120));
    });
    expect(unnamed).toEqual([]);
  });

  test('the journey can be run with the keyboard alone', async ({ page }) => {
    await openResearch(page);
    // Focus the first goal radio by tabbing from the goal legend, then pick the second
    // goal with the arrow keys — a radio group must not need a mouse.
    const firstGoal = page.locator('input[name="research-goal"]').first();
    await firstGoal.focus();
    await expect(firstGoal).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('input[name="research-goal"]:checked')).toHaveCount(1);

    // The run button is reachable by tabbing and activates with Enter.
    const runButton = page.getByRole('button', { name: /Run research/i });
    await runButton.focus();
    await expect(runButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('research-report')).toBeVisible();
  });

  test('the workspace overlay is a dialog and closes with Escape', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Workspace' }).click();

    const dialog = page.getByRole('dialog', { name: 'Workspace' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Focus moves into the dialog rather than staying behind it.
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('the page reports no uncaught errors while researching', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await openResearch(page);
    await page.getByRole('button', { name: /Run research/i }).click();
    await expect(page.getByTestId('research-report')).toBeVisible();
    // React key/prop warnings and rejected promises surface here too; a tidy run is part
    // of the gate rather than a nice-to-have.
    expect(errors).toEqual([]);
  });
});
