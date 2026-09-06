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

export async function selectProfile(page, name = 'Mark') {
  await page.getByRole('button', { name: `Choose ${name}`, exact: true }).click();
}
