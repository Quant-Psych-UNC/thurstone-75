(() => {
  'use strict';
  const config = window.EVENT_CONFIG;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const localMode = config.dataMode === 'local';
  const page = document.body.dataset.page || 'information';
  // Keep links from the original single-page preview working.
  const legacyPage = { '#rsvp': 'rsvp.html', '#guests': 'guests.html', '#memories': 'photos.html' }[location.hash];
  if (page === 'information' && legacyPage) {
    location.replace(legacyPage);
    return;
  }
  const RSVP_KEY = 'thurstone75.rsvp.v1';
  const state = { guests: [], photos: [], filter: 'all', response: null, selectedFile: null, activePhoto: null, urls: [], ready: false };
  let store, toastTimer, previewUrl;
  const captcha = { rsvp: null, photo: null };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function showError(selector, message = '') {
    const node = $(selector);
    if (!node) return;
    node.textContent = message;
    node.hidden = !message;
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $('#toast').textContent = message;
    $('#toast').hidden = false;
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000);
  }
  function errorMessage(error) {
    if (error?.name === 'QuotaExceededError') return 'Your browser storage is full. Remove a photo or export your preview data before trying again.';
    if (/fetch|network|load failed/i.test(error?.message || '')) return 'We couldn’t connect. Please check your connection and try again. Your form has been kept.';
    return error?.message || 'Something went wrong. Please try again.';
  }
  function safeLink(node, url) {
    if (!node) return;
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid link');
      node.href = parsed.href;
    } catch { node.hidden = true; }
  }
  function applyConfig() {
    $$('[data-config]').forEach(node => { node.textContent = config[node.dataset.config] || ''; });
    $$('[data-date]').forEach(node => { node.textContent = `${config.dateLabel}${config.year ? `, ${config.year}` : ''}`; });
    if ($('#year-note')) $('#year-note').hidden = Boolean(config.year);
    document.title = `${page === 'information' ? config.headline : document.body.dataset.pageTitle} · ${config.labName}`;
    $('meta[name="description"]').content = `Celebrate ${config.anniversary} years of ${config.labName}. Join us ${config.dateLabel} at ${config.venue}. RSVP, reconnect, and share your memories.`;
    safeLink($('#directions-link'), config.mapsUrl);
    safeLink($('#venue-link'), config.venueUrl);
    if (config.rsvpDeadline && $('#deadline-note')) {
      $('#deadline-note').textContent = `Please RSVP by ${config.rsvpDeadline}.`;
      $('#deadline-note').hidden = false;
    }
    if (config.contactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail)) {
      const link = element('a', 'text-link', 'Contact the organizers ↗');
      link.href = `mailto:${config.contactEmail}`;
      $('#contact-text').replaceChildren(link);
      $('#contact-text').hidden = false;
    }
    if (!localMode) {
      $('#preview-notice').hidden = true;
      if ($('#rsvp-storage-note')) $('#rsvp-storage-note').textContent = 'For changes after submitting, please contact the organizers.';
      if ($('#photo-mode-note')) $('#photo-mode-note').textContent = 'Photos appear publicly after organizer approval.';
      if ($('#upload-mode-note')) $('#upload-mode-note').textContent = 'Your photo will be reviewed by the organizers before appearing publicly.';
    }
    if (page === 'schedule') {
      (config.schedule || []).forEach(item => {
        const row = element('li', 'schedule-item');
        const details = element('div');
        details.append(element('h3', '', item.title));
        if (item.description) details.append(element('p', '', item.description));
        row.append(element('span', 'schedule-time', item.time), details);
        $('#schedule-list').append(row);
      });
      (config.updates || []).forEach(item => {
        const article = element('article', 'update-item');
        if (item.date) article.append(element('p', 'eyebrow', item.date));
        article.append(element('h3', '', item.title), element('p', '', item.text));
        $('#updates-list').append(article);
      });
      if (!config.updates?.length) $('#updates-list').append(element('p', '', 'No new announcements. Please check back for updates.'));
    }
    if (page === 'photos' && config.photoFolderUrl) {
      safeLink($('#photo-folder-link'), config.photoFolderUrl);
      $('#photo-folder-option').hidden = $('#photo-folder-link').hidden;
    }
  }

  class LocalStore {
    async init() {
      if (location.protocol !== 'file:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
        throw new Error('Online submissions have not been connected yet. Please contact the organizers.');
      }
      // Fail visibly if persistence is blocked; never pretend a response was saved.
      const probe = 'thurstone75.storage-check';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
    }
    async myResponse() {
      const value = localStorage.getItem(RSVP_KEY);
      return value ? JSON.parse(value) : null;
    }
    async saveResponse(response) {
      const saved = { ...response, updated_at: new Date().toISOString() };
      localStorage.setItem(RSVP_KEY, JSON.stringify(saved));
      return saved;
    }
    async guests() {
      const response = await this.myResponse();
      return response?.attendance === 'yes' && response.public_listing ? [{ name: response.name, role: response.role, years: response.years, plus_one: response.plus_one }] : [];
    }
    async db() {
      if (!this.connection) this.connection = new Promise((resolve, reject) => {
        const request = indexedDB.open('thurstone75.memories.v1', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('photos', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('Photo storage is unavailable. Use a regular browser window with local storage enabled.'));
        request.onblocked = () => reject(new Error('Please close other preview tabs and try again.'));
      });
      return this.connection;
    }
    async transaction(mode, action) {
      const db = await this.db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('photos', mode);
        const request = action(tx.objectStore('photos'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error || request.error);
        tx.onabort = () => reject(tx.error || new Error('The photo could not be saved. Please try again.'));
      });
    }
    async photos() {
      const rows = await this.transaction('readonly', table => table.getAll());
      return rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(photo => ({ ...photo, own: true, approved: true, url: URL.createObjectURL(photo.blob) }));
    }
    async addPhoto(photo, blob) {
      await this.transaction('readwrite', table => table.add({ ...photo, id: crypto.randomUUID(), blob, created_at: new Date().toISOString() }));
    }
    async deletePhoto(photo) {
      await this.transaction('readwrite', table => table.delete(photo.id));
    }
  }

  class GitHubStore {
    async init() {
      if (!config.apiUrl) throw new Error('Online submissions are not connected yet. Please contact the organizers.');
      if (['rsvp', 'photos'].includes(page) && !config.turnstileSiteKey) throw new Error('The organizers need to configure submission verification. Please try again later.');
      const endpoint = new URL(config.apiUrl);
      if (endpoint.protocol !== 'https:' || endpoint.pathname.replace(/\/$/, '') || endpoint.search || endpoint.hash) {
        throw new Error('The organizer needs to configure the HTTPS submission-service URL.');
      }
      this.endpoint = endpoint.origin;
      this.receiptKey = `thurstone75.receipt:${this.endpoint}`;
    }
    async request(path, options = {}) {
      const response = await fetch(this.endpoint + path, { ...options, credentials: 'omit' });
      let body;
      try { body = await response.json(); } catch { throw new Error('The submission service could not respond. Please try again later.'); }
      if (!response.ok) throw new Error(body.error || 'The submission could not be saved. Please try again.');
      return body;
    }
    token(kind) {
      const token = captcha[kind] !== null && window.turnstile ? window.turnstile.getResponse(captcha[kind]) : '';
      if (!token) throw new Error('Please complete the verification before submitting.');
      return token;
    }
    resetToken(kind) {
      if (captcha[kind] !== null && window.turnstile) window.turnstile.reset(captcha[kind]);
    }
    async myResponse() {
      try { return JSON.parse(localStorage.getItem(this.receiptKey) || 'null'); } catch { return null; }
    }
    async saveResponse(response) {
      const fingerprint = JSON.stringify(response);
      if (this.pendingRsvp?.fingerprint !== fingerprint) this.pendingRsvp = { fingerprint, id: crypto.randomUUID() };
      try {
        await this.request('/rsvp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...response, submission_id: this.pendingRsvp.id, captchaToken: this.token('rsvp') }) });
        const saved = { ...response, updated_at: new Date().toISOString() };
        // The receipt is only a convenience. GitHub is the shared source of truth.
        try { localStorage.setItem(this.receiptKey, JSON.stringify(saved)); } catch { /* The server already saved it. */ }
        return saved;
      } finally { this.resetToken('rsvp'); }
    }
    async guests() { return this.request('/guests'); }
    async photos() {
      const rows = await this.request('/photos');
      return rows.map(photo => ({ ...photo, own: false, approved: true, url: `${this.endpoint}/photo/${encodeURIComponent(photo.id)}` }));
    }
    async addPhoto(photo, blob) {
      if (blob.size > 1024 * 1024) throw new Error('This photo is still too large after resizing. Please use a smaller image.');
      const data = new FormData();
      data.append('file', blob, blob.type === 'image/webp' ? 'photo.webp' : 'photo.jpg');
      data.append('metadata', JSON.stringify({ ...photo, consent: true }));
      data.append('captchaToken', this.token('photo'));
      try { await this.request('/photos', { method: 'POST', body: data }); }
      finally { this.resetToken('photo'); }
    }
    async deletePhoto() { throw new Error('Please contact the organizers to remove a shared photo.'); }
  }

  function renderGuests() {
    const query = $('#guest-search').value.trim().toLocaleLowerCase();
    const filtered = state.guests.filter(guest => (state.filter === 'all' || guest.role === state.filter) && `${guest.name} ${guest.years || ''}`.toLocaleLowerCase().includes(query));
    $('#guest-list').replaceChildren();
    filtered.forEach(guest => {
      const card = element('article', 'guest-card');
      const initials = guest.name.trim().split(/\s+/).map(part => Array.from(part)[0]).slice(0, 2).join('').toLocaleUpperCase();
      const details = element('div');
      details.append(element('h3', 'guest-name', guest.name), element('p', 'guest-meta', [guest.role, guest.years].filter(Boolean).join(' · ')));
      card.append(element('span', 'guest-avatar', initials), details);
      card.append(element('span', 'guest-plus', guest.plus_one ? '+1 guest' : 'No +1'));
      $('#guest-list').append(card);
    });
    const guests = state.guests.length;
    const companions = state.guests.filter(guest => guest.plus_one).length;
    $('#guest-count').textContent = `${guests} public ${guests === 1 ? 'RSVP' : 'RSVPs'}${companions ? ` + ${companions} ${companions === 1 ? 'guest' : 'guests'}` : ''}${query || state.filter !== 'all' ? ` · ${filtered.length} shown` : ''}`;
    $('#guest-empty').hidden = guests > 0;
    $('#guest-no-results').hidden = guests === 0 || filtered.length > 0;
  }
  async function refreshGuests() {
    if (page !== 'guests') return;
    try {
      state.guests = await store.guests();
      renderGuests();
      showError('#guest-error');
    } catch (error) {
      $('#guest-count').textContent = 'Guest list temporarily unavailable';
      $('#guest-empty').hidden = true;
      showError('#guest-error', errorMessage(error));
    }
  }
  async function refreshPhotos() {
    if (page !== 'photos') return;
    try {
      const photos = await store.photos();
      state.urls.forEach(url => URL.revokeObjectURL(url));
      state.urls = photos.filter(photo => photo.url.startsWith('blob:')).map(photo => photo.url);
      state.photos = photos;
      $('#photo-grid').replaceChildren();
      photos.forEach(photo => {
        const card = element('button', 'photo-card');
        card.type = 'button';
        const image = element('img');
        image.src = photo.url;
        image.alt = photo.caption;
        image.loading = 'lazy';
        card.append(image, element('span', 'photo-caption', photo.caption), element('span', 'photo-credit', `${photo.author}${photo.year ? ` · ${photo.year}` : ''}`));
        if (!photo.approved) card.append(element('span', 'pending-badge', 'Awaiting approval · visible only to you'));
        card.addEventListener('click', () => openPhoto(photo));
        $('#photo-grid').append(card);
      });
      $('#photo-empty').hidden = photos.length > 0;
      showError('#photo-error');
    } catch (error) { showError('#photo-error', errorMessage(error)); }
  }
  function toggleAttendance() {
    const attending = $('#rsvp-form').elements.attendance.value === 'yes';
    $('#attending-fields').hidden = !attending;
    $('#plus-one-field').hidden = !$('#plus-one').checked;
    $('#rsvp-submit').firstChild.textContent = attending ? 'Send my RSVP ' : 'Send my response ';
  }
  function showResponse(response) {
    $('#rsvp-form').hidden = true;
    $('#rsvp-success').hidden = false;
    $('#success-title').textContent = response.attendance === 'yes' ? 'We’re glad you’ll be there.' : 'You’ll be missed.';
    $('#success-copy').textContent = localMode ? 'Your preview response has been saved in this browser. It has not been sent to the organizers.' : `Thank you, ${response.name}. Your response${response.plus_one ? ' for you and your guest' : ''} has been saved with the organizers.`;
    $('#success-privacy').textContent = response.attendance === 'yes' && response.public_listing ? `Your name and +1 status ${localMode ? 'appear' : 'will appear shortly'} on the guest list. Your email and notes stay private.` : 'Your response is private and does not appear on the guest list.';
  }
  async function submitRsvp(event) {
    event.preventDefault();
    showError('#rsvp-error');
    const form = event.currentTarget;
    const data = new FormData(form);
    const attending = data.get('attendance') === 'yes';
    const response = {
      name: data.get('name').trim(), email: data.get('email').trim().toLowerCase(),
      attendance: data.get('attendance'), role: data.get('role'), years: data.get('years').trim(),
      plus_one: attending && data.has('plusOne'), guest_name: attending && data.has('plusOne') ? data.get('guestName').trim() : '',
      dietary_restrictions: attending ? data.get('dietary').trim() : '',
      accessibility_needs: attending ? data.get('accessibility').trim() : '',
      notes: attending ? data.get('notes').trim() : '', public_listing: attending && data.has('publicListing')
    };
    if (!response.name) { showError('#rsvp-error', 'Please enter your name.'); form.elements.name.focus(); return; }
    $('#rsvp-submit').disabled = true;
    try {
      if (!state.ready) throw new Error('Storage is not ready. Please reload the page and try again.');
      state.response = await store.saveResponse(response);
      showResponse(state.response);
      $('#rsvp-success').setAttribute('tabindex', '-1');
      $('#rsvp-success').focus({ preventScroll: true });
      await refreshGuests();
    } catch (error) { showError('#rsvp-error', errorMessage(error)); }
    finally { $('#rsvp-submit').disabled = false; }
  }

  function openPhoto(photo) {
    state.activePhoto = photo;
    $('#lightbox-image').src = photo.url;
    $('#lightbox-image').alt = photo.caption;
    $('#lightbox-caption').textContent = photo.caption;
    $('#lightbox-credit').textContent = `Shared by ${photo.author}${photo.year ? ` · ${photo.year}` : ''}`;
    $('#lightbox-pending').hidden = photo.approved;
    $('#delete-photo').hidden = !photo.own;
    $('#delete-photo').textContent = 'Remove my photo';
    $('#delete-photo').dataset.confirm = '';
    showError('#delete-error');
    $('#photo-dialog').showModal();
  }
  function openUpload() {
    $('#upload-form').reset();
    state.selectedFile = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    $('#upload-preview').hidden = true;
    $('#upload-preview').removeAttribute('src');
    $('#drop-prompt').hidden = false;
    showError('#upload-error');
    if (state.response) $('#upload-form').elements.author.value = state.response.name;
    $('#upload-dialog').showModal();
    if (!localMode && window.turnstile) renderCaptcha('photo');
  }
  function selectFile(file) {
    showError('#upload-error');
    state.selectedFile = null;
    $('#upload-preview').hidden = true;
    $('#drop-prompt').hidden = false;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      $('#photo-file').value = '';
      showError('#upload-error', 'Please choose a JPEG, PNG, or WebP image.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      $('#photo-file').value = '';
      showError('#upload-error', 'This photo is larger than 10 MB. Choose a smaller file.');
      return;
    }
    state.selectedFile = file;
    previewUrl = URL.createObjectURL(file);
    $('#upload-preview').src = previewUrl;
    $('#upload-preview').hidden = false;
    $('#drop-prompt').hidden = true;
  }
  async function compressPhoto(file) {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (image.naturalWidth * image.naturalHeight > 60000000) throw new Error('This photo’s dimensions are too large. Please resize it and try again.');
      const scale = Math.min(1, 2000 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      // Re-encoding removes embedded EXIF metadata and keeps uploads economical.
      // All image resizing runs in the browser, not in the Worker.
      for (const quality of [0.86, 0.76, 0.66, 0.56]) {
        let blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob && blob.type !== 'image/webp') blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (!blob) throw new Error('This photo could not be processed. Please try another image.');
        if (blob.size <= 1024 * 1024) return blob;
      }
      throw new Error('This photo is still too large after resizing. Please try a smaller image.');
    } catch (error) {
      if (error.name === 'EncodingError') throw new Error('This image could not be read. Try exporting it as a new JPEG or PNG.');
      throw error;
    } finally { URL.revokeObjectURL(url); }
  }
  async function submitPhoto(event) {
    event.preventDefault();
    showError('#upload-error');
    const data = new FormData(event.currentTarget);
    const photo = { author: data.get('author').trim(), caption: data.get('caption').trim(), year: data.get('year') ? Number(data.get('year')) : null };
    if (!data.has('photoConsent')) { showError('#upload-error', 'Please confirm permission to share the photo.'); return; }
    if (!photo.author || !photo.caption) { showError('#upload-error', 'Please add your name and a few words about the photo.'); return; }
    $('#upload-submit').disabled = true;
    // Keep the dialog open during the write so a second upload cannot race it.
    $('#upload-dialog .dialog-close').disabled = true;
    try {
      if (!state.ready) throw new Error('Storage is not ready. Please reload the page and try again.');
      if (!state.selectedFile) throw new Error('Please choose a photo first.');
      const blob = await compressPhoto(state.selectedFile);
      await store.addPhoto(photo, blob);
      $('#upload-dialog').close();
      toast(localMode ? 'Photo saved in this browser.' : 'Photo received. It will appear publicly after organizer approval.');
      await refreshPhotos();
    } catch (error) { showError('#upload-error', errorMessage(error)); }
    finally { $('#upload-submit').disabled = false; $('#upload-dialog .dialog-close').disabled = false; }
  }
  async function removePhoto() {
    const button = $('#delete-photo');
    if (button.dataset.confirm !== 'yes') {
      button.dataset.confirm = 'yes';
      button.textContent = 'Click again to permanently remove this photo';
      return;
    }
    button.disabled = true;
    try {
      await store.deletePhoto(state.activePhoto);
      $('#photo-dialog').close();
      await refreshPhotos();
      toast('Photo removed.');
    } catch (error) { showError('#delete-error', errorMessage(error)); }
    finally { button.disabled = false; }
  }
  async function exportLocal() {
    const button = $('#export-local');
    button.disabled = true;
    try {
      if (!localMode) throw new Error('Preview exports are only available in local mode.');
      // Informational pages do not initialize a store until an export is requested.
      const previewStore = store || new LocalStore();
      await previewStore.init();
      const photos = await previewStore.transaction('readonly', table => table.getAll());
      const data = await Promise.all(photos.map(async photo => {
        const image = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(photo.blob);
        });
        const { blob, ...metadata } = photo;
        return { ...metadata, image };
      }));
      const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), preview_only: true, rsvp: await previewStore.myResponse(), photos: data }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = element('a');
      link.href = url;
      link.download = 'thurstone-75-local-preview.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Preview export downloaded, including your private RSVP details and photos.');
    } catch (error) { toast(errorMessage(error)); }
    finally { button.disabled = false; }
  }
  function renderCaptcha(kind) {
    if (captcha[kind] !== null || !window.turnstile || !config.turnstileSiteKey) return;
    captcha[kind] = window.turnstile.render(`#${kind}-captcha`, { sitekey: config.turnstileSiteKey, theme: 'light', size: 'flexible', action: kind });
  }
  function setupCaptcha() {
    if (localMode || !config.turnstileSiteKey || !['rsvp', 'photos'].includes(page)) return;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onload = () => {
      if (page === 'rsvp') renderCaptcha('rsvp');
      else if ($('#upload-dialog').open) renderCaptcha('photo');
    };
    script.onerror = () => toast('Verification could not load. Check your connection and reload before submitting.');
    document.head.append(script);
  }

  function bindEvents() {
    if (page === 'guests') {
      $$('.filter').forEach(button => button.addEventListener('click', () => {
        state.filter = button.dataset.filter;
        $$('.filter').forEach(filter => { filter.classList.toggle('active', filter === button); filter.setAttribute('aria-pressed', String(filter === button)); });
        renderGuests();
      }));
      $('#guest-search').addEventListener('input', renderGuests);
      $('#clear-search').addEventListener('click', () => { $('#guest-search').value = ''; $('[data-filter="all"]').click(); });
      window.addEventListener('storage', event => { if (localMode && event.key === RSVP_KEY) refreshGuests(); });
    }
    if (page === 'rsvp') {
      $('#rsvp-form').addEventListener('submit', submitRsvp);
      $$('[name="attendance"]').forEach(input => input.addEventListener('change', toggleAttendance));
      $('#plus-one').addEventListener('change', toggleAttendance);

    }
    if (page === 'photos') {
      $$('.upload-open').forEach(button => button.addEventListener('click', openUpload));
      $$('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
      $('#upload-dialog').addEventListener('cancel', event => { if ($('#upload-submit').disabled) event.preventDefault(); });
      $('#photo-file').addEventListener('change', event => selectFile(event.target.files[0]));
      const drop = $('#drop-zone');
      ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('dragover'); }));
      ['dragleave', 'drop'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragover'); }));
      drop.addEventListener('drop', event => {
        if (event.dataTransfer.files.length !== 1) { showError('#upload-error', 'Please add one photo at a time.'); return; }
        $('#photo-file').files = event.dataTransfer.files;
        selectFile(event.dataTransfer.files[0]);
      });
      $('#upload-form').addEventListener('submit', submitPhoto);
      $('#delete-photo').addEventListener('click', removePhoto);
    }
    $('#export-local')?.addEventListener('click', exportLocal);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.ready && !$('#photo-dialog')?.open && !$('#upload-dialog')?.open) {
        refreshGuests();
        refreshPhotos();
      }
    });
  }
  async function init() {
    applyConfig();
    bindEvents();
    if (!['rsvp', 'guests', 'photos'].includes(page)) return;
    setupCaptcha();
    try {
      if (!['local', 'github'].includes(config.dataMode)) throw new Error('The dataMode in config.js must be local or github.');
      store = localMode ? new LocalStore() : new GitHubStore();
      await store.init();
      state.ready = true;
      if (page === 'guests') await refreshGuests();
      if (page === 'photos') await refreshPhotos();
      if (page === 'rsvp' || page === 'photos') {
        state.response = await store.myResponse();
        if (page === 'rsvp' && state.response) {
          showResponse(state.response);
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      showError('#rsvp-error', message);
      showError('#guest-error', message);
      showError('#photo-error', message);
      if ($('#guest-count')) $('#guest-count').textContent = 'Guest list unavailable';
    }
  }
  init();
})();
