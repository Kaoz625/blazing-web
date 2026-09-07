// Approved test identity for feature suites. The app still passes its real gate.
export async function prepareProfile(context, profile = {}, device = { id: 'dev-1', token: 'tok' }) {
  const viewer = {
    id: 'p1', name: 'Mark', hasPin: false,
    maxRating: profile.isKids ? 'general' : 'adult',
    ...profile,
  };
  await context.addInitScript((identity) => {
    localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify(identity));
  }, device);
  await context.route('https://fleet.lyreosai.com/profiles?*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ profiles: [viewer] }),
  }));
}

/**
 * Reach the state "this viewer is chosen", however the app gets there.
 *
 * It used to be one click. It cannot be, now that a browser which already
 * remembers a viewer restores them and CLOSES THE GATE ITSELF — the button is
 * never painted, and waiting for it times out on a page that is already in the
 * exact state this helper exists to produce. That is what broke
 * stream-controls.smoke.mjs, whose reload() step re-enters a remembered
 * session, and it is a pass, not a regression.
 *
 * Polled rather than raced so a slow gate cannot be mistaken for a restored
 * one, and so the timeout says which of the two outcomes never arrived.
 */
export async function selectProfile(page, name = 'Mark') {
  const button = page.getByRole('button', { name: `Choose ${name}`, exact: true });
  const gateClosed = () => page.evaluate(() => document.querySelector('.bp-layer')?.hidden !== false);
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await gateClosed().catch(() => false)) return;
    if (await button.isVisible().catch(() => false)) { await button.click(); return; }
    await page.waitForTimeout(150);
  }
  throw new Error(`selectProfile: saw neither a "Choose ${name}" button nor a closed gate within 25s`);
}
