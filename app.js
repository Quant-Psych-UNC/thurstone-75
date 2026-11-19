(() => {
  'use strict';
  const config = window.EVENT_CONFIG || {};
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const page = document.body.dataset.page || 'information';
  const legacyPage = { '#guests': 'guests.html', '#memories': 'photos.html' }[location.hash];
  if (page === 'information' && legacyPage) {
    location.replace(legacyPage);
    return;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function publicUrl(value, kind) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      const googleForm = (url.hostname === 'forms.gle' && /^\/[^/]+\/?$/.test(url.pathname)) ||
        (url.hostname === 'docs.google.com' && /^\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?[^/]+\/viewform\/?$/.test(url.pathname));
      const dropbox = ['www.dropbox.com', 'dropbox.com'].includes(url.hostname);
      if (kind === 'rsvp' && !googleForm) return '';
      if (kind === 'upload' && !(dropbox && /^\/request\/[^/]+\/?$/.test(url.pathname))) return '';
      // Galleries must be shared links, never a Dropbox account's private folder path.
      if (kind === 'gallery' && !(dropbox && /^\/(?:sh\/[^/]+\/[^/]+|scl\/fo\/[^/]+\/[^/]+)\/?$/.test(url.pathname))) return '';
      return url.href;
    } catch { return ''; }
  }

  function connectLink(id, value, kind, pendingId) {
    const link = $(id);
    if (!link) return;
    const url = publicUrl(value, kind);
    link.hidden = !url;
    if (url) link.href = url;
    else link.removeAttribute('href');
    const pending = pendingId && $(pendingId);
    if (pending) pending.hidden = Boolean(url);
  }

  function initCountdown() {
    const countdown = $('#event-countdown');
    if (!countdown || !/^\d{4}$/.test(config.year)) return;

    // Read the same event date that appears in the header.
    const date = /(?:^|,\s*)([A-Za-z]+)\s+(\d{1,2})$/.exec(config.dateLabel?.trim());
    if (!date) return;
    const months = 'January February March April May June July August September October November December'.split(' ');
    const month = months.indexOf(date[1]);
    const day = Number(date[2]);
    const eventDay = Date.UTC(Number(config.year), month, day);
    if (month < 0 || new Date(eventDay).getUTCDate() !== day) return;

    const easternDate = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric'
    });
    function updateCountdown() {
      const today = Object.fromEntries(easternDate.formatToParts(new Date()).map(part => [part.type, part.value]));
      // Subtract calendar dates so daylight-saving changes never shift the count.
      const daysLeft = (eventDay - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000;
      countdown.hidden = daysLeft < 0;
      if (daysLeft < 0) return;
      countdown.textContent = daysLeft === 0 ? 'Today’s the day' : `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} to go`;
    }

    updateCountdown();
    if (!countdown.hidden) setInterval(updateCountdown, 60_000);
  }

  function applyConfig() {
    $$('[data-config]').forEach(node => { node.textContent = config[node.dataset.config] || ''; });
    $$('[data-date]').forEach(node => { node.textContent = `${config.dateLabel}${config.year ? `, ${config.year}` : ''}`; });
    if ($('#year-note')) $('#year-note').hidden = Boolean(config.year);
    document.title = `${page === 'information' ? config.headline : document.body.dataset.pageTitle} · ${config.labName}`;
    $('meta[name="description"]').content = `Celebrate ${config.anniversary} years of ${config.labName}. Join us ${config.dateLabel}, ${config.year} at ${config.venue}.`;
    connectLink('#directions-link', config.mapsUrl);
    connectLink('#venue-link', config.venueUrl);
    connectLink('#rsvp-link', config.rsvpFormUrl, 'rsvp', '#rsvp-pending');
    connectLink('#photo-upload-link', config.dropboxRequestUrl, 'upload', '#photo-upload-pending');
    connectLink('#photo-gallery-link', config.photoGalleryUrl, 'gallery', '#photo-gallery-pending');
    if (config.rsvpDeadline && $('#deadline-note')) {
      $('#deadline-note').textContent = `Please RSVP by ${config.rsvpDeadline}.`;
      $('#deadline-note').hidden = false;
    }
    if (config.contactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail)) {
      const link = element('a', 'text-link', 'Contact us ↗');
      link.href = `mailto:${config.contactEmail}`;
      $('#contact-text').replaceChildren(link);
      $('#contact-text').hidden = false;
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
  }

  function initGuests() {
    if (page !== 'guests') return;
    const data = window.PUBLIC_GUEST_LIST;
    const allowed = ['name', 'role', 'years'];
    const roles = ['Alumni', 'Current member', 'Friend / colleague', ''];
    // Only the separate, explicitly public list is read. No private RSVP service is contacted.
    // Validation is not a privacy barrier: every byte of public-guests.js is public.
    const valid = data && typeof data.updated === 'string' && Array.isArray(data.guests) &&
      data.guests.every(guest => guest && typeof guest === 'object' &&
        Object.keys(guest).every(key => allowed.includes(key)) &&
        typeof guest.name === 'string' && guest.name.trim().length > 0 &&
        (guest.role === undefined || roles.includes(guest.role)) &&
        (guest.years === undefined || typeof guest.years === 'string'));
    if (!valid) {
      $('#guest-count').textContent = 'Guest list temporarily unavailable.';
      $('#guest-error').textContent = 'Please check back soon or contact the organizers.';
      $('#guest-error').hidden = false;
      $('#guest-tools').hidden = true;
      return;
    }
    const guests = data.guests.slice().sort((a, b) => a.name.localeCompare(b.name));
    let filter = 'all';
    $('#guest-tools').hidden = guests.length === 0;
    if (data.updated.trim()) {
      $('#guest-updated').textContent = `Last updated ${data.updated.trim()}.`;
      $('#guest-updated').hidden = false;
    }
    function render() {
      const query = $('#guest-search').value.trim().toLocaleLowerCase();
      const filtered = guests.filter(guest => (filter === 'all' || guest.role === filter) &&
        `${guest.name} ${guest.years || ''}`.toLocaleLowerCase().includes(query));
      $('#guest-list').replaceChildren();
      filtered.forEach(guest => {
        const card = element('article', 'guest-card');
        const initials = guest.name.trim().split(/\s+/).map(part => Array.from(part)[0]).slice(0, 2).join('').toLocaleUpperCase();
        const details = element('div');
        details.append(element('h3', 'guest-name', guest.name));
        const meta = [guest.role, guest.years].filter(Boolean).join(' · ');
        if (meta) details.append(element('p', 'guest-meta', meta));
        const avatar = element('span', 'guest-avatar', initials);
        avatar.setAttribute('aria-hidden', 'true');
        card.append(avatar, details);
        $('#guest-list').append(card);
      });
      $('#guest-count').textContent = `${guests.length} ${guests.length === 1 ? 'person' : 'people'} on the public list${query || filter !== 'all' ? ` · ${filtered.length} shown` : ''}`;
      $('#guest-empty').hidden = guests.length > 0;
      $('#guest-no-results').hidden = guests.length === 0 || filtered.length > 0;
      $$('[data-filter]').forEach(button => {
        const active = button.dataset.filter === filter;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }
    $$('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; render(); }));
    $('#guest-search').addEventListener('input', render);
    $('#clear-search').addEventListener('click', () => { filter = 'all'; $('#guest-search').value = ''; render(); $('#guest-search').focus(); });
    render();
  }

  if (page === 'rsvp-redirect') {
    location.replace(publicUrl(config.rsvpFormUrl, 'rsvp') || 'index.html#rsvp');
    return;
  }

  applyConfig();
  initCountdown();
  initGuests();
})();
