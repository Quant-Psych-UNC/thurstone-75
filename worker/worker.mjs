import { Buffer } from 'node:buffer';

// All durable data lives in the configured PRIVATE GitHub repository.
// Never add tokens here. Configure them as Cloudflare Worker secrets.
const RSVP_PATH = 'data/rsvps.json';
const PHOTO_PATH = 'data/photos.json';
const MAX_PHOTO = 1024 * 1024;
const MAX_LIST = 900000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const roles = ['Alumni', 'Current member', 'Friend / colleague'];
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});
function string(value, label, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') fail(400, `Please check ${label}.`);
  const clean = value.trim();
  if ((required && !clean) || clean.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clean)) fail(400, `Please check ${label}.`);
  return clean;
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Please check the form and try again.');
  return value;
}
function parseJSON(value) {
  try { return JSON.parse(value); } catch { fail(400, 'The form could not be read. Please try again.'); }
}
function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'Please reload the form and try again.');
  return value.toLowerCase();
}
async function boundedBody(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) fail(413, 'The submission is too large.');
  if (!request.body) fail(400, 'The submission is empty.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail(413, 'The submission is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
function validateRsvp(input) {
  const data = object(input);
  if (!['yes', 'no'].includes(data.attendance) || !roles.includes(data.role)) fail(400, 'Please select attendance and your connection to the lab.');
  if (typeof data.plus_one !== 'boolean' || typeof data.public_listing !== 'boolean') fail(400, 'Please check your guest and public-list preferences.');
  const email = string(data.email, 'your email', 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email address.');
  const attending = data.attendance === 'yes';
  return {
    id: id(data.submission_id), name: string(data.name, 'your name', 100, true), email,
    attendance: data.attendance, role: data.role, years: string(data.years, 'lab years', 50),
    plus_one: attending && data.plus_one,
    guest_name: attending && data.plus_one ? string(data.guest_name, 'your guest’s name', 100) : '',
    dietary_restrictions: attending ? string(data.dietary_restrictions, 'food restrictions', 500) : '',
    accessibility_needs: attending ? string(data.accessibility_needs, 'accessibility needs', 500) : '',
    notes: attending ? string(data.notes, 'your note', 1000) : '', public_listing: attending && data.public_listing
  };
}
function validatePhoto(input) {
  const data = object(input);
  if (data.consent !== true) fail(400, 'Permission to publish the photo is required.');
  if (data.year !== null && data.year !== undefined && (!Number.isInteger(data.year) || data.year < 1900 || data.year > 2100)) fail(400, 'Please check the photo year.');
  return {
    author: string(data.author, 'your name', 100, true),
    caption: string(data.caption, 'the caption', 500, true), year: data.year ?? null, consent: true
  };
}
function imageType(bytes, claimed) {
  const jpeg = bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const detected = jpeg ? 'image/jpeg' : webp ? 'image/webp' : '';
  if (!detected || detected !== claimed) fail(400, 'Please upload a JPEG or WebP photo through the website.');
  return detected;
}
function photoPath(photo) {
  if (!UUID.test(photo.id) || !['image/jpeg', 'image/webp'].includes(photo.mime)) fail(503, 'A photo is temporarily unavailable.');
  return `photos/${photo.id}.${photo.mime === 'image/webp' ? 'webp' : 'jpg'}`;
}

// Injectable fetch/cache keep tests completely offline; no live submissions are made.
export function createWorker({ fetcher = globalThis.fetch, publicCache } = {}) {
  async function remote(url, options = {}) {
    try { return await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15000), ...options }); }
    catch { fail(503, 'The submission service could not connect. Please try again shortly.'); }
  }
  function settings(env) {
    let origin;
    try { origin = new URL(env.SITE_ORIGIN); } catch { fail(503, 'Online submissions are not configured yet.'); }
    if (origin.protocol !== 'https:' || origin.origin !== env.SITE_ORIGIN ||
        !/^[\w.-]+$/.test(env.GITHUB_OWNER || '') || !/^[\w.-]+$/.test(env.GITHUB_REPO || '') ||
        !env.GITHUB_BRANCH || !env.GITHUB_TOKEN || !env.TURNSTILE_SECRET) fail(503, 'Online submissions are not configured yet.');
    return origin;
  }
  async function verifyCaptcha(token, action, origin, env) {
    token = string(token, 'the verification', 2048, true);
    const response = await remote('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token })
    });
    if (!response.ok) fail(503, 'Verification is temporarily unavailable. Please try again.');
    const result = await response.json();
    if (!result.success || result.hostname !== origin.hostname || result.action !== action) fail(403, 'Verification expired or failed. Please complete it again.');
  }
  async function repository(env) {
    const base = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
    const headers = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Thurstone-Anniversary'
    };
    const metadata = await remote(base, { headers });
    if (!metadata.ok) fail(503, 'The organizers need to check the storage connection.');
    if ((await metadata.json()).private !== true) fail(503, 'Submissions require private storage. Please contact the organizers.');
    const fileUrl = path => `${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    async function readList(path) {
      const response = await remote(`${fileUrl(path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`, { headers });
      if (response.status === 404) return { rows: [], sha: undefined };
      if (!response.ok) fail(503, 'The saved responses are temporarily unavailable.');
      const file = await response.json();
      if (file.type !== 'file' || file.encoding !== 'base64' || file.size > MAX_LIST) fail(503, 'The organizers need to check the data file.');
      let rows;
      try { rows = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); } catch { fail(503, 'The organizers need to check the data file.'); }
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail(503, 'The organizers need to check the data file.');
      return { rows, sha: file.sha };
    }
    async function put(path, content, sha) {
      return remote(fileUrl(path), {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Save anniversary submission', content: content.toString('base64'), branch: env.GITHUB_BRANCH, ...(sha ? { sha } : {}) })
      });
    }
    return {
      readList,
      async append(path, row, duplicate, maximum) {
        // Compare-and-swap retries preserve submissions that arrive together.
        for (let attempt = 0; attempt < 5; attempt++) {
          const { rows, sha } = await readList(path);
          if (duplicate(rows)) return;
          if (rows.length >= maximum) fail(503, 'The organizers need to review the submission limit.');
          const bytes = Buffer.from(JSON.stringify([...rows, row], null, 2) + '\n');
          if (bytes.length > MAX_LIST) fail(503, 'The organizers need to review the storage limit.');
          const response = await put(path, bytes, sha);
          if (response.ok) return;
          if (![409, 422].includes(response.status)) fail(503, 'Your submission could not be confirmed. Please try again shortly.');
        }
        fail(503, 'Several submissions arrived together. Please try again shortly.');
      },
      async createImage(path, bytes) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const response = await put(path, bytes);
          if (response.ok) return;
          if (![409, 422].includes(response.status)) break;
        }
        fail(503, 'Your photo could not be confirmed. Please try again shortly.');
      },
      async image(path) {
        const response = await remote(`${fileUrl(path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`, {
          headers: { ...headers, Accept: 'application/vnd.github.raw+json' }
        });
        if (!response.ok) fail(503, 'This photo is temporarily unavailable.');
        return response.body;
      }
    };
  }
  async function publicRead(request, env, ctx, build) {
    const cache = publicCache === undefined ? globalThis.caches?.default : publicCache;
    const key = new URL(request.url);
    // Isolate cache entries if the repository or branch configuration changes.
    key.search = new URLSearchParams({ repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`, branch: env.GITHUB_BRANCH }).toString();
    const cacheKey = new Request(key.toString());
    let cached;
    try { cached = await cache?.match(cacheKey); } catch { /* Cache failure does not block reads. */ }
    if (cached) return cached;
    const response = await build();
    response.headers.set('Cache-Control', `public, max-age=${key.pathname.startsWith('/photo/') ? 300 : 30}`);
    if (cache) {
      const write = cache.put(cacheKey, response.clone()).catch(() => {});
      if (ctx?.waitUntil) ctx.waitUntil(write); else await write;
    }
    return response;
  }
  async function route(request, env, ctx, origin) {
    const path = new URL(request.url).pathname;
    if (request.method === 'OPTIONS') {
      if (!['/rsvp', '/photos'].includes(path)) fail(404, 'Not found.');
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' } });
    }
    if (request.method === 'GET' && (path === '/guests' || path === '/photos' || /^\/photo\/[0-9a-f-]+$/i.test(path))) {
      return publicRead(request, env, ctx, async () => {
        const repo = await repository(env);
        if (path === '/guests') {
          const { rows } = await repo.readList(RSVP_PATH);
          return json(rows.filter(r => r.attendance === 'yes' && r.public_listing === true).map(r => ({
            name: r.name, role: r.role, years: r.years, plus_one: r.plus_one === true
          })));
        }
        const { rows } = await repo.readList(PHOTO_PATH);
        if (path === '/photos') return json(rows.filter(p => p.approved === true).reverse().map(p => ({ id: p.id, author: p.author, caption: p.caption, year: p.year })));
        const photoId = path.slice('/photo/'.length);
        if (!UUID.test(photoId)) fail(404, 'Photo not found.');
        const photo = rows.find(p => p.id === photoId && p.approved === true);
        if (!photo) fail(404, 'Photo not found.');
        return new Response(await repo.image(photoPath(photo)), { headers: { 'Content-Type': photo.mime, 'Content-Disposition': 'inline' } });
      });
    }
    if (request.method !== 'POST' || !['/rsvp', '/photos'].includes(path)) fail(404, 'Not found.');
    if (env.SUBMISSIONS_OPEN !== 'true') fail(403, 'Submissions are closed. Please contact the organizers.');
    if (path === '/rsvp') {
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, 'Please submit using the RSVP form.');
      const input = object(parseJSON((await boundedBody(request, 24000)).toString('utf8')));
      const record = validateRsvp(input);
      await verifyCaptcha(input.captchaToken, 'rsvp', origin, env);
      const repo = await repository(env);
      await repo.append(RSVP_PATH, { ...record, created_at: new Date().toISOString() }, rows => {
        const existing = rows.find(r => r.email?.trim().toLowerCase() === record.email || r.id === record.id);
        if (!existing) return false;
        // Retrying the exact same request is safe; no public editing endpoint exists.
        if (Object.entries(record).every(([key, value]) => existing[key] === value)) return true;
        fail(409, 'A response for this email is already saved. Please contact the organizers for changes.');
      }, 500);
      return json({ ok: true }, 201);
    }
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.startsWith('multipart/form-data;')) fail(415, 'Please upload through the photo form.');
    const body = await boundedBody(request, MAX_PHOTO + 24000);
    let form;
    try { form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData(); }
    catch { fail(400, 'The upload could not be read.'); }
    const photo = validatePhoto(parseJSON(string(form.get('metadata'), 'the photo details', 6000, true)));
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function' || file.size < 1 || file.size > MAX_PHOTO) fail(413, 'Please choose a smaller photo.');
    const bytes = Buffer.from(await file.arrayBuffer());
    const mime = imageType(bytes, file.type);
    await verifyCaptcha(form.get('captchaToken'), 'photo', origin, env);
    const repo = await repository(env);
    const record = { ...photo, id: crypto.randomUUID(), mime, approved: false, created_at: new Date().toISOString() };
    const existingPhotos = await repo.readList(PHOTO_PATH);
    if (existingPhotos.rows.length >= 1000 || Buffer.byteLength(JSON.stringify([...existingPhotos.rows, record], null, 2) + '\n') > MAX_LIST) {
      fail(503, 'The organizers need to review the photo storage limit.');
    }
    // Image first, then metadata. An interrupted second write leaves a private
    // orphan, never a publicly listed or partly approved image. See setup guide.
    await repo.createImage(photoPath(record), bytes);
    await repo.append(PHOTO_PATH, record, rows => rows.some(p => p.id === record.id), 1000);
    return json({ ok: true }, 201);
  }
  return {
    async fetch(request, env, ctx) {
      let allowedOrigin, response;
      try {
        const origin = settings(env);
        const suppliedOrigin = request.headers.get('Origin');
        if ((suppliedOrigin && suppliedOrigin !== origin.origin) ||
            (['POST', 'OPTIONS'].includes(request.method) && suppliedOrigin !== origin.origin)) fail(403, 'Please submit from the anniversary website.');
        allowedOrigin = suppliedOrigin;
        response = await route(request, env, ctx, origin);
      } catch (error) {
        response = json({ error: error instanceof HttpError ? error.message : 'The service is temporarily unavailable. Please try again.' }, error instanceof HttpError ? error.status : 503);
      }
      // Public cache entries contain only explicitly projected public fields.
      const result = new Response(response.body, response);
      result.headers.set('X-Content-Type-Options', 'nosniff');
      result.headers.set('Referrer-Policy', 'no-referrer');
      result.headers.set('Vary', 'Origin');
      if (allowedOrigin) result.headers.set('Access-Control-Allow-Origin', allowedOrigin);
      return result;
    }
  };
}

export default createWorker();
