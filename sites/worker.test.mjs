import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
const origin = 'https://paper.example';
const user = { 'oai-authenticated-user-id': 'owner' };
const edition = { date: '2026-09-14', edition_no: 2, front: { headline: 'Morning', dek: 'News' }, desks: [], inbox: { items: [] }, editor: { llm: false } };
function environment() {
  const objects = new Map();
  return { UPLOAD_KEY: 'test-secret', objects, BUCKET: {
    async put(key, text, options) { objects.set(key, { key, text, ...options }); },
    async get(key) { const o = objects.get(key); return o ? { body: o.text } : null; },
    async list({ prefix }) { return { objects: [...objects.values()].filter(x => x.key.startsWith(prefix)), truncated: false }; },
  }, ASSETS: { fetch: async r => new Response(new URL(r.url).pathname) } };
}
test('anonymous reads and unauthorized writes fail closed', async () => {
  const env = environment();
  assert.equal((await worker.fetch(new Request(origin + '/api/editions'), env)).status, 401);
  assert.equal((await worker.fetch(new Request(origin + '/api/publish', { method: 'POST', headers: user, body: '{}' }), env)).status, 401);
  assert.equal(env.objects.size, 0);
});
test('verified upload, latest/back issues, immutable revisions and deep links', async () => {
  const env = environment();
  async function upload(ed) { return worker.fetch(new Request(origin + '/api/publish', { method: 'POST', headers: { 'X-Upload-Key': env.UPLOAD_KEY }, body: JSON.stringify(ed) }), env); }
  const first = await (await upload(edition)).json();
  assert.equal(first.ok, true); assert.match(first.sha256, /^[a-f0-9]{64}$/);
  await upload(edition); assert.equal(env.objects.size, 2);
  await upload({ ...edition, front: { ...edition.front, headline: 'Updated' } }); assert.equal(env.objects.size, 3);
  const latest = await (await worker.fetch(new Request(origin + '/api/editions/latest', { headers: user }), env)).json();
  assert.equal(latest.front.headline, 'Updated');
  assert.equal((await (await worker.fetch(new Request(origin + '/api/editions', { headers: user }), env)).json()).length, 1);
  assert.equal(await (await worker.fetch(new Request(origin + '/e/2026-09-14', { headers: user }), env)).text(), '/index.html');
  assert.equal((await upload({ ...edition, date: '2026-02-31' })).status, 400);
  assert.equal((await worker.fetch(new Request(origin + '/api/editions/2026-09-15', { headers: user }), env)).status, 404);
});
test('storage failures return a recoverable response without personal data', async () => {
  const env = environment(); env.BUCKET.list = () => { throw new Error('private data'); };
  const result = await worker.fetch(new Request(origin + '/api/editions', { headers: user }), env);
  assert.equal(result.status, 503); assert.ok(!(await result.text()).includes('private data'));
});
