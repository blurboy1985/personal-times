const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EDITION_BYTES = 4 * 1024 * 1024;
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const json = (body, status = 200) => Response.json(body, { status, headers });
const validDate = value => DATE.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

async function validUploadKey(request, env) {
  const value = request.headers.get('X-Upload-Key');
  if (!value || !env.UPLOAD_KEY) return false;
  const encode = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encode.encode(env.UPLOAD_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encode.encode(value));
  return crypto.subtle.verify('HMAC', key, signature, encode.encode(env.UPLOAD_KEY));
}

async function readEdition(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid edition');
  const parts = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_EDITION_BYTES) { await reader.cancel(); throw new Error('Edition too large'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const ed = JSON.parse(text);
  if (!validDate(ed.date) || !Number.isInteger(ed.edition_no) || typeof ed.front?.headline !== 'string' || typeof ed.front?.dek !== 'string' || !Array.isArray(ed.desks) || !Array.isArray(ed.inbox?.items) || !ed.editor) throw new Error('Invalid edition');
  return { ed, text, bytes };
}

async function index(bucket) {
  let cursor; const items = [];
  do {
    const page = await bucket.list({ prefix: 'editions/', include: ['customMetadata'], limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.objects) {
      const day = item.key.slice(9, -5);
      if (item.key.endsWith('.json') && validDate(day)) items.push({ date: day, edition_no: Number(item.customMetadata?.edition_no), headline: item.customMetadata?.headline || 'The Personal Times' });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 120);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/publish' && request.method === 'POST') {
        if (!await validUploadKey(request, env)) return json({ error: 'Upload authorization required' }, 401);
        if (!env.BUCKET) return json({ error: 'Edition storage unavailable' }, 503);
        let payload;
        try { payload = await readEdition(request); } catch { return json({ error: 'Invalid or oversized edition' }, 400); }
        const { ed, text, bytes } = payload;
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
        const options = { httpMetadata: { contentType: 'application/json; charset=utf-8' }, customMetadata: { edition_no: String(ed.edition_no), headline: ed.front.headline.slice(0, 500), sha256: digest } };
        // Preserve every distinct revision before updating the current edition.
        await env.BUCKET.put(`revisions/${ed.date}/${digest}.json`, text, options);
        await env.BUCKET.put(`editions/${ed.date}.json`, text, options);
        return json({ ok: true, date: ed.date, sha256: digest });
      }
      // Identity-less automation can upload only; it cannot read personal editions.
      if (!request.headers.get('oai-authenticated-user-id')) return json({ error: 'Sign in required' }, 401);
      if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
      if (url.pathname === '/api/editions') return json(await index(env.BUCKET));
      const match = url.pathname.match(/^\/api\/editions\/([^/]+)$/);
      if (match) {
        let day = match[1];
        if (day === 'latest') day = (await index(env.BUCKET))[0]?.date;
        if (!day || !validDate(day)) return json({ error: 'No edition for that date' }, 404);
        const object = await env.BUCKET.get(`editions/${day}.json`);
        if (!object) return json({ error: 'No edition for that date' }, 404);
        return new Response(request.method === 'HEAD' ? null : object.body, { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
      if (url.pathname === '/login') return Response.redirect(new URL('/', url), 303);
      if (url.pathname === '/' || /^\/e\/\d{4}-\d{2}-\d{2}$/.test(url.pathname)) url.pathname = '/index.html';
      const response = await env.ASSETS.fetch(new Request(url, request));
      const result = new Response(response.body, response);
      for (const [key, value] of Object.entries(headers)) result.headers.set(key, value);
      return result;
    } catch (error) {
      console.error('Edition service unavailable', { name: error.name });
      return json({ error: 'The newspaper is temporarily unavailable. Please try again.' }, 503);
    }
  },
};
