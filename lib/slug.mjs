export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// Availability means permission to publish, not that the slug is unused.
export async function chooseSlug(base, { replace, check }) {
  if (replace !== undefined) {
    if (!SLUG_RE.test(replace)) throw new Error('--replace must name a valid deck slug');
    const result = await check(replace);
    if (result.available !== true) throw new Error(`Can't replace ${replace}: ${result.reason || 'availability check failed'}`);
    if (result.exists !== true) throw new Error(`Can't replace ${replace}: no existing deck. Omit --replace to create a new deck.`);
    return replace;
  }

  for (let n = 1; n <= 100; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const slug = base.slice(0, 64 - suffix.length).replace(/-+$/, '') + suffix;
    const result = await check(slug);
    if (result.available === true && result.exists === false) return slug;
    // Do not turn auth/server failures (or an incomplete response) into retries.
    const collision = (result.available === true && result.exists === true)
      || (result.available === false && result.reason === 'another team already has a deck with this name');
    if (!collision) throw new Error(`Can't publish as ${slug}: ${result.reason || 'availability check failed'}.`);
  }
  throw new Error(`Couldn't find a free slug for ${base}. Pick another name.`);
}
