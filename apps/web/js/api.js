// Fetch wrapper + SSE. A 401 anywhere sends the app to the login screen.

export class HttpError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
  }
}

export async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/auth/login') {
    window.dispatchEvent(new CustomEvent('auth-required'));
  }
  if (!res.ok) throw new HttpError(res.status, data);
  return data;
}

export const api = {
  login: (username, password) => request('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/me'),
  farms: () => request('/farms'),
  overview: (farmId) => request(`/farms/${farmId}/overview`),
  pond: (id) => request(`/ponds/${id}`),
  readings: (id, range) => request(`/ponds/${id}/readings?range=${encodeURIComponent(range)}`),
  unit: (id) => request(`/units/${id}`),
  unitReadings: (id, range) => request(`/units/${id}/readings?range=${encodeURIComponent(range)}`),
};

/**
 * Open the farm event stream. EventSource reconnects by itself; we surface state changes.
 * @param {number} farmId
 * @param {{onPonds: Function, onUnits: Function, onFarm: Function, onHello: Function, onState: Function}} h
 */
export function openStream(farmId, h) {
  const es = new EventSource(`/api/stream?farm=${farmId}`);
  h.onState?.('connecting');
  es.addEventListener('hello', (e) => {
    h.onState?.('live');
    h.onHello?.(JSON.parse(e.data));
  });
  es.addEventListener('ponds', (e) => h.onPonds?.(JSON.parse(e.data)));
  es.addEventListener('units', (e) => h.onUnits?.(JSON.parse(e.data)));
  es.addEventListener('farm', (e) => h.onFarm?.(JSON.parse(e.data)));
  es.onerror = () => h.onState?.(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
  return () => es.close();
}
