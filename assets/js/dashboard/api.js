/* The dashboard's whole network surface.
 *
 * Auth is GoTrue over REST; the data goes through the SAME four edge functions
 * the phone uses (`pull`, `push`, `entitlement`, `export`), never straight at
 * the tables. That matters for `push`: the relay validates the HLC against its
 * own clock and settles each envelope applied / stale / rejected, so writing
 * through it is the only way a web edit lands under the same rules a phone edit
 * does.
 *
 * The publishable key below is public by design. It identifies the project and
 * grants nothing: row-level security ties every row in `changes` and
 * `entitlements` to `owner_id = auth.uid()`, so a reader only ever sees their
 * own log, and only with their own access token.
 */

export const SUPABASE_URL = 'https://wyvawvpyiuiqfmegflke.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_Rt8XLJrMJrkgpVir0hhjjg_5JJlyPL7';

const SESSION_KEY = 'jotlift.session';
const VERIFIER_KEY = 'jotlift.pkce';

/** A network or server failure the page can retry. Never shown as a data loss. */
export class ApiError extends Error {
  constructor(reason, status) {
    super(`${reason}${status ? ` (${status})` : ''}`);
    this.name = 'ApiError';
    this.reason = reason; // 'network' | 'auth' | 'entitlement' | 'server'
    this.status = status;
  }
}

/* ------------------------------------------------------------------ session */

let session = readStoredSession();

function readStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.refresh_token ? parsed : null;
  } catch {
    return null;
  }
}

function storeSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* A reader with storage blocked stays signed in for this tab only. */
  }
}

export function currentUser() {
  return session ? session.user : null;
}

export function hasSession() {
  return session != null;
}

function normalise(body) {
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    // GoTrue returns expires_in (seconds); anchor it to this clock once.
    expires_at: body.expires_at
      ? body.expires_at * 1000
      : Date.now() + (body.expires_in ?? 3600) * 1000,
    user: body.user
      ? {
          id: body.user.id,
          email: body.user.email,
          // "Signed in with": the provider the identity came from.
          provider: body.user.app_metadata?.provider || 'email',
        }
      : null,
  };
}

async function auth(path, body, extraHeaders) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_KEY,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json.error_description || json.msg || json.message || '';
    const error = new ApiError(res.status === 400 || res.status === 401 ? 'auth' : 'server', res.status);
    error.detail = message;
    throw error;
  }
  return json;
}

/** Email and password. The web never signs anybody UP: the copy says to sign in
 *  on the phone first, because that is what puts data here to read. */
export async function signInWithPassword(email, password) {
  const body = await auth('token?grant_type=password', { email, password });
  storeSession(normalise(body));
  return session;
}

/**
 * A valid access token, refreshed when it is close to expiring. Every caller
 * goes through here, so a long-open tab never fires a request with a dead token.
 */
let refreshing = null;
export async function accessToken() {
  if (!session) return null;
  if (session.expires_at - Date.now() > 60_000) return session.access_token;
  if (!refreshing) {
    refreshing = auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      .then((body) => {
        storeSession(normalise(body));
        return session.access_token;
      })
      .catch((error) => {
        // A refresh that the server DECLINED is a real sign-out; a network
        // failure is not, and must not throw the reader out of their own page.
        if (error.reason === 'auth') storeSession(null);
        throw error;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export async function signOut() {
  const token = session ? session.access_token : null;
  storeSession(null);
  if (!token) return;
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}` },
    });
  } catch {
    /* The local session is already gone, which is what sign out means here. */
  }
}

/* --------------------------------------------------------------- OAuth PKCE */

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Start Continue with Apple / Continue with Google. PKCE, so the code that
 *  comes back on the redirect is worthless without the verifier in this tab. */
export async function signInWithOAuth(provider) {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(random);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  try {
    sessionStorage.setItem(VERIFIER_KEY, verifier);
  } catch {
    throw new ApiError('auth');
  }
  const redirect = `${location.origin}${location.pathname}`;
  const url =
    `${SUPABASE_URL}/auth/v1/authorize?provider=${encodeURIComponent(provider)}` +
    `&redirect_to=${encodeURIComponent(redirect)}` +
    `&code_challenge=${challenge}&code_challenge_method=s256`;
  location.assign(url);
}

/**
 * Finish a redirect back from a provider. Handles both shapes: an authorization
 * code (PKCE) and tokens in the fragment (implicit), plus the provider saying
 * no. Returns a message to show, or null when this was an ordinary page load.
 */
export async function completeRedirect() {
  const query = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));

  const failure = query.get('error_description') || hash.get('error_description') || query.get('error') || hash.get('error');
  if (failure) {
    clean();
    return decodeURIComponent(failure.replace(/\+/g, ' '));
  }

  const code = query.get('code');
  if (code) {
    let verifier = null;
    try {
      verifier = sessionStorage.getItem(VERIFIER_KEY);
      sessionStorage.removeItem(VERIFIER_KEY);
    } catch {
      /* fall through to the missing-verifier message below */
    }
    clean();
    if (!verifier) return 'That sign-in link was opened in a different tab. Try again here.';
    try {
      const body = await auth('token?grant_type=pkce', { auth_code: code, code_verifier: verifier });
      storeSession(normalise(body));
      return null;
    } catch (error) {
      return error.detail || 'We could not finish signing you in. Try again.';
    }
  }

  if (hash.get('access_token')) {
    storeSession(
      normalise({
        access_token: hash.get('access_token'),
        refresh_token: hash.get('refresh_token'),
        expires_in: Number(hash.get('expires_in')) || 3600,
      }),
    );
    clean();
    // The implicit grant carries no user object, so read it back.
    await loadUser();
    return null;
  }
  return null;
}

function clean() {
  history.replaceState(null, '', location.pathname);
}

async function loadUser() {
  const token = await accessToken();
  if (!token) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const user = await res.json();
    storeSession({
      ...session,
      user: { id: user.id, email: user.email, provider: user.app_metadata?.provider || 'email' },
    });
  } catch {
    /* The session is valid either way; only the email line goes unfilled. */
  }
}

/* ------------------------------------------------------- the relay endpoints */

async function edge(name, body) {
  const token = await accessToken();
  if (!token) throw new ApiError('auth', 401);

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_KEY,
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network');
  }

  if (res.ok) return res.json();
  if (res.status === 401 || res.status === 403) throw new ApiError('auth', res.status);
  if (res.status === 402) throw new ApiError('entitlement', res.status);
  throw new ApiError('server', res.status);
}

/**
 * The whole change feed, paged. `pull` is cursor based: each page returns the
 * cursor to ask for next and whether more is waiting.
 */
export async function pullAll(onProgress) {
  const rows = [];
  let cursor = 0;
  for (let page = 0; page < 200; page++) {
    const body = await edge('pull', { cursor, limit: 1000 });
    const changes = body.changes || [];
    rows.push(...changes);
    if (onProgress) onProgress(rows.length);
    cursor = body.cursor ?? cursor;
    if (!body.has_more || changes.length === 0) break;
  }
  return rows;
}

/** Push edited rows back through the relay. Returns the per-envelope results. */
export async function push(envelopes) {
  const body = await edge('push', { envelopes });
  return body.results || [];
}

/**
 * The entitlement mirror. Mapped exactly as the app maps it
 * (features/billing/logic/mirror.ts): an `active` whose expiry has passed is
 * `lapsed`, not active.
 */
export async function entitlement() {
  const body = await edge('entitlement');
  const now = Date.now();
  const unexpired = body.expires_at == null || new Date(body.expires_at).getTime() > now;
  let state = 'none';
  if (body.status === 'active' && unexpired) state = 'active';
  else if (body.status === 'lapsed' || (body.status === 'active' && !unexpired)) state = 'lapsed';
  return { state, expiresAt: body.expires_at ?? null, product: body.product ?? null };
}

/**
 * The one-off cloud export of the whole server feed. Deliberately NOT gated on
 * entitlement (D38/D47): the only requirement is a signed-in token, so a lapsed
 * reader is never held hostage to their own log.
 */
export function cloudExport() {
  return edge('export');
}
