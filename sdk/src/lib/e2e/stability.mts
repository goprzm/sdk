/**
 * Framework-level render stability utilities for E2E tests.
 *
 * These utilities detect rwsdk's render stability signals
 * (`data-rwsdkRender` generation counter and `window.__RWSDK_STABLE__`)
 * and provide deterministic wait helpers that work with both
 * Puppeteer and Playwright page objects.
 */

/**
 * Minimal page interface compatible with both Puppeteer's `Page`
 * and Playwright's `Page`. Both expose `evaluate` and
 * `waitForFunction` with string overloads.
 */
export interface StabilityPage {
  evaluate<T>(
    fn: string | ((...args: any[]) => T | Promise<T>),
    ...args: any[]
  ): Promise<T>;
  waitForFunction(
    fn: string | ((...args: any[]) => any),
    ...args: any[]
  ): Promise<any>;
}

/**
 * Waits until the React tree is fully stable after a render cycle.
 *
 * Uses the fastest available signal:
 * - **Layer 1** (`window.__RWSDK_STABLE__`): opt-in React idle detector
 *   installed via `initClient({ detectStability: true })`.
 * - **Layer 2** (generation counter fallback): waits for a new
 *   `data-rwsdkRender` increment, indicating at least one render committed.
 *
 * If no framework signals are present, falls back to `document.readyState`.
 */
export async function waitForStable(
  page: StabilityPage,
  timeout = 10_000,
): Promise<void> {
  const hasStabilitySignal = await page.evaluate(
    `"__RWSDK_STABLE__" in window`,
  );

  if (hasStabilitySignal) {
    await page.waitForFunction(
      `window.__RWSDK_STABLE__ === true`,
      { timeout },
    );
    return;
  }

  // Fall back to render cycle detection
  await waitForRenderCycle(page, timeout);
}

/**
 * Waits for the next RSC render cycle to commit.
 *
 * Records the current `data-rwsdkRender` generation and waits for it
 * to increment, indicating a new RSC payload was committed to the DOM.
 *
 * Falls back to `document.readyState === "complete"` when the
 * framework signal is not present.
 */
export async function waitForRenderCycle(
  page: StabilityPage,
  timeout = 10_000,
): Promise<void> {
  const hasRenderSignal = await page.evaluate(
    `"rwsdkRender" in document.documentElement.dataset`,
  );

  if (hasRenderSignal) {
    const currentGen = await page.evaluate(
      `Number(document.documentElement.dataset.rwsdkRender)`,
    );

    await page.waitForFunction(
      `Number(document.documentElement.dataset.rwsdkRender) > ${currentGen}`,
      { timeout },
    );
    return;
  }

  // No framework signals available; wait for DOM ready
  await page.waitForFunction(
    `document.readyState === "complete"`,
    { timeout },
  );
}
