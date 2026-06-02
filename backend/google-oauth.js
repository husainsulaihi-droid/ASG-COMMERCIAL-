/**
 * Google "Sign in with Google" (OAuth 2.0 / OpenID Connect) helper.
 *
 * This is a thin, dependency-free wrapper around Google's OAuth endpoints
 * (Node 22 has global fetch, so no extra packages are needed).
 *
 * Configuration comes from environment variables, set in the systemd unit:
 *   GOOGLE_CLIENT_ID       — OAuth web-client ID   (required to enable)
 *   GOOGLE_CLIENT_SECRET   — OAuth web-client secret (required to enable)
 *   GOOGLE_REDIRECT_URI    — optional override; otherwise derived from the
 *                            incoming request as <proto>://<host>/api/auth/google/callback
 *
 * If the client id/secret are absent, isEnabled() returns false and the
 * whole feature stays dormant — the login route 404s and the frontend
 * hides the button. So shipping this code changes nothing until the env
 * vars are populated.
 *
 * Security model: Google verifies the user and returns their *verified*
 * email. The caller (routes-auth.js) then matches that email against the
 * `users` table (active rows only) — only emails already on a user record
 * can sign in. Unverified emails are rejected outright.
 */

const AUTH_ENDPOINT  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

function clientId()     { return process.env.GOOGLE_CLIENT_ID || ''; }
function clientSecret() { return process.env.GOOGLE_CLIENT_SECRET || ''; }

/** Feature flag: Google login is only active when both creds are present. */
function isEnabled() {
  return !!(clientId() && clientSecret());
}

/**
 * The redirect URI must EXACTLY match one registered in the Google console.
 * We derive it from the request so it works behind nginx (which sets
 * X-Forwarded-Proto/Host), with an env override as an escape hatch.
 */
function getRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const proto = (req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/auth/google/callback`;
}

/** Build the Google consent-screen URL to redirect the browser to. */
function buildAuthUrl({ state, redirectUri }) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    include_granted_scopes: 'true',
    // Always show the account chooser so users can pick which Google account
    // to use (helps people with multiple accounts log in with the right one).
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Exchange the one-time `code` from the callback for the user's profile.
 * Returns { email, emailVerified, name } or throws on any failure.
 */
async function exchangeCodeForProfile({ code, redirectUri }) {
  // 1. code -> access token
  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '');
    throw new Error(`token exchange failed (${tokenRes.status}): ${detail.slice(0, 200)}`);
  }
  const tokens = await tokenRes.json();
  if (!tokens.access_token) throw new Error('token exchange returned no access_token');

  // 2. access token -> verified profile
  const infoRes = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) {
    const detail = await infoRes.text().catch(() => '');
    throw new Error(`userinfo failed (${infoRes.status}): ${detail.slice(0, 200)}`);
  }
  const info = await infoRes.json();
  return {
    email: (info.email || '').trim().toLowerCase(),
    // Google returns email_verified as boolean or the string "true".
    emailVerified: info.email_verified === true || info.email_verified === 'true',
    name: info.name || null,
  };
}

module.exports = {
  isEnabled,
  getRedirectUri,
  buildAuthUrl,
  exchangeCodeForProfile,
};
