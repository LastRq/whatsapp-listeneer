const PROJECT_ID = 'kindevads';
const DEFAULT_API_KEY = 'AIzaSyDuY8r3OQ08dG-JEk_XSs08M2U8e56W5J8';
export function createFirebaseClient({ apiKey = process.env.KINDEVADS_FIREBASE_API_KEY || DEFAULT_API_KEY, fetcher = fetch, now = Date.now } = {}) {
  let token = '';
  let refreshToken = '';
  let expiresAt = 0;
  let authenticating = null;
  async function authenticate() {
    if (token && expiresAt > now() + 60000) return token;
    if (!authenticating) authenticating = (async () => {
      let response;
      if (refreshToken) {
        response = await fetcher('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(apiKey), {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }), signal: AbortSignal.timeout(10000)
        });
      }
      if (!response?.ok) {
        response = await fetcher('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + encodeURIComponent(apiKey), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ returnSecureToken: true }), signal: AbortSignal.timeout(10000)
        });
      }
      const data = await response.json();
      if (!response.ok) throw new Error('Firebase authentication: ' + (data.error?.message || response.status));
      token = data.idToken || data.id_token;
      refreshToken = data.refreshToken || data.refresh_token;
      expiresAt = now() + Number(data.expiresIn || data.expires_in || 3600) * 1000;
      if (!token) throw new Error('Firebase did not return an authentication token.');
      return token;
    })().finally(() => { authenticating = null; });
    return authenticating;
  }
  async function request(url, options = {}) {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://firestore.googleapis.com' || !(parsed.pathname.startsWith('/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/') || [':runQuery', ':commit'].some(suffix => parsed.pathname === '/v1/projects/' + PROJECT_ID + '/databases/(default)/documents' + suffix))) {
      throw new Error('The listener only writes and reads the official kindevads project.');
    }
    const run = async () => fetcher(url, {
      ...options,
      headers: { ...Object.fromEntries(new Headers(options.headers)), Authorization: 'Bearer ' + await authenticate() },
      signal: options.signal || AbortSignal.timeout(15000)
    });
    let response = await run();
    if (response.status === 401) { token = ''; expiresAt = 0; response = await run(); }
    return response;
  }
  return { request, authenticate };
}
export const firebaseClient = createFirebaseClient();
export const firestoreFetch = firebaseClient.request;
export const FIREBASE_PROJECT_ID = PROJECT_ID;
export function listenerTenantId(value = process.env.TENANT_ID || 'kindev') {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('TENANT_ID must be the account identifier from Kindev Ads.');
  return value;
}
export const TENANT_ID = listenerTenantId();
