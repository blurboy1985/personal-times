// Passkeys via the browser's native WebAuthn API. The server speaks JSON with
// base64url fields; the browser wants ArrayBuffers — these helpers translate.

const toBuffer = (b64url) => {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
};

const toB64url = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const passkeysSupported = () => typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;

async function post(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, reauth: data.reauth });
  return data;
}

const common = (cred) => ({
  id: cred.id,
  rawId: toB64url(cred.rawId),
  type: cred.type,
  authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
  clientExtensionResults: cred.getClientExtensionResults(),
});

/** Create a passkey on this device and register it (requires a recent sign-in). */
export async function registerPasskey(name) {
  const options = await post('/api/passkey/register/options');
  const cred = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBuffer(options.challenge),
      user: { ...options.user, id: toBuffer(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: toBuffer(c.id) })),
    },
  });
  const r = cred.response;
  return post('/api/passkey/register/verify', {
    name,
    credential: {
      ...common(cred),
      response: {
        clientDataJSON: toB64url(r.clientDataJSON),
        attestationObject: toB64url(r.attestationObject),
        transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
      },
    },
  });
}

/** Sign in with a discoverable passkey — no username needed. */
export async function signInWithPasskey() {
  const options = await post('/api/passkey/login/options');
  const cred = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: toBuffer(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: toBuffer(c.id) })),
    },
  });
  const r = cred.response;
  return post('/api/passkey/login/verify', {
    credential: {
      ...common(cred),
      response: {
        clientDataJSON: toB64url(r.clientDataJSON),
        authenticatorData: toB64url(r.authenticatorData),
        signature: toB64url(r.signature),
        userHandle: r.userHandle ? toB64url(r.userHandle) : null,
      },
    },
  });
}

export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Passkey';
}
