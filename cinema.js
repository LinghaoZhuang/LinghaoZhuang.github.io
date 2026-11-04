/*
 * Linghao Zhuang — cinematic homepage, part 2: direction.
 *
 * Two independent layers. The page scrolls natively, so reading is never tied to the renderer.
 * Behind it the hall plays on its own, like a film in long takes: the camera glides slowly between
 * a few viewpoints for the current chapter, and re-frames gently when the chapter changes.
 * Nothing in the camera reacts to the mouse or to scroll speed. The renderer lives in cinema-gl.js.
 * The look and feel is inspired by CineShader by Lusion (cineshader.com); all code here is original.
 */
(async () => {
  'use strict';

  window.__cinemaBooted = true;

  const root = document.documentElement;
  const body = document.body;
  const params = new URLSearchParams(location.search);
  const DEBUG = params.has('debug');
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const clamp01 = (x) => clamp(x, 0, 1);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
  const pad2 = (n) => String(n).padStart(2, '0');
  const easeSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const narrowMQ = matchMedia('(max-width: 900px)');
  const finePointerMQ = matchMedia('(pointer: fine)');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
    getSession(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    setSession(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  /* ================================================================= the film */

  const REELS = [
    { title: 'Morphology', meta: 'A tissue of marrow cells, sculpted in light' },
    { title: 'Gaussian Field', meta: 'Anisotropic splats, combed by a slow flow' },
    { title: 'Federation', meta: 'Six clients and a server, rippling through each other' },
  ];
  const REEL_SECONDS = 18;
  const TRANSITION_SECONDS = 1.5;
  const WALL_SPEED = 0.82;   // the wall's own clock runs a little slower than real time

  const SECTION_IDS = ['top', 'biography', 'news', 'publications', 'experience', 'awards', 'fin'];
  const PUBS_INDEX = SECTION_IDS.indexOf('publications');
  const SECTION_REEL = { top: 0, biography: 0, news: 1, experience: 2, awards: 1, fin: 0 };

  // The wall: its centre and half size, as in the scene shader.
  const WALL_C = [0, 2.445];
  const WALL_H = [3.6, 2.025];
  const FIGURE = [-0.6, 3.0, 0, 1];

  const TAKE_SECONDS = 16;   // one glide from a viewpoint to the next

  // Viewpoints per chapter. Wide layouts use a horizontal fov (hfov) so framing holds at any aspect
  // ratio; narrow ones a vertical fov. Every viewpoint in a chapter keeps the wall clear of its text.
  const SHOTS_WIDE = {
    top: [
      { pos: [-8.8, 0.95, 10.8], tgt: [-1.9, 2.25, 0], hfov: 58, exp: 1.0 },
      { pos: [-5.4, 1.3, 13.2], tgt: [-0.9, 2.4, 0], hfov: 55, exp: 1.0 },
      { pos: [-1.8, 0.8, 15.0], tgt: [0.2, 2.5, 0], hfov: 52, exp: 1.0 },
      { pos: [-5.4, 2.2, 13.2], tgt: [-0.9, 2.3, 0], hfov: 55, exp: 1.0 },
    ],
    biography: [
      { pos: [8.8, 2.5, 9.4], tgt: [3.72, 2.2, 0], hfov: 52.8, exp: 0.95 },
      { pos: [7.2, 1.5, 8.3], tgt: [3.66, 2.3, 0], hfov: 61.3, exp: 0.95 },
      { pos: [9.6, 4.2, 11.0], tgt: [3.8, 1.9, 0], hfov: 60, exp: 0.95 },
    ],
    news: [
      { pos: [-1.0, 8.6, 13.0], tgt: [0, 0.4, 2.2], hfov: 72, exp: 0.9 },
      { pos: [1.8, 6.0, 12.5], tgt: [0, 0.8, 1.6], hfov: 68, exp: 0.9 },
      { pos: [-3.8, 4.4, 12.0], tgt: [0, 1.2, 1.0], hfov: 66, exp: 0.9 },
    ],
    publications: [
      { pos: [-5.6, 4.2, 14.5], tgt: [-3.84, 1.9, 0], hfov: 54.9, exp: 1.0 },
      { pos: [-4.6, 3.8, 12.6], tgt: [-3.76, 1.95, 0], hfov: 61.9, exp: 1.0 },
    ],
    experience: [
      { pos: [0, 1.2, 27], tgt: [0, 0.2, 0], hfov: 40, exp: 0.95 },
      { pos: [0, 1.0, 22], tgt: [0, 0.2, 0], hfov: 44, exp: 0.95 },
      { pos: [2.6, 1.6, 24], tgt: [0, 0.2, 0], hfov: 42, exp: 0.95 },
    ],
    awards: [
      { pos: [0, 0.55, 14], tgt: [0, 1.2, 0], hfov: 62, exp: 0.95 },
      { pos: [2.8, 0.3, 10.5], tgt: [-0.4, 1.3, 0], hfov: 70, exp: 0.95 },
      { pos: [-2.6, 0.4, 11.5], tgt: [0.4, 1.3, 0], hfov: 68, exp: 0.95 },
    ],
    fin: [
      { pos: [0, 1.5, 31], tgt: [0, 2.5, 0], hfov: 30, exp: 1.0 },
      { pos: [0, 1.4, 27], tgt: [0, 2.5, 0], hfov: 32, exp: 1.0 },
    ],
  };
  const SHOTS_NARROW = {
    top: [
      { pos: [0.4, 2.0, 16.5], tgt: [0, -3.0, 0], fov: 60, exp: 1.0 },
      { pos: [-1.4, 2.6, 16.0], tgt: [0, -3.0, 0], fov: 60, exp: 1.0 },
      { pos: [1.6, 1.6, 16.8], tgt: [0, -3.0, 0], fov: 60, exp: 1.0 },
    ],
    biography: [
      { pos: [-1.0, 2.1, 16], tgt: [0.2, -1.0, 0], fov: 60, exp: 0.9 },
      { pos: [1.4, 3.0, 15.5], tgt: [0, -1.0, 0], fov: 60, exp: 0.9 },
    ],
    news: [
      { pos: [1.2, 2.4, 15.5], tgt: [0, -1.3, 0], fov: 60, exp: 0.9 },
      { pos: [-1.2, 1.8, 16], tgt: [0, -1.3, 0], fov: 60, exp: 0.9 },
    ],
    publications: [
      { pos: [0, 2.1, 16], tgt: [0, -1.0, 0], fov: 58, exp: 0.9 },
      { pos: [0, 2.1, 15], tgt: [0, -1.0, 0], fov: 60, exp: 0.9 },
    ],
    experience: [
      { pos: [-1.4, 1.8, 16], tgt: [0.2, -1.2, 0], fov: 60, exp: 0.9 },
      { pos: [1.4, 2.4, 16], tgt: [-0.2, -1.2, 0], fov: 60, exp: 0.9 },
    ],
    awards: [
      { pos: [0.9, 1.4, 17], tgt: [0, -1.0, 0], fov: 58, exp: 0.9 },
      { pos: [-0.9, 0.9, 16.5], tgt: [0, -1.0, 0], fov: 58, exp: 0.9 },
    ],
    fin: [
      { pos: [0, 1.5, 26], tgt: [0, 0.6, 0], fov: 56, exp: 1.0 },
      { pos: [0, 1.5, 23], tgt: [0, 0.6, 0], fov: 58, exp: 1.0 },
    ],
  };
  // Where the opening shot starts: far down the hall, dead centre.
  const OPEN_SHOT = { wide: { pos: [0, 1.25, 32], tgt: [0, 2.8, 0], hfov: 30, exp: 1.0 }, narrow: { pos: [0, 1.2, 30], tgt: [0, 1.2, 0], fov: 44, exp: 1.0 } };

  /* ===================================================================== UI */

  const ui = {
    navLinks: $$('.nav-link'),
    menuBtn: $('.menu-btn'),
    nav: $('#site-nav'),
    motionBtn: $('.motion-toggle'),
    newsList: $('#news-list'),
    newsBtn: $('#news-toggle'),
    filterBtns: $$('.filter'),
    pubs: $$('.pub'),
    label: $('#label'),
    labelKicker: $('#label-kicker'),
    labelTitle: $('#label-title'),
    labelMeta: $('#label-meta'),
    hudTicks: $('#hud-ticks'),
  };
  const sections = SECTION_IDS.map((id) => document.getElementById(id));

  const motionStored = store.get('lz-motion');
  const state = {
    motionUser: motionStored === 'on' ? true : motionStored === 'off' ? false : null,
    get motion() { return this.motionUser === null ? !reduceMQ.matches : this.motionUser; },
    section: -1,
    reel: 0,
    reelClock: 0,
  };

  let renderer = null;
  let glLive = false;
  let dirty = true;
  let wallDirty = true;
  const markDirty = () => { dirty = true; };
  const markWallDirty = () => { wallDirty = true; dirty = true; };

  // Paused or reduced motion: nothing waits for an entrance animation.
  const syncCalm = () => root.classList.toggle('calm', !state.motion);
  syncCalm();

  /* ------------------------------------------------------------ typography */

  // Big titles are split into letters for their entrance; the heading keeps its name for assistive tech.
  function splitTitle(el) {
    const text = el.textContent.trim();
    if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', text);
    el.textContent = '';
    let i = 0;
    text.split(/\s+/).forEach((word, w, all) => {
      const box = document.createElement('span');
      box.className = 'tl';
      box.setAttribute('aria-hidden', 'true');
      for (const ch of word) {
        const c = document.createElement('span');
        c.className = 'c';
        c.textContent = ch;
        c.style.setProperty('--i', i++);
        box.appendChild(c);
      }
      el.appendChild(box);
      if (w < all.length - 1) el.appendChild(document.createTextNode(' '));
    });
  }
  $$('[data-split]').forEach(splitTitle);

  // Entrance animations.
  (function initReveals() {
    const els = $$('[data-reveal]');
    $$('.news-item, .laurel, .prose p, .pub').forEach((el) => { el.setAttribute('data-reveal', ''); els.push(el); });
    $$('.laurel').forEach((el, i) => el.style.setProperty('--d', `${(i % 3) * 110}ms`));
    if (!('IntersectionObserver' in window)) { els.forEach((el) => el.classList.add('is-in')); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.01 });
    els.forEach((el) => io.observe(el));
  })();

  /* ------------------------------------------------------------------ menu */

  (function initMenu() {
    const { menuBtn, nav } = ui;
    if (!menuBtn || !nav) return;
    const set = (open) => {
      nav.classList.toggle('is-open', open);
      menuBtn.setAttribute('aria-expanded', String(open));
      menuBtn.textContent = open ? 'Close' : 'Menu';
    };
    menuBtn.addEventListener('click', () => set(!nav.classList.contains('is-open')));
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('is-open')) { set(false); menuBtn.focus(); } });
    narrowMQ.addEventListener('change', () => set(false));
  })();

  /* ------------------------------------------------------------------ news */

  (function initNews() {
    const { newsList, newsBtn } = ui;
    if (!newsList || !newsBtn) return;
    newsBtn.addEventListener('click', () => {
      const open = !newsList.classList.contains('is-open');
      newsList.classList.toggle('is-open', open);
      newsBtn.setAttribute('aria-expanded', String(open));
      newsBtn.textContent = open ? 'Show less' : 'Show earlier';
      measure();
    });
  })();

  /* ---------------------------------------------------------- page position */

  let bounds = [];
  let maxScroll = 1;
  const docTop = (el) => el.getBoundingClientRect().top + window.scrollY;
  function measure() {
    maxScroll = Math.max(1, root.scrollHeight - window.innerHeight);
    bounds = sections.map((s) => (s ? docTop(s) : 0));
    markDirty();
  }
  function sectionAt(y) {
    let idx = 0;
    for (let i = 0; i < bounds.length; i++) if (y >= bounds[i]) idx = i;
    return idx;
  }
  const inPubs = () => state.section === PUBS_INDEX;

  function scrollToY(y) {
    window.scrollTo({ top: y, behavior: state.motion ? 'smooth' : 'auto' });
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const id = a.getAttribute('href').slice(1);
    const el = id && document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    scrollToY(docTop(el));
    history.pushState(null, '', `#${id}`);
    el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  });

  /* ---------------------------------------------------------- HUD and wall */

  let labelKey = '';
  let labelTimer = 0;
  function setLabel(kicker, title, meta) {
    const key = [kicker, title, meta].join('|');
    if (key === labelKey || !ui.label) return;
    labelKey = key;
    const apply = () => {
      ui.labelKicker.textContent = kicker;
      ui.labelTitle.textContent = title;
      ui.labelMeta.textContent = meta;
      ui.label.classList.remove('is-switching');
    };
    clearTimeout(labelTimer);
    if (state.motion) { ui.label.classList.add('is-switching'); labelTimer = setTimeout(apply, 220); } else apply();
  }

  let ticksFor = '';
  function renderTicks() {
    if (!ui.hudTicks) return;
    const pubsMode = inPubs();
    const list = pubsMode ? visiblePubs : REELS;
    const key = pubsMode ? `p:${visiblePubs.map((li) => ui.pubs.indexOf(li)).join(',')}` : 'r';
    if (key !== ticksFor) {
      ticksFor = key;
      ui.hudTicks.textContent = '';
      list.forEach((item, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tick';
        b.dataset.i = i;
        b.textContent = pad2(i + 1);
        b.setAttribute('aria-label', `Show ${pubsMode ? item.dataset.short : item.title}`);
        ui.hudTicks.appendChild(b);
      });
    }
    const cur = pubsMode ? visiblePubs.indexOf(activePub) : state.reel;
    $$('.tick', ui.hudTicks).forEach((b, i) => {
      if (i === cur) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    });
  }

  // Figures and fonts come from jsDelivr, a free public CDN for open-source repositories, because GitHub Pages can be
  // very slow from mainland China at busy times. jsDelivr is steadier there but not reachable from every network, and
  // some of its routes redirect images to raw.githubusercontent.com, which is no better. So a quick check decides, and
  // everything falls back to this site's own copy. Code never comes from it. It is pinned to a commit, whose files
  // never change: to publish a changed figure or font through it, move this commit here and in cinema.css and
  // index.html. A file that commit doesn't have simply loads from this site.
  const CDN = 'https://cdn.jsdelivr.net/gh/LinghaoZhuang/LinghaoZhuang.github.io@0f5cdf9764a184c0436f1c8b4ad819b981274a41/';
  // Each font is split into a core file with the characters this page uses and an extension with the rest of
  // its Latin characters, which the browser fetches only for text that needs it (unicode-range).
  const FONT_CORE = 'U+0020-007E, U+00A0, U+00A9, U+00B7, U+00D7, U+2013-2014, U+2018-2019, U+201C-201D, U+2026';
  const FONT_FILES = [
    ['Archivo Expanded', 'archivo-expanded', 'font-weight: 100 500', 'U+00A1-00A8, U+00AA-00B6, U+00B8-00D6, U+00D8-00FF, U+0102, U+0131, U+0152-0153, U+02BC, U+02C6, U+02DA, U+02DC, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+2009, U+201A, U+201E, U+2022, U+2032-2033, U+2039-203A, U+2044, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF'],
    ['Instrument Serif', 'instrument-serif', 'font-weight: 400', 'U+00A1-00A3, U+00A5, U+00A7-00A8, U+00AA-00AB, U+00AE-00B0, U+00B4, U+00B6, U+00B8, U+00BA-00BB, U+00BF-00D6, U+00D8-00FF, U+0102, U+0131, U+0152-0153, U+02C6, U+02DA, U+02DC, U+0300-0301, U+0303-0304, U+0308, U+201A, U+201E, U+2022, U+2039-203A, U+20AC, U+2122, U+2212'],
    ['Instrument Serif', 'instrument-serif-italic', 'font-weight: 400; font-style: italic', 'U+00A1-00A3, U+00A5, U+00A7-00A8, U+00AA-00AB, U+00AE-00B0, U+00B4, U+00B6, U+00B8, U+00BA-00BB, U+00BF-00D6, U+00D8-00FF, U+0102, U+0131, U+0152-0153, U+02C6, U+02DA, U+02DC, U+0300-0301, U+0303-0304, U+0308, U+201A, U+201E, U+2022, U+2039-203A, U+20AC, U+2122, U+2212'],
    ['IBM Plex Mono', 'ibm-plex-mono-300', 'font-weight: 300', 'U+00A1-00A8, U+00AA-00B6, U+00B8-00D6, U+00D8-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+201A, U+201E, U+2022, U+2032-2033, U+2039-203A, U+2044, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215'],
    ['IBM Plex Mono', 'ibm-plex-mono-400', 'font-weight: 400', 'U+00A1-00A8, U+00AA-00B6, U+00B8-00D6, U+00D8-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+201A, U+201E, U+2022, U+2032-2033, U+2039-203A, U+2044, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215'],
  ];
  let cdnUp = false;
  function checkCdn() {
    const down = () => {
      // Don't leave the fonts waiting for the CDN to time out: a later @font-face takes over from the earlier one.
      const style = document.createElement('style');
      const face = (family, file, rules, range) => `@font-face { font-family: '${family}'; src: url(vendor/fonts/${file}.woff2) format('woff2'); ${rules}; font-display: swap; unicode-range: ${range}; }`;
      style.textContent = FONT_FILES.map(([family, file, rules, ext]) => `${face(family, file, rules, FONT_CORE)}\n${face(family, `${file}-ext`, rules, ext)}`).join('\n');
      document.head.appendChild(style);
    };
    if (!window.fetch || !window.AbortController) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3500);
    fetch(`${CDN}images/favicon.png`, { method: 'HEAD', mode: 'cors', redirect: 'manual', signal: ctl.signal }).then((r) => {
      if (r.type === 'opaqueredirect') return;   // this route redirects images: fonts are fine, figures stay on this site
      if (!r.ok) { down(); return; }
      cdnUp = true;
      // Inline figures (phones, no WebGL) and the portrait switch over too, unless they have already loaded.
      $$('.pub-thumb, .portrait img').forEach((img) => {
        if (img.complete && img.naturalWidth) return;
        const local = img.getAttribute('src');
        img.onerror = () => { img.onerror = null; img.src = local; };
        img.src = CDN + local;
      });
    }, down).finally(() => clearTimeout(timer));
  }
  checkCdn();

  // Figures download strictly one at a time, and the one the reader is looking at interrupts whichever is under way,
  // so on a slow connection it gets all of the bandwidth. They reach the GPU one at a time too. Phones show the same
  // files inline as the reader gets to them, and nothing is fetched ahead for readers who asked to save data.
  const figs = new Map();
  const figQueue = [];
  let figActive = null;
  const prefetchFigures = !narrowMQ.matches && !(navigator.connection && navigator.connection.saveData);

  function startFigure(f) {
    figActive = f;
    f.state = 'loading';
    const viaCdn = cdnUp && !f.noCdn;
    const img = new Image();
    f.loader = img;
    img.decoding = 'async';
    if (viaCdn) img.crossOrigin = 'anonymous';   // the wall is a WebGL texture, which needs CORS from another host
    img.src = viaCdn ? CDN + f.src : f.src;
    // The CDN usually takes a second or two. If it stalls, stop waiting and use this site's copy.
    const stall = viaCdn ? setTimeout(() => {
      if (f.loader !== img) return;
      f.noCdn = true;
      interruptFigure();
      pumpFigures();
    }, 9000) : 0;
    const loaded = img.decode ? img.decode() : new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    loaded.then(() => {
      clearTimeout(stall);
      if (f.loader !== img) return;
      f.img = img;
      f.aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
      f.state = 'ready';
      markDirty();
    }, () => {
      clearTimeout(stall);
      if (f.loader !== img) return;
      if (viaCdn) { f.noCdn = true; f.state = 'queued'; figQueue.unshift(f); }
      else if (f.tries++ < 1) { f.state = 'queued'; figQueue.push(f); }
      else f.state = 'error';
    }).then(() => {
      if (f.loader !== img) return;   // interrupted: it went back in the queue, and something else is running
      f.loader = null;
      figActive = null;
      syncFigWaiting();
      pumpFigures();
    });
  }
  function pumpFigures() {
    if (figActive) return;
    while (figQueue.length) {
      const f = figQueue.shift();
      if (f.state === 'queued') { startFigure(f); return; }
    }
  }
  function interruptFigure() {
    const f = figActive;
    const img = f.loader;
    f.loader = null;
    f.state = 'queued';
    figQueue.unshift(f);
    figActive = null;
    img.src = '';
  }
  function loadFigure(src, urgent) {
    let f = figs.get(src);
    if (!f) {
      f = { src, state: 'queued', tex: null, img: null, aspect: 2, tries: 0, loader: null, noCdn: false };
      figs.set(src, f);
      figQueue.push(f);
    }
    if (urgent && f.state === 'queued') {
      figQueue.splice(figQueue.indexOf(f), 1);
      if (figActive) interruptFigure();
      startFigure(f);
    } else {
      pumpFigures();
    }
    return f;
  }
  // The papers either side of the current one are the likeliest next, so they go to the front of the queue.
  function promoteNeighbours(li) {
    if (!prefetchFigures) return;
    const i = visiblePubs.indexOf(li);
    [visiblePubs[i - 1], visiblePubs[i + 1]].forEach((n) => {
      if (!n) return;
      const f = loadFigure(n.dataset.figure);
      const k = figQueue.indexOf(f);
      if (k > 0) { figQueue.splice(k, 1); figQueue.unshift(f); }
    });
  }
  // While the wanted figure is on its way, its number in the HUD pulses.
  function syncFigWaiting() {
    if (!ui.label) return;
    const f = wall.want.kind === 'fig' ? figs.get(wall.want.src) : null;
    ui.label.classList.toggle('is-loading', !!f && (f.state === 'queued' || f.state === 'loading'));
  }
  function uploadOneFigure() {
    if (!glLive) return;
    for (const f of figs.values()) {
      if (f.state === 'ready' && !f.tex) { f.tex = renderer.imageTexture(f.img); return; }
    }
  }

  const wall = {
    cur: { kind: 'reel', id: 0 },
    prev: { kind: 'reel', id: 0 },
    want: { kind: 'reel', id: 0 },
    mix: 1,
  };
  const same = (a, b) => a.kind === b.kind && (a.kind === 'reel' ? a.id === b.id : a.src === b.src);
  function wantSource(src) {
    wall.want = src;
    if (src.kind === 'fig') loadFigure(src.src, true);
    syncFigWaiting();
    markWallDirty();
  }
  function stepWall(dt) {
    if (wall.mix < 1) {
      wall.mix = state.motion ? Math.min(1, wall.mix + dt / TRANSITION_SECONDS) : 1;
      return true;
    }
    if (same(wall.want, wall.cur)) return false;
    if (wall.want.kind === 'fig') {
      const f = figs.get(wall.want.src);
      if (!f || f.state !== 'ready') return false;
      if (!f.tex) { if (!glLive || !f.img) return false; f.tex = renderer.imageTexture(f.img); }
    }
    wall.prev = wall.cur;
    wall.cur = wall.want;
    wall.mix = state.motion ? 0 : 1;
    return true;
  }
  // Is there something to switch to right now? Waiting for a download draws nothing new, so it costs nothing.
  const canSwitch = () => {
    if (same(wall.want, wall.cur)) return false;
    if (wall.want.kind !== 'fig') return true;
    const f = figs.get(wall.want.src);
    return !!f && f.state === 'ready';
  };
  const figWeight = () => {
    const c = wall.cur.kind === 'fig' ? 1 : 0;
    const p = wall.prev.kind === 'fig' ? 1 : 0;
    return wall.mix >= 1 ? c : lerp(p, c, smooth(wall.mix));
  };

  function showReel(i) {
    state.reel = (i + REELS.length) % REELS.length;
    state.reelClock = 0;
    const r = REELS[state.reel];
    setLabel('Now showing', r.title, r.meta);
    wantSource({ kind: 'reel', id: state.reel });
    renderTicks();
  }

  /* ---------------------------------------------------------- publications */

  let visiblePubs = ui.pubs.slice();
  let activePub = null;
  let hoverPub = null;
  let pickLockUntil = 0;

  function presentPub(li) {
    const venue = $('.pub-venue', li);
    setLabel(li.dataset.badge, li.dataset.short, venue ? venue.textContent.trim() : '');
    wantSource({ kind: 'fig', src: li.dataset.figure });
    renderTicks();
  }
  function setActivePub(li) {
    if (!li || li === activePub) return;
    if (activePub) activePub.classList.remove('is-active');
    activePub = li;
    li.classList.add('is-active');
    if (inPubs()) { presentPub(li); promoteNeighbours(li); }
  }
  function pickPubByScroll() {
    if (hoverPub || performance.now() < pickLockUntil || !visiblePubs.length) return;
    const mid = window.innerHeight * 0.5;
    let best = null;
    let bestD = Infinity;
    for (const li of visiblePubs) {
      const r = li.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < bestD) { bestD = d; best = li; }
    }
    setActivePub(best);
  }
  ui.pubs.forEach((li) => {
    li.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      hoverPub = li;
      setActivePub(li);
    });
    li.addEventListener('pointerleave', () => { if (hoverPub === li) hoverPub = null; });
    li.addEventListener('focusin', () => setActivePub(li));
  });

  function applyFilter(f) {
    ui.filterBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === f)));
    visiblePubs = [];
    ui.pubs.forEach((li) => {
      const show = f === 'all' || (f === 'first-author' ? li.dataset.first === 'true' : li.dataset.venue === f);
      li.hidden = !show;
      if (show) visiblePubs.push(li);
    });
    visiblePubs.forEach((li, i) => { const n = $('.pub-no', li); if (n) n.textContent = pad2(i + 1); });
    measure();
    if (!visiblePubs.includes(activePub)) {
      if (activePub) activePub.classList.remove('is-active');
      activePub = null;
      setActivePub(visiblePubs[0]);
    } else if (inPubs() && activePub) {
      labelKey = '';
      presentPub(activePub);
    }
    renderTicks();
  }
  ui.filterBtns.forEach((b) => b.addEventListener('click', () => applyFilter(b.dataset.filter)));

  // Abstracts: each paper gets a button once this script runs. Without it, the abstracts simply stay open.
  root.classList.add('abs-ready');
  ui.pubs.forEach((li) => {
    const abs = $('.pub-abstract', li);
    const links = $('.pub-links', li);
    if (!abs || !links) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'abs-btn';
    btn.textContent = 'Abstract';
    btn.setAttribute('aria-label', `Abstract: ${li.dataset.short}`);
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', abs.id);
    btn.addEventListener('click', () => {
      const open = !li.classList.contains('abs-open');
      li.classList.toggle('abs-open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
    links.appendChild(btn);
  });

  function jumpToPub(li) {
    hoverPub = null;
    pickLockUntil = performance.now() + 1300;
    setActivePub(li);
    const r = li.getBoundingClientRect();
    scrollToY(r.top + window.scrollY - (window.innerHeight - r.height) / 2);
  }
  function stepLabel(d) {
    if (inPubs() && visiblePubs.length) {
      const i = Math.max(0, visiblePubs.indexOf(activePub));
      jumpToPub(visiblePubs[(i + d + visiblePubs.length) % visiblePubs.length]);
    } else {
      showReel(state.reel + d);
    }
  }
  $$('.label-btn').forEach((b) => b.addEventListener('click', () => stepLabel(Number(b.dataset.step))));
  if (ui.hudTicks) {
    ui.hudTicks.addEventListener('click', (e) => {
      const b = e.target.closest('.tick');
      if (!b) return;
      const i = Number(b.dataset.i);
      if (inPubs()) jumpToPub(visiblePubs[i]); else showReel(i);
    });
  }

  function onSectionChange(idx) {
    state.section = idx;
    const id = SECTION_IDS[idx];
    body.dataset.section = id;
    ui.navLinks.forEach((a) => {
      const on = a.dataset.target === id;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
    });
    if (idx === PUBS_INDEX) {
      if (!activePub) activePub = visiblePubs[0];
      pickPubByScroll();   // the paper in the middle of the screen, not whichever was current last time
      if (activePub) { activePub.classList.add('is-active'); presentPub(activePub); promoteNeighbours(activePub); }
      if (prefetchFigures) visiblePubs.forEach((li) => loadFigure(li.dataset.figure));
    } else {
      showReel(SECTION_REEL[id] != null ? SECTION_REEL[id] : state.reel);
    }
    directChapter(id);
  }

  /* ---------------------------------------------------------------- scroll */

  let scrollQueued = false;
  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      const y = window.scrollY;
      root.classList.toggle('is-rolling', y > 24);
      if (y > 8) skipOpening();
      const idx = sectionAt(y + window.innerHeight * 0.45);
      if (idx !== state.section) onSectionChange(idx);
      if (inPubs()) pickPubByScroll();
    });
  }
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', () => { measure(); onScroll(); resetFraming(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measure(); onScroll(); });
  if ('ResizeObserver' in window) new ResizeObserver(() => { measure(); }).observe(body);

  /* --------------------------------------------------------- motion toggle */

  function syncMotion() {
    const on = state.motion;
    syncCalm();
    if (ui.motionBtn) {
      const label = on ? 'Pause the background animation' : 'Play the background animation';
      ui.motionBtn.setAttribute('aria-pressed', String(!on));
      ui.motionBtn.setAttribute('aria-label', label);
      ui.motionBtn.title = label;
      ui.motionBtn.textContent = on ? 'Pause' : 'Play';
    }
    markDirty();
  }
  if (ui.motionBtn) {
    ui.motionBtn.addEventListener('click', () => {
      state.motionUser = !state.motion;
      store.set('lz-motion', state.motionUser ? 'on' : 'off');
      syncMotion();
    });
  }
  reduceMQ.addEventListener('change', syncMotion);

  /* --------------------------------------------------------------- pointer */

  const pointer = { tx: 0, ty: 0, seen: false };
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
    pointer.seen = true;
  }, { passive: true });

  /* ============================================================ the director */

  const vfovOf = (s) => {
    if (!s.hfov) return s.fov;
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    return 2 * Math.atan(Math.tan(s.hfov * Math.PI / 360) / aspect) * 180 / Math.PI;
  };
  // A pose is a flat array: position, target, vertical fov, exposure.
  const POSE_N = 8;
  const poseOf = (s) => [s.pos[0], s.pos[1], s.pos[2], s.tgt[0], s.tgt[1], s.tgt[2], vfovOf(s), s.exp == null ? 1 : s.exp];
  const shotsFor = (id) => (narrowMQ.matches ? SHOTS_NARROW : SHOTS_WIDE)[id];

  const director = {
    chapter: 'top', i: 0, t: 0, dur: 1, hold: 0,
    from: null, to: null,
    rail: null,                      // where the current glide says the camera should be
    cam: null, vel: new Array(POSE_N).fill(0),   // the camera, trailing the rail through a critically damped spring
  };
  // `hold`: after a long move, a moment for the camera to come to rest before the next take sets off.
  function beginGlide(toPose, seconds, hold) {
    director.from = director.rail.slice();
    director.to = toPose;
    director.t = 0;
    director.dur = seconds;
    director.hold = hold || 0;
  }
  function placeCamera(pose) {
    director.rail = pose.slice();
    director.cam = pose.slice();
    director.from = pose.slice();
    director.to = pose.slice();
    director.vel.fill(0);
    director.t = 0;
    director.dur = 0.001;
    director.hold = 0;
  }
  function directChapter(id) {
    director.chapter = id;
    director.i = 0;
    if (!director.rail) return;
    const to = poseOf(shotsFor(id)[0]);
    if (!state.motion) { placeCamera(to); markDirty(); return; }
    const d = Math.hypot(to[0] - director.rail[0], to[1] - director.rail[1], to[2] - director.rail[2]);
    beginGlide(to, clamp(3 + d * 0.15, 3.3, 6.6), 1.2);   // re-framing is unhurried, never a snap
  }
  function resetFraming() {
    if (!director.rail) return;
    const list = shotsFor(director.chapter);
    director.i %= list.length;
    beginGlide(poseOf(list[director.i]), 2, 0.6);
  }
  function stepDirector(dt) {
    director.t += dt;
    if (director.t >= director.dur + director.hold) {
      const list = shotsFor(director.chapter);
      if (list.length > 1) {
        director.i = (director.i + 1) % list.length;
        beginGlide(poseOf(list[director.i]), TAKE_SECONDS);
      }
    }
    const e = easeSine(clamp01(director.t / director.dur));
    const w = 2.4;   // follow rate of the spring
    const decay = Math.exp(-w * dt);
    for (let k = 0; k < POSE_N; k++) {
      director.rail[k] = lerp(director.from[k], director.to[k], e);
      const d = director.cam[k] - director.rail[k];
      const tmp = (director.vel[k] + w * d) * dt;
      director.cam[k] = director.rail[k] + (d + tmp) * decay;
      director.vel[k] = (director.vel[k] - w * tmp) * decay;
    }
  }

  /* ---------------------------------------------------------------- start */

  measure();
  if (visiblePubs.length) { activePub = visiblePubs[0]; activePub.classList.add('is-active'); }
  onSectionChange(sectionAt(window.scrollY + window.innerHeight * 0.45));
  root.classList.toggle('is-rolling', window.scrollY > 24);

  /* ============================================================== opening */

  const opening = { on: false, t: 0, rate: 1, dur: 4.2, titleAt: 1.8, metaAt: 2.8, powerFrom: 0.7, powerDur: 1.4 };
  const addTitle = () => root.classList.add('title-in');
  const addMeta = () => root.classList.add('meta-in');
  const skipEvents = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
  function removeSkip() { skipEvents.forEach((n) => removeEventListener(n, skipOpening)); }
  function endOpening() {
    opening.on = false;
    addTitle();
    addMeta();
    root.classList.remove('is-opening');
    store.setSession('lz-opened', '1');
    removeSkip();
    markDirty();
  }
  function skipOpening() { if (opening.on) { opening.rate = 5; addTitle(); addMeta(); removeSkip(); } }
  function startOpening() {
    const seen = store.getSession('lz-opened') === '1';
    opening.on = true;
    opening.rate = 1;
    opening.t = seen ? 1.7 : 0;
    root.classList.add('is-opening');
    if (seen) root.classList.add('no-card');
    placeCamera(poseOf(narrowMQ.matches ? OPEN_SHOT.narrow : OPEN_SHOT.wide));
    beginGlide(poseOf(shotsFor(director.chapter)[0]), seen ? 3.2 : 5.5, 1.2);
    skipEvents.forEach((n) => addEventListener(n, skipOpening, { passive: true }));
  }
  function stepOpening(dt) {
    if (!opening.on) return;
    opening.t += dt * opening.rate;
    if (opening.t >= opening.titleAt) addTitle();
    if (opening.t >= opening.metaAt) addMeta();
    if (opening.t >= opening.dur) endOpening();
  }
  function openingPower() {
    if (!opening.on) return 1;
    const p = clamp01((opening.t - opening.powerFrom) / opening.powerDur);
    return p < 0.3 ? (p / 0.3) * 0.06 : 0.06 + 0.94 * easeOut((p - 0.3) / 0.7);
  }

  const finishIntro = () => root.classList.add('intro-off');

  // A visitor who has already waited on a slow connection gets the page at once: no black screen and no opening.
  // The scene fades in behind the text when it is ready.
  const lateStart = performance.now() > 3000;
  if (lateStart) { addTitle(); addMeta(); finishIntro(); }

  /* ================================================================= boot GL */

  const canvas = $('#scene');
  const lowPower = narrowMQ.matches || !finePointerMQ.matches;

  function fallBack() {
    glLive = false;
    root.classList.remove('gl', 'gl-wait');
    root.classList.add('no-gl');
    addTitle();
    addMeta();
    finishIntro();
    measure();
  }

  // After a slow load the page is already on show: let the browser paint it before compiling the shaders, which
  // can hold up the page on browsers that cannot compile in the background.
  if (lateStart) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    renderer = canvas && window.CinemaGL ? window.CinemaGL.createRenderer(canvas, { wallWidth: lowPower ? 800 : 1280 }) : null;
  } catch (err) {
    console.error(err);
    renderer = null;
  }
  if (!renderer) {
    fallBack();
    return;
  }

  // A slow shader compile must not hold the page hostage: after a moment, open with a still.
  let waitedTooLong = false;
  const stillTimer = setTimeout(() => {
    if (glLive) return;
    waitedTooLong = true;
    root.classList.add('gl-wait');
    addTitle();
    addMeta();
    finishIntro();
  }, 2200);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    cancelAnimationFrame(rafId);
    fallBack();
  });
  canvas.addEventListener('webglcontextrestored', () => location.reload());

  // Warm the figure cache before the reader reaches the papers.
  const pubSection = document.getElementById('publications');
  if (pubSection && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        if (prefetchFigures) ui.pubs.forEach((li) => loadFigure(li.dataset.figure));
        io.disconnect();
      }
    }, { rootMargin: '150% 0px' });
    io.observe(pubSection);
  }

  /* --------------------------------------------------------- frame budget */

  // A steady, film-like cadence: a homepage has no business running the GPU flat out. During a take the camera
  // moves slowly enough for 24 frames a second (20 on phones); anything quicker gets 30 (24 on phones).
  const FRAME_MS = 1000 / (lowPower ? 24 : 30);
  const DWELL_MS = 1000 / (lowPower ? 20 : 24);
  const GPU_BUDGET_MS = 24;   // leave the GPU room to composite the page and keep scrolling smooth

  // Resolution only ever steps down, and only after sustained overload: it never oscillates.
  const fixedScale = Number(params.get('scale')) || 0;
  const baseScale = fixedScale || clamp(Math.sqrt((lowPower ? 0.34e6 : 0.8e6) / (window.innerWidth * window.innerHeight)), 0.4, Math.min(window.devicePixelRatio || 1, 1.25));
  const TIERS = [1, 0.86, 0.74, 0.63, 0.54, 0.46];
  let tier = 0;
  let frameMs = FRAME_MS;
  let budgetMs = FRAME_MS;
  let scale = baseScale;
  let frameEma = FRAME_MS;
  let gpuEma = 0;
  let overSince = 0;
  const bootTime = performance.now();

  function resizeCanvas() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const W = Math.max(2, Math.round(w * scale));
    const H = Math.max(2, Math.round(h * scale));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; dirty = true; }
  }
  function adapt(now) {
    if (fixedScale || tier >= TIERS.length - 1 || now - bootTime < 2500) return;
    const ms = renderer.gpuMs();
    if (ms != null) gpuEma = gpuEma ? lerp(gpuEma, ms, 0.12) : ms;
    const over = ms != null ? gpuEma > GPU_BUDGET_MS : frameEma > budgetMs * 1.25;
    if (!over) { overSince = 0; return; }
    if (!overSince) { overSince = now; return; }
    if (now - overSince < 1500) return;
    tier++;
    scale = baseScale * TIERS[tier];
    if (tier === TIERS.length - 1) frameMs = DWELL_MS;
    overSince = 0;
    frameEma = budgetMs;
    gpuEma = 0;
  }

  /* -------------------------------------------------------------- the loop */

  const wallPtr = { u: 0.5, v: 0.5, z: 0, tu: 0.5, tv: 0.5 };

  // Where a point on the screen meets the plane of the wall, in wall coordinates.
  function wallHit(ndcX, ndcY, pos, tgt, fovDeg, aspect) {
    const f = [tgt[0] - pos[0], tgt[1] - pos[1], tgt[2] - pos[2]];
    const fl = Math.hypot(f[0], f[1], f[2]) || 1;
    f[0] /= fl; f[1] /= fl; f[2] /= fl;
    let r = [-f[2], 0, f[0]];
    const rl = Math.hypot(r[0], r[2]) || 1;
    r = [r[0] / rl, 0, r[2] / rl];
    const up = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const tf = Math.tan(fovDeg * Math.PI / 360);
    const a = ndcX * tf * aspect;
    const b = ndcY * tf;
    const d = [f[0] + r[0] * a + up[0] * b, f[1] + r[1] * a + up[1] * b, f[2] + r[2] * a + up[2] * b];
    if (d[2] > -1e-4) return null;
    const t = -pos[2] / d[2];
    return [(pos[0] + d[0] * t - (WALL_C[0] - WALL_H[0])) / (2 * WALL_H[0]), (pos[1] + d[1] * t - (WALL_C[1] - WALL_H[1])) / (2 * WALL_H[1])];
  }

  let rafId = 0;
  let last = performance.now();
  let lastRender = 0;
  let time = state.motion ? 0 : 12;
  let debugTime = null;
  let renderedOnce = false;
  let frames = 0;
  let wallTick = 0;
  let uploadTick = 0;
  let endPower = 1;

  // Anything that goes wrong while drawing leaves the reader with the still, not a frozen canvas.
  function tick(now) {
    rafId = requestAnimationFrame(tick);
    try {
      drawTick(now);
    } catch (err) {
      console.error(err);
      cancelAnimationFrame(rafId);
      fallBack();
    }
  }

  function drawTick(now) {
    const motion = state.motion;
    const wallBusy = wall.mix < 1 || canSwitch();
    if (!(dirty || motion || wallBusy)) return;
    const v = director.vel;
    const brisk = opening.on || wallBusy || wallPtr.z > 0 || Math.hypot(v[0], v[1], v[2]) > 0.8 || !motion;
    if (now - lastRender < (brisk ? frameMs : DWELL_MS) - 3) return;
    const gap = now - lastRender;
    if (lastRender && gap < 250) frameEma = lerp(frameEma, gap, 0.06);
    budgetMs = brisk ? frameMs : DWELL_MS;
    lastRender = now;

    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (motion) time += dt;
    if (debugTime !== null) time = debugTime;

    stepOpening(dt);
    if (motion && debugTime === null) stepDirector(dt);

    if (!inPubs() && motion && debugTime === null) {
      state.reelClock += dt;
      if (state.reelClock > REEL_SECONDS) showReel(state.reel + 1);
    }

    if (uploadTick++ % 6 === 0) uploadOneFigure();
    const transitioning = stepWall(dt);
    const animatedWall = motion && (wall.cur.kind === 'reel' || (wall.mix < 1 && wall.prev.kind === 'reel'));

    adapt(now);
    resizeCanvas();

    const c = director.cam;
    const pos = [c[0], c[1], c[2]];
    const tgt = [c[3], c[4], c[5]];
    const fov = c[6];

    // At the very bottom of the page the wall slowly goes out.
    const y = window.scrollY;
    const wantEnd = motion && y > maxScroll - window.innerHeight * 0.2 ? 0 : 1;
    endPower = debugTime !== null ? wantEnd : damp(endPower, wantEnd, wantEnd ? 2.2 : 0.9, dt);
    if (endPower > 0.999) endPower = 1;
    if (endPower < 0.002) endPower = 0;
    const power = Math.min(openingPower(), endPower);

    // The pointer raises a soft swell in the relief where it crosses the wall.
    let pointerOnWall = false;
    if (motion && pointer.seen && finePointerMQ.matches && wall.cur.kind === 'reel') {
      const hit = wallHit(pointer.tx, -pointer.ty, pos, tgt, fov, window.innerWidth / Math.max(1, window.innerHeight));
      if (hit && hit[0] > 0 && hit[0] < 1 && hit[1] > 0 && hit[1] < 1) {
        pointerOnWall = true;
        wallPtr.tu = hit[0];
        wallPtr.tv = hit[1];
        if (wallPtr.z < 0.01) { wallPtr.u = hit[0]; wallPtr.v = hit[1]; }
      }
    }
    wallPtr.u = damp(wallPtr.u, wallPtr.tu, 5, dt);
    wallPtr.v = damp(wallPtr.v, wallPtr.tv, 5, dt);
    wallPtr.z = damp(wallPtr.z, pointerOnWall ? 1 : 0, pointerOnWall ? 3 : 1.4, dt);
    if (wallPtr.z < 0.002) wallPtr.z = 0;

    const fwt = figWeight();
    const swelling = wallPtr.z > 0;
    const lean = tier >= 2 || lowPower;
    // The picture on the wall is redrawn every frame, or every other frame on phones and struggling GPUs.
    const wallDue = animatedWall && (swelling || !lean || wallTick++ % 2 === 0);
    if (wallDirty || wallDue || transitioning || power < 1 || !renderedOnce) {
      wallDirty = false;
      const fc = wall.cur.kind === 'fig' ? figs.get(wall.cur.src) : null;
      const fp = wall.prev.kind === 'fig' ? figs.get(wall.prev.src) : null;
      renderer.drawWall({
        time: time * WALL_SPEED,
        cur: wall.cur.kind === 'reel' ? wall.cur.id : 3,
        prev: wall.prev.kind === 'reel' ? wall.prev.id : 4,
        mix: wall.mix,
        texCur: fc && fc.tex, aspCur: fc ? fc.aspect : 2,
        texPrev: fp && fp.tex, aspPrev: fp ? fp.aspect : 2,
        pointer: [wallPtr.u, wallPtr.v, wallPtr.z],
        power,
      });
    }

    frames++;
    renderer.drawFrame({
      time,
      pos, tgt, fov, roll: 0,
      relief: fwt >= 1 && wall.mix >= 1 ? 0 : lerp(1.05, 0.9, fwt),   // a flat slide skips the relief march altogether
      gain: lerp(2.3, 1.5, fwt),
      wallGain: lerp(1.25, 1.0, fwt),
      exposure: c[7],
      steps: lean ? 16 : 24,
      volSteps: lean ? 5 : 7,
      fig: FIGURE,
      beam: lerp(1, 0.16, fwt),
      bloom: lerp(0.5, 0.2, fwt),
      vignette: 0.42,
      dither: 0.012,
    });
    dirty = false;

    if (!renderedOnce) {
      renderedOnce = true;
      clearTimeout(stillTimer);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        finishIntro();
        root.classList.remove('gl-wait');
      }));
    }
  }

  function goLive() {
    glLive = true;
    root.classList.add('gl');
    syncMotion();
    measure();
    placeCamera(poseOf(shotsFor(director.chapter)[0]));

    // The full opening only plays from the top of the page, with motion on, and when the still has not taken over.
    const canOpen = state.motion && !waitedTooLong && !lateStart && window.scrollY < 8 && !location.hash && !params.has('noopen');
    if (canOpen) startOpening();
    else { addTitle(); addMeta(); }

    last = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  if (DEBUG) {
    window.__cinema = {
      freeze(t) { debugTime = t; markWallDirty(); },
      unfreeze() { debugTime = null; },
      reel(i) { showReel(i); },
      paper(i) {
        const li = visiblePubs[i];
        if (!li) return false;
        setActivePub(li);
        presentPub(li);
        return true;
      },
      finish() { wall.mix = 1; stepWall(0); wall.mix = 1; markWallDirty(); },
      shot(s) { placeCamera(poseOf(s)); markDirty(); },
      view(id, i) { placeCamera(poseOf(shotsFor(id)[i || 0])); markDirty(); },
      snap() { placeCamera(poseOf(shotsFor(director.chapter)[0])); markDirty(); },
      power(p) { endPower = p; markWallDirty(); },
      openAt(t) { if (!opening.on) startOpening(); opening.t = t; opening.rate = 0; if (t >= opening.titleAt) addTitle(); if (t >= opening.metaAt) addMeta(); markWallDirty(); },
      endOpening() { endOpening(); },
      step(dt) { stepDirector(dt); markDirty(); },
      probe() { return { wall: renderer.probeWall(), lost: renderer.gl.isContextLost(), err: renderer.gl.getError(), float: renderer.floatRT, cam: director.cam }; },
      status() {
        const f = wall.want.kind === 'fig' ? figs.get(wall.want.src) : null;
        return {
          scale, tier, w: canvas.width, h: canvas.height, frameEma, gpuEma, frames, renderedOnce, opening: opening.on, openT: opening.t,
          section: SECTION_IDS[state.section], cur: wall.cur, want: wall.want, mix: wall.mix,
          wantReady: !f || f.state === 'ready', cdnUp, late: lateStart, swell: wallPtr.z, gpuMs: renderer.gpuMs(), lean: tier >= 2 || lowPower,
        };
      },
    };
  }

  (function waitForShaders() {
    if (!renderer.isReady()) { setTimeout(waitForShaders, 60); return; }
    try {
      renderer.finalize();
    } catch (err) {
      console.error(err);
      clearTimeout(stillTimer);
      renderer = null;
      fallBack();
      return;
    }
    goLive();
  })();
})();
