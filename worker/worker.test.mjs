import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createWorker } from './worker.mjs';

const env = {
  SITE_ORIGIN: 'https://lab-example.github.io', GITHUB_OWNER: 'lab-example',
  GITHUB_REPO: 'private-data', GITHUB_BRANCH: 'main', GITHUB_TOKEN: 'test-only-secret',
  TURNSTILE_SECRET: 'test-only-turnstile', SUBMISSIONS_OPEN: 'true'
};
const rsvpId = '00000000-0000-4000-8000-000000000001';
const nextId = '00000000-0000-4000-8000-000000000002';
const rsvp = (extra = {}) => ({
  submission_id: rsvpId, name: 'Test Alumni', email: 'test@example.com', attendance: 'yes', role: 'Alumni',
  years: '2008–2013', plus_one: true, guest_name: 'Private Guest',
  dietary_restrictions: 'Private food request', accessibility_needs: 'Private access request',
  notes: 'Private note', public_listing: true, captchaToken: 'rsvp', ...extra
});
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
function fixture(options = {}) {
  const files = new Map();
  const calls = [];
  let revision = 0;
  const seed = (path, data) => files.set(path, { bytes: Buffer.from(JSON.stringify(data)), sha: String(++revision) });
  const read = path => JSON.parse(files.get(path).bytes.toString('utf8'));
  const fetcher = async (url, init = {}) => {
    url = new URL(url); calls.push({ url: url.toString(), method: init.method || 'GET' });
    if (url.hostname === 'challenges.cloudflare.com') {
      const body = JSON.parse(init.body);
      assert.equal(body.secret, env.TURNSTILE_SECRET);
      return response({ success: body.response !== 'bad', hostname: options.captchaHostname || 'lab-example.github.io', action: body.response });
    }
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    const prefix = '/repos/lab-example/private-data';
    if (url.pathname === prefix) return response({ private: options.private !== false });
    const path = decodeURIComponent(url.pathname.slice(`${prefix}/contents/`.length));
    const current = files.get(path);
    if (init.method === 'PUT') {
      const data = JSON.parse(init.body);
      assert.equal(data.branch, 'main');
      assert.equal(data.message, 'Save anniversary submission');
      if (options.failPath === path) return response({ secret: 'upstream-private-message' }, 500);
      if ((current && current.sha !== data.sha) || (!current && data.sha)) return response({}, 409);
      const saved = { bytes: Buffer.from(data.content, 'base64'), sha: String(++revision) };
      files.set(path, saved);
      return response({ content: { sha: saved.sha } }, 201);
    }
    assert.equal(init.method || 'GET', 'GET');
    assert.equal(url.searchParams.get('ref'), 'main');
    if (!current) return response({}, 404);
    if (init.headers.Accept === 'application/vnd.github.raw+json') return new Response(current.bytes);
    return response({ type: 'file', encoding: 'base64', content: current.bytes.toString('base64'), sha: current.sha, size: current.bytes.length });
  };
  const worker = createWorker({ fetcher, publicCache: options.cache || null });
  const invoke = (path, init = {}, customEnv = env) => worker.fetch(new Request(`https://test-worker.example${path}`, init), customEnv);
  const postRsvp = (data = rsvp(), extra = {}) => invoke('/rsvp', {
    method: 'POST', headers: { Origin: env.SITE_ORIGIN, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(data)
  });
  const postPhoto = (metadata = {}, bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]), type = 'image/jpeg') => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), 'test.jpg');
    form.append('metadata', JSON.stringify({ author: 'Test Author', caption: 'Test photo', year: 2008, consent: true, ...metadata }));
    form.append('captchaToken', 'photo');
    return invoke('/photos', { method: 'POST', headers: { Origin: env.SITE_ORIGIN }, body: form });
  };
  return { files, calls, seed, read, invoke, postRsvp, postPhoto };
}

test('RSVP retains private details while every public response uses an explicit projection', async () => {
  const f = fixture();
  assert.equal((await f.postRsvp()).status, 201);
  const stored = f.read('data/rsvps.json')[0];
  assert.equal(stored.email, 'test@example.com');
  assert.equal(stored.guest_name, 'Private Guest');
  assert.equal(stored.accessibility_needs, 'Private access request');
  assert.equal(stored.dietary_restrictions, 'Private food request');
  assert.equal(stored.captchaToken, undefined);
  const result = await f.invoke('/guests', { headers: { Origin: env.SITE_ORIGIN } });
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), env.SITE_ORIGIN);
  assert.deepEqual(await result.json(), [{ name: 'Test Alumni', role: 'Alumni', years: '2008–2013', plus_one: true }]);
  assert.equal((await f.invoke('/rsvp')).status, 404);
  assert.equal((await f.invoke('/data/rsvps.json')).status, 404);
});

test('declined and opted-out responses never appear in the public list', async () => {
  const f = fixture();
  assert.equal((await f.postRsvp(rsvp({ attendance: 'no' }))).status, 201);
  assert.equal((await f.postRsvp(rsvp({ submission_id: nextId, email: 'hidden@example.com', public_listing: false }))).status, 201);
  assert.deepEqual(await (await f.invoke('/guests')).json(), []);
  const declined = f.read('data/rsvps.json')[0];
  for (const key of ['plus_one', 'public_listing']) assert.equal(declined[key], false);
  for (const key of ['guest_name', 'dietary_restrictions', 'accessibility_needs', 'notes']) assert.equal(declined[key], '');
});

test('an exact retry is idempotent; duplicate email and all editing attempts are rejected', async () => {
  const f = fixture();
  await f.postRsvp();
  assert.equal((await f.postRsvp()).status, 201);
  assert.equal(f.read('data/rsvps.json').length, 1);
  assert.equal((await f.postRsvp(rsvp({ submission_id: nextId, email: 'TEST@EXAMPLE.COM' }))).status, 409);
  assert.equal((await f.postRsvp(rsvp({ name: 'Changed name' }))).status, 409);
  assert.equal((await f.invoke('/rsvp', { method: 'PATCH', headers: { Origin: env.SITE_ORIGIN } })).status, 404);
  assert.equal(f.read('data/rsvps.json')[0].name, 'Test Alumni');
});

test('simultaneous submissions do not overwrite each other', async () => {
  const f = fixture();
  const results = await Promise.all([
    f.postRsvp(), f.postRsvp(rsvp({ submission_id: nextId, email: 'second@example.com', name: 'Second Guest' }))
  ]);
  assert.deepEqual(results.map(r => r.status), [201, 201]);
  assert.deepEqual(f.read('data/rsvps.json').map(r => r.name).sort(), ['Second Guest', 'Test Alumni']);
});

test('invalid origin, CAPTCHA, and field types are rejected without writes', async () => {
  const f = fixture();
  assert.equal((await f.postRsvp(rsvp(), { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.postRsvp(rsvp({ captchaToken: 'bad' }))).status, 403);
  assert.equal((await f.postRsvp(rsvp({ captchaToken: 'photo' }))).status, 403);
  assert.equal((await f.postRsvp(rsvp({ public_listing: 'true' }))).status, 400);
  assert.equal((await f.postRsvp(rsvp({ email: 'invalid' }))).status, 400);
  assert.equal((await f.postRsvp(rsvp({ name: 'x'.repeat(101) }))).status, 400);
  assert.equal(f.files.size, 0);
  const wrongHost = fixture({ captchaHostname: 'other.example' });
  assert.equal((await wrongHost.postRsvp()).status, 403);
});

test('public repository and unconfigured or closed service fail safely', async () => {
  const f = fixture({ private: false });
  assert.equal((await f.postRsvp()).status, 503);
  assert.equal(f.files.size, 0);
  assert.equal((await f.invoke('/guests', {}, { ...env, GITHUB_TOKEN: '' })).status, 503);
  const request = { method: 'POST', headers: { Origin: env.SITE_ORIGIN } };
  assert.equal((await f.invoke('/rsvp', request, { ...env, SUBMISSIONS_OPEN: 'false' })).status, 403);
});

test('request limits are enforced from actual streamed bytes, not Content-Length alone', async () => {
  const f = fixture();
  const result = await f.invoke('/rsvp', {
    method: 'POST', headers: { Origin: env.SITE_ORIGIN, 'Content-Type': 'application/json' }, body: 'x'.repeat(24001)
  });
  assert.equal(result.status, 413);
  assert.equal(f.files.size, 0);
});

test('photo stays private until approved; no raw repository URLs or private metadata are returned', async () => {
  const f = fixture();
  assert.equal((await f.postPhoto({ approved: true })).status, 201);
  const rows = f.read('data/photos.json');
  assert.equal(rows[0].approved, false);
  const path = `/photo/${rows[0].id}`;
  assert.deepEqual(await (await f.invoke('/photos')).json(), []);
  assert.equal((await f.invoke(path)).status, 404);
  rows[0].approved = true;
  f.seed('data/photos.json', rows);
  assert.deepEqual(await (await f.invoke('/photos')).json(), [{ id: rows[0].id, author: 'Test Author', caption: 'Test photo', year: 2008 }]);
  const image = await f.invoke(path);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await image.arrayBuffer()).byteLength, 8);
  rows[0].approved = false;
  f.seed('data/photos.json', rows);
  assert.equal((await f.invoke(path)).status, 404);
});

test('uploads require consent, an image signature and a bounded image size', async () => {
  const f = fixture();
  assert.equal((await f.postPhoto({ consent: false })).status, 400);
  assert.equal((await f.postPhoto({}, Buffer.from('<html>not a photo</html>'))).status, 400);
  assert.equal((await f.postPhoto({}, Buffer.alloc(1024 * 1024 + 1))).status, 413);
  assert.equal((await f.postPhoto({ year: 1800 })).status, 400);
  assert.equal(f.files.size, 0);
});

test('an interrupted photo metadata write cannot make the orphan image public', async () => {
  const f = fixture({ failPath: 'data/photos.json' });
  const result = await f.postPhoto();
  assert.equal(result.status, 503);
  assert.doesNotMatch(await result.text(), /upstream-private-message|test-only-secret/);
  assert.deepEqual(await (await f.invoke('/photos')).json(), []);
  const imageName = [...f.files.keys()][0];
  assert.match(imageName, /^photos\//);
  assert.equal((await f.invoke(`/photo/${imageName.split('/')[1].split('.')[0]}`)).status, 404);
});

test('public caches contain only sanitized responses and have a short lifetime', async () => {
  const saved = new Map();
  const cache = {
    match: async request => saved.get(request.url)?.clone(),
    put: async (request, value) => saved.set(request.url, value.clone())
  };
  const f = fixture({ cache });
  await f.postRsvp();
  const first = await f.invoke('/guests');
  assert.equal(first.headers.get('Cache-Control'), 'public, max-age=30');
  assert.equal(saved.size, 1);
  const publicText = await [...saved.values()][0].clone().text();
  assert.doesNotMatch(publicText, /email|test@example|Private|notes|created_at/);
  const previousCalls = f.calls.length;
  await f.invoke('/guests');
  assert.equal(f.calls.length, previousCalls);
});

test('CORS preflight permits only the configured website', async () => {
  const f = fixture();
  const good = await f.invoke('/rsvp', { method: 'OPTIONS', headers: { Origin: env.SITE_ORIGIN } });
  assert.equal(good.status, 204);
  assert.equal(good.headers.get('Access-Control-Allow-Origin'), env.SITE_ORIGIN);
  const bad = await f.invoke('/rsvp', { method: 'OPTIONS', headers: { Origin: 'https://other.example' } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
});

test('a full photo archive rejects uploads before writing another image', async () => {
  const f = fixture();
  f.seed('data/photos.json', Array.from({ length: 1000 }, (_, n) => ({ id: String(n), approved: false })));
  assert.equal((await f.postPhoto()).status, 503);
  assert.equal(f.files.size, 1);
  assert.equal(f.read('data/photos.json').length, 1000);
});
