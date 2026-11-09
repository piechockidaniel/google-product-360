import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end smoke test: the same path a prospect walks in the demo tour.
 * Runs against DEMO_MODE (see playwright.config.ts) – deterministic synthetic data, English UI.
 */

const DEMO = { username: 'demo', password: 'demo1234' };

async function login(page: Page): Promise<void> {
  // English UI regardless of the browser default (the app remembers the choice in localStorage).
  await page.addInitScript(() => localStorage.setItem('gmc.lang', 'en'));
  await page.goto('/');
  await page.getByLabel('Username').fill(DEMO.username);
  await page.getByLabel('Password').fill(DEMO.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test.describe('Product360 demo – smoke', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('dashboard shows the demo tour and the Product360 insights', async ({ page }) => {
    await expect(page.getByText('Product360 demo – 5-minute tour')).toBeVisible();
    await expect(page.getByText('Product360 – performance & market')).toBeVisible();
    // Recommendation tiles: every product has exactly one recommendation -> the counts add up to the catalogue size.
    const tiles = page.locator('.reco-tile .reco-count');
    await expect(tiles).toHaveCount(8);
    const counts = await tiles.allTextContents();
    const total = counts.reduce((sum, c) => sum + Number(c), 0);
    await expect(page.locator('.stats-row').first().locator('.stat-value').first()).toHaveText(String(total));
    await expect(page.getByText('Organic impressions (7d)')).toBeVisible(); // Search Console connector is on in the demo
    await expect(page.getByRole('heading', { name: /Focus – scale these/ })).toBeVisible();
  });

  test('products can be filtered by recommendation and the 360° view is populated', async ({ page }) => {
    await page.goto('/products?recommendation=REPRICE&orderBy=clicks7d&orderDir=desc');
    const rows = page.locator('table.table-products tbody tr');
    await expect(rows.first()).toBeVisible();
    const badges = rows.locator('.badge', { hasText: 'Reprice' });
    expect(await badges.count()).toBe(await rows.count());

    await rows.first().locator('td a').first().click();
    await expect(page.getByRole('heading', { name: /Recommendation/ })).toBeVisible();
    await expect(page.locator('.reason-list li').first()).toBeVisible();
    await expect(page.getByText('Price position (Market Insights)')).toBeVisible();
    await expect(page.locator('.chart-svg').first()).toBeVisible();

    // Organic card: load the top queries and take one into the enrichment form as a title idea.
    await expect(page.getByText('Organic search (Search Console)')).toBeVisible();
    await page.getByRole('button', { name: 'Load queries from Search Console' }).click();
    const queryRows = page.locator('table.table-compact tbody tr', { hasText: /%/ });
    await expect(queryRows.first()).toBeVisible();
    await page.getByRole('button', { name: '→ title' }).first().click();
    await expect(page.getByText(/Search query idea:/)).toBeVisible();
    await page.getByRole('button', { name: 'Append to title' }).click();
    await expect(page.locator('input[value*=" "]').first()).toBeVisible();
  });

  test('product table scrolls horizontally and keeps actions visible', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/products');
    const scroll = page.locator('.products-table-scroll');
    const action = scroll.locator('tbody tr').first().locator('.actions button');
    await expect(action).toBeVisible();
    const dimensions = await scroll.evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
    expect(dimensions.content).toBeGreaterThan(dimensions.width);
    const bounds = await scroll.boundingBox();
    const button = await action.boundingBox();
    expect(bounds && button).toBeTruthy();
    expect(button!.x + button!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
    await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    expect(await scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  });

  test('WooCommerce page shows match diagnostics and orders', async ({ page }) => {
    await page.route('**/api/woocommerce/reconciliation**', async (route) => route.fulfill({ json: {
      syncedAt: '2026-11-09T00:00:00Z', summary: { matched: 1, ambiguous: 1, unmatched: 0, no_sku: 0, merchantOnly: 0 }, total: 2,
      items: [
        { wooId: 1, parentId: null, sku: 'SKU1', name: 'Store product', type: 'simple', price: '10', stockStatus: 'instock', status: 'matched', candidates: [{ productId: 'encoded', offerId: 'SKU1', title: 'Google product', mappedWooId: null }] },
        { wooId: 2, parentId: null, sku: 'SKU2', name: 'Duplicate', type: 'simple', price: '', stockStatus: 'instock', status: 'ambiguous', candidates: [] },
      ],
    } }));
    await page.route('**/api/woocommerce/orders**', async (route) => route.fulfill({ json: { total: 1, items: [{ id: 42, number: '42', status: 'processing', total: '10.00', currency: 'PLN', line_items: [{ id: 1, name: 'Store product', quantity: 1 }] }] } }));
    await page.goto('/woocommerce');
    await expect(page.getByRole('heading', { name: 'Product matching' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'SKU1' })).toHaveAttribute('href', '/products/encoded');
    await expect(page.getByRole('row', { name: /Duplicate/ })).toContainText('Ambiguous');
    await expect(page.getByRole('row', { name: /processing/ })).toContainText('10.00');
    await expect(page.getByRole('row', { name: /processing/ })).toContainText('PLN');
  });

  test('market page lists best sellers including items not carried', async ({ page }) => {
    await page.goto('/market?carried=false');
    await expect(page.getByRole('heading', { name: 'Market' })).toBeVisible();
    const rows = page.locator('table.table tbody tr');
    await expect(rows.first()).toBeVisible();
    await expect(page.locator('.badge', { hasText: 'not carried' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Competitor visibility/ })).toBeVisible();
  });

  test('a pre-installed workflow runs successfully from the UI', async ({ page }) => {
    await page.goto('/workflows');
    const row = page.locator('table tbody tr', { hasText: 'Product360 – scale label' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Run now' }).click();
    const runs = page.locator('table tbody tr', { hasText: 'Product360 – scale label' }).filter({ hasText: 'manual' });
    await expect(runs.first()).toContainText(/success/i, { timeout: 30_000 });
  });

  test('settings show both connectors and a passing connection test', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('Product360 – metrics & signals')).toBeVisible();
    const connectorRow = page.locator('table tbody tr', { hasText: 'Merchant Center reports' });
    await connectorRow.getByRole('button', { name: 'Test connection' }).click();
    await expect(connectorRow.getByText('Product performance')).toBeVisible();
    await expect(connectorRow.locator('.badge', { hasText: '✓' }).first()).toBeVisible();
    await expect(page.locator('table tbody tr', { hasText: 'Google Search Console' }).first()).toContainText(/success/i);
  });

  test('"simulate a day" refreshes data and reports changes', async ({ page }) => {
    await page.getByRole('button', { name: 'Simulate a day' }).click();
    await expect(page.locator('.toast', { hasText: /Day simulated/ })).toBeVisible({ timeout: 30_000 });
  });
});
