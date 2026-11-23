// Hash-route helpers shared by the shell and pages.

export function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = h.split('?');
  return { path, query: new URLSearchParams(qs) };
}

/** Update query params of the current route without adding a history entry. */
export function setQuery(params) {
  const { path, query } = parseHash();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === '' || v === undefined) query.delete(k);
    else query.set(k, v);
  }
  const qs = query.toString();
  history.replaceState(history.state, '', `#${path}${qs ? `?${qs}` : ''}`);
}

export function saveScroll(path) {
  if (path) sessionStorage.setItem(`scroll:${path}`, String(window.scrollY));
}

export function restoreScroll(path) {
  const y = Number(sessionStorage.getItem(`scroll:${path}`) ?? 0);
  requestAnimationFrame(() => window.scrollTo(0, y));
}

/** Go back if we came from inside the app, otherwise to a fallback route. */
export function goBack(fallback = '#/') {
  if (Number(sessionStorage.getItem('sff-nav-depth') ?? 0) > 0) {
    history.back();
  } else {
    location.hash = fallback;
  }
}
