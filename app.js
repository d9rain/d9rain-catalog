(() => {
  'use strict';

  // ---------- окружение ----------
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const inTg = !!(tg && tg.initData);
  const DEMO = window.__DEMO__ || null; // предпросмотр без сервера
  const PHOTO_BASE = window.__PHOTO_BASE__ || 'photos/';
  const $ = (id) => document.getElementById(id);
  const tgAtLeast = (v) => !!(inTg && tg.isVersionAtLeast && tg.isVersionAtLeast(v));

  const state = {
    items: [], byId: new Map(), info: { text: '', links: [] }, admin: false, categories: [],
    config: { seller: '', channel: '', bot: null },
    q: '', cat: '', sizes: new Set(), sort: 'new', fav: new Set(), cart: new Set(),
    tab: 'catalog', scroll: {}, adminFilter: 'available', adminQ: '',
  };

  const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'One Size'];
  const sizeRank = (s) => {
    const i = SIZE_ORDER.indexOf(s);
    if (i >= 0) return i;
    if (s[0] === 'W') return 100 + parseFloat(s.slice(1));
    if (s.startsWith('EU ')) return 200 + parseFloat(s.slice(3));
    return 400;
  };
  const STATUS_LABEL = { available: 'В продаже', sold: 'Продано', hidden: 'Скрыто' };

  // ---------- мелкие помощники ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null) continue;
      if (k.startsWith('aria-')) { el.setAttribute(k, String(v)); continue; }
      if (v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  const svg = (d, extra) => `<svg viewBox="0 0 24 24" aria-hidden="true">${extra || ''}<path d="${d}"/></svg>`;
  const HEART = svg('M12 20.5 4.6 13a4.9 4.9 0 0 1 7-6.9l.4.4.4-.4a4.9 4.9 0 0 1 7 6.9z');
  const CHEVRON = svg('m9 6 6 6-6 6');
  const BACK = svg('m14 6-6 6 6 6');
  const SHARE = svg('M12 16V4M8 8l4-4 4 4M5 13v7h14v-7');

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
  const photoUrl = (p) => (/^(data:|https?:)/.test(p) ? p : typeof localPhotos !== 'undefined' && localPhotos.has(p) ? localPhotos.get(p) : PHOTO_BASE + String(p).split('/').map(encodeURIComponent).join('/'));
  const money = (n) => Number(n).toLocaleString('ru-RU') + ' ₽';
  function priceHtml(it) {
    if (!it.price) return '<small>Цена по запросу</small>';
    return (it.priceFrom ? '<small>от </small>' : '') + esc(money(it.price));
  }
  function plural(n, one, few, many) {
    const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  }
  // ссылки и @упоминания в тексте
  function linkify(text) {
    // без lookbehind: его нет в старых iOS
    return esc(text).replace(/(https?:\/\/[^\s<]+[^\s<.,!?)])|(^|[^\w\/.])(?:@([a-zA-Z]\w{3,31})|(t\.me\/[\w\/+?=%-]+))/g, (m, url, pre, user, tme) => {
      if (url) return `<a href="${url}" data-ext target="_blank" rel="noopener">${url}</a>`;
      const href = user ? 'https://t.me/' + user : 'https://' + tme;
      return `${pre}<a href="${href}" data-ext target="_blank" rel="noopener">${user ? '@' + user : tme}</a>`;
    });
  }
  function openLink(url) {
    if (inTg && /^https?:\/\/t\.me\//i.test(url) && tg.openTelegramLink) tg.openTelegramLink(url);
    else if (inTg && tg.openLink) tg.openLink(url);
    else window.open(url, '_blank', 'noopener');
  }
  function haptic(kind) {
    try {
      if (!tgAtLeast('6.1')) return;
      if (kind === 'ok' || kind === 'error') tg.HapticFeedback.notificationOccurred(kind === 'ok' ? 'success' : 'error');
      else tg.HapticFeedback.impactOccurred('light');
    } catch (e) { /* не критично */ }
  }
  let toastTimer;
  function toast(text, isError) {
    const el = $('toast');
    el.textContent = text;
    el.classList.toggle('is-error', !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 4500 : 2200);
  }
  function confirmBox(text) {
    return new Promise((resolve) => {
      if (tgAtLeast('6.2') && tg.showConfirm) tg.showConfirm(text, resolve);
      else resolve(window.confirm(text));
    });
  }

  // ---------- данные: всё лежит в репозитории GitHub ----------
  // Покупатели читают data/catalog.json с GitHub Pages. Владелец вводит свой ключ GitHub,
  // и правки сохраняются прямо в репозиторий через GitHub API — без своего сервера.
  const GH_API = window.__GH_API__ || 'https://api.github.com';
  const TOKEN_KEY = 'd9_token';
  let ghToken = '';
  function repoPath() {
    if (state.config.repo) return state.config.repo;
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (!m) return '';
    return m[1] + '/' + (location.pathname.split('/').filter(Boolean)[0] || m[1] + '.github.io');
  }
  const b64encode = (str) => { const b = new TextEncoder().encode(str); let out = ''; for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(out); };
  const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  async function gh(method, path, body, token) {
    const res = await fetch(`${GH_API}/repos/${repoPath()}${path}`, {
      method, cache: 'no-store',
      headers: Object.assign({ Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + (token || ghToken) }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(res.status === 401 ? 'Ключ GitHub не подошёл или истёк. Введите новый во вкладке «Инфо».'
        : res.status === 403 || res.status === 404 ? 'GitHub отказал в доступе: у ключа нет права записи в этот репозиторий.' : 'GitHub: ' + (data.message || res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }
  async function readCatalog() {
    const file = await gh('GET', '/contents/data/catalog.json');
    return { data: JSON.parse(b64decode(file.content)), sha: file.sha };
  }
  // читает свежий каталог, применяет правку и записывает; если его успели изменить — повторяет
  async function mutate(message, fn) {
    for (let attempt = 0; ; attempt++) {
      const { data, sha } = await readCatalog();
      const result = fn(data);
      try {
        await gh('PUT', '/contents/data/catalog.json', { message, content: b64encode(JSON.stringify(data, null, 0)), sha });
        applyCatalog(data);
        return result;
      } catch (e) {
        if ((e.status !== 409 && e.status !== 422) || attempt >= 3) throw e;
      }
    }
  }
  async function putFile(path, base64, message) {
    await gh('PUT', '/contents/' + path.split('/').map(encodeURIComponent).join('/'), { message, content: base64 });
  }
  const nowSec = () => Math.floor(Date.now() / 1000);
  const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const findItem = (data, id) => { const it = data.items.find((i) => String(i.id) === String(id)); if (!it) throw new Error('Вещь не найдена — возможно, её уже удалили.'); return it; };
  function applyFields(item, body) {
    let changed = false;
    const set = (k, v) => { if (JSON.stringify(item[k]) !== JSON.stringify(v)) { item[k] = v; changed = true; } };
    const str = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max);
    if ('title' in body) set('title', str(body.title, 200) || 'Без названия');
    if ('category' in body) set('category', str(body.category, 40) || 'Другое');
    if ('size' in body) set('size', str(body.size, 200));
    if ('condition' in body) set('condition', str(body.condition, 300));
    if ('description' in body) set('description', str(body.description, 4000));
    if ('price' in body) { const n = parseInt(String(body.price).replace(/\D/g, ''), 10); set('price', n > 0 ? n : null); }
    if ('priceFrom' in body) set('priceFrom', !!body.priceFrom);
    if (('size' in body || 'category' in body) && window.D9Parse) item.sizes = window.D9Parse.normalizeSizes(item.size, item.category);
    if (body.status && STATUS_LABEL[body.status]) item.status = body.status;
    if (Array.isArray(body.photoOrder)) {
      const order = body.photoOrder.map(String);
      item.photos.sort((a, b) => { const ia = order.indexOf(String(a.id)), ib = order.indexOf(String(b.id)); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib); });
    }
    if (changed && item.source === 'channel') item.manual = true; // правки поста больше не перезапишут текст
    item.updated = nowSec();
  }
  const api = {
    createItem: (body) => mutate('Новая вещь: ' + (body.title || 'без названия'), (data) => {
      const item = { id: rid('n'), source: 'manual', status: 'hidden', title: '', category: 'Другое', size: '', sizes: [], condition: '', price: null, priceFrom: false, description: '', tags: [], photos: [], date: nowSec(), updated: nowSec() };
      applyFields(item, body);
      data.items.push(item);
      return item.id;
    }),
    patchItem: (id, body) => mutate('Правка: ' + (body.title || id), (data) => { applyFields(findItem(data, id), body); }),
    deleteItem: (id) => mutate('Удалена вещь ' + id, (data) => { data.items.splice(data.items.indexOf(findItem(data, id)), 1); }),
    async addPhoto(id, ph) {
      const pid = rid('u');
      const rel = `items/${id}/${pid}`;
      await putFile(`photos/${rel}.jpg`, ph.full, 'Фото');
      await putFile(`photos/${rel}_t.jpg`, ph.thumb, 'Миниатюра');
      localPhotos.set(rel + '.jpg', 'data:image/jpeg;base64,' + ph.full).set(rel + '_t.jpg', 'data:image/jpeg;base64,' + ph.thumb);
      await mutate('Добавлено фото', (data) => { findItem(data, id).photos.push({ id: pid, f: rel + '.jpg', t: rel + '_t.jpg', w: ph.w, h: ph.h }); });
    },
    deletePhoto: (id, pid) => mutate('Удалено фото', (data) => {
      const it = findItem(data, id);
      const i = it.photos.findIndex((p) => String(p.id) === String(pid));
      if (i < 0) return;
      const [p] = it.photos.splice(i, 1);
      if (it.source === 'channel' && typeof p.id === 'number') (it.removedPhotos = it.removedPhotos || []).push(p.id);
    }),
    saveInfo: (info) => mutate('Текст вкладки «Инфо»', (data) => { data.info = info; }),
  };
  // только что загруженные фото показываем из памяти: на сайте они появятся через минуту-две
  const localPhotos = new Map();
  function applyCatalog(data) {
    state.items = data.items.map((i) => Object.assign(i, { id: String(i.id) }));
    state.byId = new Map(state.items.map((i) => [i.id, i]));
    state.info = data.info || { text: '', links: [] };
    state.categories = data.categories || [];
    state.config = Object.assign(state.config, data.config);
  }
  function loadParser() {
    if (window.D9Parse || document.getElementById('d9parse')) return;
    document.head.append(h('script', { id: 'd9parse', src: 'sync/parse.js' }));
  }
  function storedToken() {
    return new Promise((resolve) => {
      let local = '';
      try { local = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* нет доступа */ }
      const cs = cloud();
      if (local || !cs) return resolve(local);
      cs.getItem(TOKEN_KEY, (err, v) => resolve(err ? '' : v || ''));
    });
  }
  function storeToken(token) {
    try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* нет доступа */ }
    const cs = cloud();
    if (cs) { if (token) cs.setItem(TOKEN_KEY, token); else cs.removeItem(TOKEN_KEY); }
  }
  async function signIn(token) {
    const repo = await gh('GET', '', null, token);
    if (!repo.permissions || !repo.permissions.push) throw new Error('У этого ключа нет права записи в репозиторий. Создайте ключ с доступом Contents: Read and write.');
    ghToken = token;
    storeToken(token);
    state.admin = true;
    loadParser();
    applyCatalog((await readCatalog()).data); // владелец всегда видит самую свежую версию
  }
  function signOut() { ghToken = ''; storeToken(''); state.admin = false; }

  // ---------- избранное ----------
  const FAV_KEY = 'd9_fav';
  const cloud = () => (tgAtLeast('6.9') && tg.CloudStorage ? tg.CloudStorage : null);
  function loadFav() {
    try { state.fav = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]').map(String)); } catch (e) { state.fav = new Set(); }
    const cs = cloud();
    if (!cs) return;
    cs.getItem(FAV_KEY, (err, value) => {
      if (err || !value) return;
      try { state.fav = new Set(JSON.parse(value).map(String)); } catch (e) { return; }
      refreshFavUi();
    });
  }
  function saveFav() {
    const value = JSON.stringify([...state.fav].slice(-300));
    try { localStorage.setItem(FAV_KEY, value); } catch (e) { /* приватный режим */ }
    const cs = cloud();
    if (cs) cs.setItem(FAV_KEY, value);
  }
  function toggleFav(id, btn) {
    id = String(id);
    if (state.fav.has(id)) state.fav.delete(id); else state.fav.add(id);
    saveFav();
    haptic();
    if (btn && state.fav.has(id)) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); }
    refreshFavUi();
  }
  function refreshFavUi() {
    document.querySelectorAll('[data-fav]').forEach((b) => {
      const on = state.fav.has(b.dataset.fav);
      b.setAttribute('aria-pressed', on);
      b.setAttribute('aria-label', on ? 'Убрать из избранного' : 'В избранное');
    });
    const n = [...state.fav].filter((id) => state.byId.has(id)).length;
    $('fav-badge').hidden = !n;
    $('fav-badge').textContent = n;
    if (state.tab === 'fav') renderFav();
  }

  // ---------- корзина ----------
  // набор вещей, которые покупатель хочет купить; отправляется продавцу одним сообщением
  const CART_KEY = 'd9_cart';
  function loadCart() {
    try { state.cart = new Set(JSON.parse(localStorage.getItem(CART_KEY) || '[]').map(String)); } catch (e) { state.cart = new Set(); }
    const cs = cloud();
    if (!cs) return;
    cs.getItem(CART_KEY, (err, value) => {
      if (err || !value) return;
      try { state.cart = new Set(JSON.parse(value).map(String)); } catch (e) { return; }
      refreshCartUi();
    });
  }
  function saveCart() {
    const value = JSON.stringify([...state.cart].slice(-100));
    try { localStorage.setItem(CART_KEY, value); } catch (e) { /* приватный режим */ }
    const cs = cloud();
    if (cs) cs.setItem(CART_KEY, value);
  }
  function cartItems() {
    return [...state.cart].map((id) => state.byId.get(id)).filter((i) => i && i.status === 'available');
  }
  function toggleCart(id) {
    id = String(id);
    const had = state.cart.has(id);
    if (had) state.cart.delete(id); else state.cart.add(id);
    saveCart();
    haptic();
    toast(had ? 'Убрал из корзины' : 'Добавил в корзину');
    refreshCartUi();
  }
  function refreshCartUi() {
    document.querySelectorAll('[data-cart]').forEach((b) => {
      const on = state.cart.has(b.dataset.cart);
      b.setAttribute('aria-pressed', on);
      b.classList.toggle('btn-quiet', on);
      const label = b.querySelector('span');
      if (label) label.textContent = on ? 'В корзине' : 'В корзину';
    });
    const n = cartItems().length;
    $('cart-badge').hidden = !n;
    $('cart-badge').textContent = n;
    if (state.tab === 'cart') renderCart();
  }
  function cartText() {
    const list = cartItems();
    const shown = list.slice(0, 15);
    const lines = shown.map((it, n) => {
      const size = sizeLabel(it) ? ' (' + sizeLabel(it) + ')' : '';
      const price = it.price ? money(it.price) : 'цена по запросу';
      return `${n + 1}. ${it.title}${size} — ${price}`;
    });
    if (list.length > shown.length) lines.push(`…и ещё ${list.length - shown.length}`);
    const total = list.reduce((s, i) => s + (i.price || 0), 0);
    let text = 'Здравствуйте! Хочу купить:\n' + lines.join('\n');
    if (total) text += '\n\nИтого: ' + money(total);
    return text;
  }
  function renderCart() {
    const list = cartItems();
    $('cart-empty').hidden = list.length > 0;
    $('cart-bar').hidden = !list.length;
    const total = list.reduce((s, i) => s + (i.price || 0), 0);
    $('cart-total').textContent = total ? money(total) : '';
    $('cart-list').replaceChildren(...list.map((it) => h('div', { class: 'cart-row' },
      h('a', { class: 'cart-link', href: '#item/' + it.id },
        h('div', { class: 'row-img' }, thumbImg(it)),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, it.title),
          h('div', { class: 'row-sub' }, [it.price ? money(it.price) : 'цена по запросу', sizeLabel(it)].filter(Boolean).join(', ')))),
      h('button', { class: 'cart-del', type: 'button', 'aria-label': 'Убрать из корзины', onclick: () => toggleCart(it.id) }, '×'))));
  }

  // ---------- поделиться вещью ----------
  function itemUrl(it) { return location.origin + location.pathname + '#item/' + it.id; }
  function shareItem(it) {
    const url = itemUrl(it);
    const text = it.title + (it.price ? ' — ' + money(it.price) : '');
    const tgShare = 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text);
    if (inTg && tg.openTelegramLink) return tg.openTelegramLink(tgShare);
    if (navigator.share) return navigator.share({ title: it.title, text, url }).catch(() => {});
    openLink(tgShare);
  }

  // ---------- карточки ----------
  function sizeLabel(it) { return it.sizes && it.sizes.length ? it.sizes.join(' ') : ''; }
  function thumbImg(it) {
    const p = it.photos[0];
    if (!p) return null;
    const img = h('img', { src: photoUrl(p.t || p.f), alt: '', loading: 'lazy', decoding: 'async' });
    if (p.t && p.t !== p.f) img.addEventListener('error', () => { img.src = photoUrl(p.f); }, { once: true });
    return img;
  }
  function card(it) {
    const label = sizeLabel(it);
    return h('article', { class: 'card' + (it.status !== 'available' ? ' is-sold' : '') },
      h('a', { class: 'card-link', href: '#item/' + it.id },
        h('div', { class: 'card-photo' }, thumbImg(it)),
        h('div', { class: 'card-body' },
          h('h3', { class: 'card-title' }, it.title),
          h('div', { class: 'card-meta' },
            h('span', { class: 'price', html: priceHtml(it) }),
            label ? h('span', { class: 'tag' }, label) : null))),
      it.status !== 'available' ? h('span', { class: 'sold-mark' }, it.status === 'sold' ? 'Продано' : 'Скрыто') : null,
      h('button', { class: 'heart', type: 'button', 'data-fav': it.id, 'aria-pressed': state.fav.has(it.id), html: HEART, onclick: (e) => toggleFav(it.id, e.currentTarget) }));
  }

  // ---------- каталог ----------
  const available = () => state.items.filter((i) => i.status === 'available');
  function matches(it, skip) {
    if (skip !== 'cat' && state.cat && it.category !== state.cat) return false;
    if (skip !== 'size' && state.sizes.size && !(it.sizes || []).some((s) => state.sizes.has(s))) return false;
    if (state.q) {
      const hay = it._hay || (it._hay = norm([it.title, it.category, it.size, (it.sizes || []).join(' '), (it.tags || []).join(' '), it.description].join(' ')));
      for (const w of norm(state.q).split(/\s+/)) if (w && !hay.includes(w)) return false;
    }
    return true;
  }
  // короткие подписи для ленты: длинные названия категорий не влезают в один ряд
  const SHORT_CAT = {
    'Футболки': 'Футболки', 'Худи и зипки': 'Худи', 'Головные уборы': 'Кепки', 'Лонгсливы': 'Лонгсливы',
    'Обувь': 'Обувь', 'Аксессуары': 'Аксессуары', 'Штаны': 'Штаны', 'Верхняя одежда': 'Верх', 'Другое': 'Другое',
  };
  const shortCat = (c) => SHORT_CAT[c] || c;
  // размеры группируем по формату записи, а не по типу вещи: штаны бывают и W, и L/XL
  function sizeGroups(list) {
    return [
      ['Буквы и One Size', list.filter((s) => !/^(EU |W\d)/.test(s) && !/^\d+\s+\d+\/\d+/.test(s))],
      ['Головные уборы', list.filter((s) => /^\d+\s+\d+\/\d+/.test(s))],
      ['Обувь (EU)', list.filter((s) => s.startsWith('EU '))],
      ['Поясной размер (W)', list.filter((s) => /^W\d/.test(s))],
    ].filter((g) => g[1].length);
  }
  function categoriesOf(all) {
    const list = state.categories.filter((c) => all.some((i) => i.category === c));
    all.forEach((i) => { if (!list.includes(i.category)) list.push(i.category); });
    return list;
  }
  function popularCats(all) {
    const n = {};
    all.forEach((i) => { n[i.category] = (n[i.category] || 0) + 1; });
    return categoriesOf(all).slice().sort((a, b) => (n[b] || 0) - (n[a] || 0)).slice(0, 3);
  }

  function renderFilters() {
    const all = available();
    const counts = {};
    all.forEach((i) => { counts[i.category] = (counts[i.category] || 0) + 1; });
    const cats = categoriesOf(all).slice().sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
    const pop = popularCats(all);

    // лента в шапке: «Все», три ходовые категории и «Ещё»
    const shown = pop.slice();
    if (state.cat && !shown.includes(state.cat)) shown.unshift(state.cat);
    $('cats').replaceChildren(
      h('button', { class: 'cat', type: 'button', 'aria-pressed': !state.cat, onclick: () => setCat('') }, 'Все'),
      ...shown.map((c) => h('button', { class: 'cat', type: 'button', 'aria-pressed': state.cat === c, onclick: () => setCat(c) }, shortCat(c))),
      h('button', { class: 'cat cat-more', type: 'button', onclick: () => openSheet('filters') }, 'Ещё'));

    // шторка «Тип вещи»
    $('sheet-cats').replaceChildren(
      h('button', { class: 'fchip', type: 'button', 'aria-pressed': !state.cat, onclick: () => setCat('') }, 'Все'),
      ...cats.map((c) => h('button', { class: 'fchip', type: 'button', 'aria-pressed': state.cat === c, onclick: () => setCat(c) }, c)));

    // экран размера
    const sizes = new Set();
    all.filter((i) => matches(i, 'size')).forEach((i) => (i.sizes || []).forEach((s) => sizes.add(s)));
    state.sizes.forEach((s) => sizes.add(s));
    const sorted = [...sizes].sort((a, b) => sizeRank(a) - sizeRank(b) || a.localeCompare(b));
    $('sizes-list').replaceChildren(...sizeGroups(sorted).map(([label, list]) => h('div', { class: 'sgroup' },
      h('div', { class: 'sgroup-t' }, label),
      h('div', { class: 'stags' }, list.map((s) => h('button', { class: 'tag', type: 'button', 'aria-pressed': state.sizes.has(s), onclick: () => toggleSize(s) }, s))))));

    // сводка в строке «Размер» и счётчик на плашке
    const chosen = [...state.sizes].sort((a, b) => sizeRank(a) - sizeRank(b));
    const sum = $('size-sum');
    sum.textContent = chosen.length ? chosen.join(', ') : 'любой';
    sum.classList.toggle('is-on', chosen.length > 0);

    const active = (state.cat ? 1 : 0) + state.sizes.size;
    $('fcount').hidden = !active;
    $('fcount').textContent = active;
    $('open-filters').classList.toggle('is-on', active > 0);

    // чипы выбранного под шапкой
    const chips = [];
    if (state.cat) chips.push(h('button', { class: 'fx', type: 'button', onclick: () => setCat('') }, shortCat(state.cat), h('b', {}, '×')));
    chosen.forEach((s) => chips.push(h('button', { class: 'fx', type: 'button', onclick: () => toggleSize(s) }, s, h('b', {}, '×'))));
    $('active').replaceChildren(...chips);
  }
  function setCat(c) { state.cat = c; haptic(); renderCatalog(); }
  function toggleSize(s) { if (state.sizes.has(s)) state.sizes.delete(s); else state.sizes.add(s); haptic(); renderCatalog(); }
  function resetFilters() {
    state.q = ''; state.cat = ''; state.sizes.clear();
    $('q').value = ''; $('q-clear').hidden = true;
    renderCatalog();
  }
  function renderCatalog() {
    renderFilters();
    const list = available().filter((i) => matches(i));
    if (state.sort === 'cheap') list.sort((a, b) => (a.price || Infinity) - (b.price || Infinity) || b.date - a.date);
    else if (state.sort === 'dear') list.sort((a, b) => (b.price || 0) - (a.price || 0) || b.date - a.date);
    else list.sort((a, b) => b.date - a.date);
    $('grid').replaceChildren(...list.map(card));
    const filtered = !!(state.q || state.cat || state.sizes.size);
    const countText = list.length + ' ' + plural(list.length, 'вещь', 'вещи', 'вещей');
    $('count').textContent = countText;
    $('cta-count').textContent = countText;
    $('size-count').textContent = countText;
    $('reset').hidden = !filtered;
    $('empty').hidden = list.length > 0;
    $('grid').hidden = !list.length;
  }

  function renderFav() {
    const list = [...state.fav].reverse().map((id) => state.byId.get(id)).filter((i) => i && (i.status !== 'hidden' || state.admin));
    $('fav-grid').replaceChildren(...list.map(card));
    $('fav-empty').hidden = list.length > 0;
  }

  // ---------- инфо ----------
  // внешняя ссылка: в Telegram открывается через его API, в обычном браузере — в новой вкладке
  function ext(attrs, url, ...kids) {
    return h('a', Object.assign({ href: url, 'data-ext': true, target: '_blank', rel: 'noopener' }, attrs), ...kids);
  }
  function sellerUrl(text) {
    const base = 'https://t.me/' + state.config.seller;
    return text ? base + '?text=' + encodeURIComponent(text) : base;
  }
  function renderInfo() {
    const blocks = [];
    let lead = null;
    for (const raw of String(state.info.text || '').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) blocks.push(h('h2', {}, line.replace(/^#+\s*/, '')));
      else if (!blocks.length && !lead) lead = h('p', { class: 'info-lead', html: linkify(line) });
      else blocks.push(h('p', { html: linkify(line) }));
    }
    const links = (state.info.links || []).map((l) => ext({}, l.url, h('span', {}, l.label), h('span', { html: CHEVRON })));
    $('view-info').replaceChildren(h('div', { class: 'info' },
      h('div', { class: 'info-head' },
        h('span', { class: 'ava ava-lg', html: '<b>D9</b><img src="avatar.jpg" alt="" onerror="this.remove()">' }),
        h('div', {}, h('h1', { class: 'wordmark' }, 'D9rain'),
          state.config.channel ? h('div', { class: 'info-sub' }, '@' + state.config.channel) : null)),
      lead,
      state.config.seller ? ext({ class: 'btn btn-block' }, sellerUrl(), 'Написать @' + state.config.seller) : null,
      h('div', { class: 'sparkle', 'aria-hidden': 'true' }, '✦ ✧ ✦'),
      h('div', { class: 'info-text' }, blocks),
      links.length ? h('div', { class: 'links' }, links) : null,
      DEMO ? null : h('div', { class: 'owner' }, state.admin
        ? h('button', { class: 'link-btn', type: 'button', onclick: () => { signOut(); afterAuthChange(); toast('Вы вышли из управления'); } }, 'Выйти из управления')
        : h('a', { class: 'link-btn', href: '#owner' }, 'Вход для владельца'))));
  }
  function afterAuthChange() {
    document.querySelector('#tabbar [data-tab="admin"]').hidden = !state.admin;
    afterDataChange();
    renderInfo();
  }
  function renderOwnerLogin() {
    const root = $('editor');
    const input = h('input', { type: 'text', placeholder: 'github_pat_…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const btn = h('button', { class: 'btn', type: 'button' }, 'Войти');
    btn.addEventListener('click', async () => {
      const token = input.value.trim();
      if (!token) { input.focus(); return; }
      btn.disabled = true;
      try {
        await signIn(token);
        afterAuthChange();
        toast('Готово, вкладка «Управление» открыта');
        history.replaceState(null, '', '#admin');
        route();
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });
    root.replaceChildren(h('div', { class: 'sheet-inner form' },
      backBtn(),
      h('h1', {}, 'Вход для владельца'),
      h('label', { class: 'field' }, h('span', {}, 'Ключ GitHub'), input,
        h('div', { class: 'field-hint' }, 'Вставьте ключ доступа GitHub с правом записи в репозиторий каталога. Он хранится только на ваших устройствах и нужен, чтобы сохранять правки. Как его получить — в README.')),
      h('div', { class: 'item-bar' }, btn)));
  }

  // ---------- карточка вещи ----------
  function orderText(it) {
    const parts = [it.title];
    if (it.size) parts.push('размер ' + (sizeLabel(it) || it.size));
    if (it.price) parts.push((it.priceFrom ? 'от ' : '') + money(it.price));
    let text = 'Здравствуйте! Интересует: ' + parts.join(', ');
    if (it.msgId && state.config.channel) text += `\nhttps://t.me/${state.config.channel}/${it.msgId}`;
    return text;
  }
  function renderItem(id) {
    const it = state.byId.get(String(id));
    const root = $('item');
    if (!it || (it.status === 'hidden' && !state.admin)) {
      root.replaceChildren(h('div', { class: 'sheet-inner' }, backBtn(),
        h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, 'Вещь не найдена'), h('p', {}, 'Возможно, её уже продали.'), h('a', { class: 'btn btn-quiet', href: '#' }, 'Перейти в каталог'))));
      return;
    }
    const photos = it.photos;
    const first = photos[0];
    const ratio = first && first.w && first.h ? Math.min(1.25, Math.max(0.75, first.w / first.h)) : 0.75;
    const counter = h('span', { class: 'counter' }, '1 / ' + photos.length);
    const track = h('div', { class: 'gallery-track' }, photos.map((p, n) => {
      const img = h('img', { src: photoUrl(n === 0 && p.t ? p.t : p.f), alt: n === 0 ? it.title : '', loading: n < 2 ? 'eager' : 'lazy', decoding: 'async' });
      if (n === 0 && p.t && p.t !== p.f) { // сначала лёгкая обложка, затем полное фото
        const full = new Image();
        full.onload = () => { img.src = full.src; };
        full.src = photoUrl(p.f);
      }
      return h('div', { class: 'slide', style: `aspect-ratio:${ratio}` }, img);
    }));
    track.addEventListener('scroll', () => {
      const n = Math.round(track.scrollLeft / Math.max(1, track.clientWidth)) + 1;
      counter.textContent = Math.min(photos.length, Math.max(1, n)) + ' / ' + photos.length;
    }, { passive: true });
    const step = (d) => track.scrollBy({ left: d * track.clientWidth, behavior: 'smooth' });
    const sold = it.status !== 'available';
    const specs = [['Размер', it.size], ['Состояние', it.condition]].filter((r) => r[1]);
    const inCart = state.cart.has(it.id);
    const cartBtn = h('button', {
      class: 'btn' + (inCart ? ' btn-quiet' : ''), type: 'button', 'data-cart': it.id, 'aria-pressed': inCart,
      onclick: () => toggleCart(it.id),
    }, h('span', {}, inCart ? 'В корзине' : 'В корзину'));

    root.replaceChildren(h('div', { class: 'sheet-inner' },
      backBtn(),
      photos.length ? h('div', { class: 'gallery' }, track,
        photos.length > 1 ? [counter,
          h('button', { class: 'gallery-nav prev', type: 'button', 'aria-label': 'Предыдущее фото', html: BACK, onclick: () => step(-1) }),
          h('button', { class: 'gallery-nav next', type: 'button', 'aria-label': 'Следующее фото', html: CHEVRON, onclick: () => step(1) })] : null) : null,
      h('div', { class: 'item-body' },
        h('h1', { class: 'item-title' }, it.title),
        h('div', { class: 'item-price-row' },
          h('span', { class: 'price-lg', html: priceHtml(it) }),
          (it.sizes || []).map((s) => h('span', { class: 'tag' }, s))),
        sold ? h('p', { class: 'sold-note' }, it.status === 'sold' ? 'Эта вещь уже продана.' : 'Вещь скрыта из каталога — её видите только вы.') : null,
        specs.length ? h('dl', { class: 'specs' }, specs.map((r) => h('div', {}, h('dt', {}, r[0]), h('dd', {}, r[1])))) : null,
        it.description ? h('p', { class: 'desc', html: linkify(it.description) }) : null,
        it.msgId && state.config.channel ? ext({ class: 'post-link' }, `https://t.me/${state.config.channel}/${it.msgId}`, 'Открыть пост в канале') : null,
        state.admin ? h('div', {}, h('a', { class: 'post-link', href: '#edit/' + it.id }, 'Редактировать вещь')) : null),
      h('div', { class: 'item-bar' },
        h('button', { class: 'heart-lg', type: 'button', 'data-fav': it.id, 'aria-pressed': state.fav.has(it.id), 'aria-label': 'В избранное', html: HEART, onclick: (e) => toggleFav(it.id, e.currentTarget) }),
        h('button', { class: 'heart-lg', type: 'button', 'aria-label': 'Поделиться вещью', html: SHARE, onclick: () => shareItem(it) }),
        sold && it.status === 'sold'
          ? ext({ class: 'btn btn-quiet' }, sellerUrl(), 'Спросить о похожих')
          : [sold ? null : cartBtn, ext({ class: 'btn' }, sellerUrl(orderText(it)), 'Написать')])));
    root.scrollTop = 0;
  }
  function backBtn() { return h('button', { class: 'back', type: 'button', 'aria-label': 'Назад', html: BACK, onclick: goBack }); }
  function goBack() {
    const hash = location.hash.replace(/^#/, '');
    if (hash === 'sizes') return backToFilters();
    if (hash === 'filters') return closeSheets();
    if (history.length > 1 && state.depth > 0) history.back(); else location.hash = '';
  }

  // ---------- шторки фильтров ----------
  function openSheet(name) {
    if (location.hash === '#' + name) return;
    state.depth++;
    location.hash = '#' + name;
  }
  function closeSheets() {
    state.depth = 0;
    history.replaceState(null, '', location.pathname + location.search);
    route();
  }
  function backToFilters() {
    if (state.depth > 1) { state.depth--; history.back(); }
    else location.replace('#filters');
  }
  function resetFilterSheet() { state.cat = ''; state.sizes.clear(); renderCatalog(); }

  // ---------- управление ----------
  function renderAdmin() {
    const counts = { available: 0, sold: 0, hidden: 0 };
    state.items.forEach((i) => { counts[i.status] = (counts[i.status] || 0) + 1; });
    const seg = [['available', 'В продаже'], ['sold', 'Продано'], ['hidden', 'Скрыто'], ['all', 'Все']].map(([k, label]) =>
      h('button', { type: 'button', 'aria-pressed': state.adminFilter === k, onclick: () => { state.adminFilter = k; renderAdmin(); } },
        label + (k === 'all' ? '' : ' ' + counts[k])));
    const search = h('input', { type: 'search', placeholder: 'Найти вещь по названию', value: state.adminQ, 'aria-label': 'Поиск', autocomplete: 'off' });
    const list = () => {
      const q = norm(state.adminQ);
      return state.items.filter((i) => (state.adminFilter === 'all' || i.status === state.adminFilter) && (!q || norm(i.title).includes(q))).sort((a, b) => b.date - a.date);
    };
    const rows = h('div', { class: 'rows' });
    search.addEventListener('input', () => { state.adminQ = search.value; renderAdminRows(rows, list()); });
    renderAdminRows(rows, list());
    $('view-admin').replaceChildren(h('div', { class: 'admin' },
      h('h1', { class: 'page-title' }, 'Управление'),
      h('div', { class: 'admin-actions' },
        h('a', { class: 'btn', href: '#edit/new' }, 'Добавить вещь'),
        h('a', { class: 'btn btn-quiet', href: '#editinfo' }, 'Текст «Инфо»')),
      h('label', { class: 'search' }, h('span', { html: svg('m20 20-3.6-3.6', '<circle cx="11" cy="11" r="7"/>') }), search),
      h('div', { class: 'seg' }, seg),
      rows));
  }
  function renderAdminRows(rows, list) {
    rows.replaceChildren(...(list.length ? list.map((it) => h('a', { class: 'row', href: '#edit/' + it.id },
      h('div', { class: 'row-img' }, thumbImg(it)),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, it.title || 'Без названия'),
        h('div', { class: 'row-sub' }, [it.price ? money(it.price) : 'без цены', sizeLabel(it)].filter(Boolean).join(', '))),
      h('span', { class: 'status ' + it.status }, STATUS_LABEL[it.status])))
      : [h('div', { class: 'empty' }, h('p', {}, 'Здесь пока ничего нет.'))]));
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать фото')); };
      img.src = url;
    });
  }
  function shrink(img, max, quality) {
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return { data: c.toDataURL('image/jpeg', quality).split(',')[1], w: c.width, h: c.height };
  }

  let editing = null; // {item, isNew}
  function renderEditor(id) {
    const root = $('editor');
    const isNew = id === 'new';
    const src = isNew ? null : state.byId.get(String(id));
    if (!isNew && !src) { root.replaceChildren(h('div', { class: 'sheet-inner form' }, backBtn(), h('p', {}, 'Вещь не найдена.'))); return; }
    const item = isNew
      ? { id: null, status: 'available', title: '', category: 'Футболки', size: '', condition: '', price: null, priceFrom: false, description: '', photos: [] }
      : JSON.parse(JSON.stringify(src));
    editing = { item, isNew };

    const f = {
      title: h('input', { type: 'text', value: item.title, maxlength: 200, placeholder: 'Футболка Bladee Cold Visions' }),
      price: h('input', { type: 'text', inputmode: 'numeric', value: item.price || '', placeholder: '9000' }),
      priceFrom: h('input', { type: 'checkbox', checked: item.priceFrom }),
      category: h('select', {}, [...new Set([...state.categories, item.category])].map((c) => h('option', { value: c, selected: c === item.category }, c))),
      size: h('input', { type: 'text', value: item.size, maxlength: 200, placeholder: 'L, 2XL, 12us 46eu, O/S' }),
      condition: h('input', { type: 'text', value: item.condition, maxlength: 300, placeholder: '9/10' }),
      description: h('textarea', { maxlength: 4000, placeholder: 'Замеры, особенности, комплект' }),
    };
    f.description.value = item.description;
    const values = () => ({
      title: f.title.value, price: f.price.value.replace(/[^\d]/g, ''), priceFrom: f.priceFrom.checked, category: f.category.value,
      size: f.size.value, condition: f.condition.value, description: f.description.value, status: item.status,
    });

    // новая вещь создаётся на сервере скрытой при первом действии (фото или сохранение)
    async function ensureCreated() {
      if (item.id) return;
      item.id = await api.createItem(Object.assign(values(), { status: 'hidden' }));
    }

    const photosBox = h('div', { class: 'photos' });
    function drawPhotos(busy) {
      const tiles = item.photos.map((p, n) => {
        const img = h('img', { src: photoUrl(p.t || p.f), alt: '', loading: 'lazy' });
        if (p.t && p.t !== p.f) img.addEventListener('error', () => { img.src = photoUrl(p.f); }, { once: true });
        return h('div', { class: 'ph' }, img,
          n === 0 ? h('span', { class: 'ph-cover' }, 'Обложка') : null,
          h('div', { class: 'ph-tools' },
            h('button', { type: 'button', disabled: n === 0, 'aria-label': 'Сдвинуть влево', onclick: () => movePhoto(n, -1) }, '←'),
            h('button', { type: 'button', disabled: n === item.photos.length - 1, 'aria-label': 'Сдвинуть вправо', onclick: () => movePhoto(n, 1) }, '→'),
            h('button', { type: 'button', 'aria-label': 'Удалить фото', onclick: () => deletePhoto(p) }, '×')));
      });
      for (let i = 0; i < (busy || 0); i++) tiles.push(h('div', { class: 'ph is-busy' }, 'Загрузка…'));
      const input = h('input', { type: 'file', accept: 'image/*', multiple: true });
      input.addEventListener('change', () => addPhotos([...input.files]));
      tiles.push(h('label', { class: 'ph ph-add' }, input, h('span', {}, h('b', {}, '+'), 'Добавить фото')));
      photosBox.replaceChildren(...tiles);
    }
    async function addPhotos(files) {
      if (!files.length) return;
      try {
        await ensureCreated();
        for (let i = 0; i < files.length; i++) {
          drawPhotos(files.length - i);
          const img = await loadImage(files[i]);
          const full = shrink(img, 1600, 0.86);
          const thumb = shrink(img, 560, 0.76);
          await api.addPhoto(item.id, { full: full.data, thumb: thumb.data, w: full.w, h: full.h });
          item.photos = JSON.parse(JSON.stringify(state.byId.get(item.id).photos));
        }
        haptic('ok');
      } catch (e) { toast(e.message, true); haptic('error'); }
      drawPhotos();
      afterDataChange();
    }
    async function movePhoto(n, d) {
      const arr = item.photos;
      [arr[n], arr[n + d]] = [arr[n + d], arr[n]];
      drawPhotos();
      try {
        await api.patchItem(item.id, { photoOrder: arr.map((p) => p.id) });
        afterDataChange();
      } catch (e) { toast(e.message, true); }
    }
    async function deletePhoto(p) {
      if (!(await confirmBox('Удалить это фото?'))) return;
      try {
        await api.deletePhoto(item.id, p.id);
        item.photos = JSON.parse(JSON.stringify(state.byId.get(item.id).photos));
        drawPhotos();
        afterDataChange();
      } catch (e) { toast(e.message, true); }
    }

    const seg = h('div', { class: 'seg' });
    function drawStatus() {
      seg.replaceChildren(...['available', 'sold', 'hidden'].map((s) =>
        h('button', { type: 'button', 'aria-pressed': item.status === s, onclick: () => { item.status = s; drawStatus(); } }, STATUS_LABEL[s])));
    }
    const saveBtn = h('button', { class: 'btn', type: 'button', onclick: save }, 'Сохранить');
    async function save() {
      if (!f.title.value.trim()) { toast('Укажите название', true); f.title.focus(); return; }
      saveBtn.disabled = true;
      try {
        await ensureCreated();
        await api.patchItem(item.id, values());
        haptic('ok');
        toast('Сохранено. На сайте обновится через 1–2 минуты');
        afterDataChange();
        goBack();
      } catch (e) { toast(e.message, true); haptic('error'); }
      saveBtn.disabled = false;
    }
    async function remove() {
      if (!(await confirmBox(`Удалить «${item.title || 'вещь'}» из каталога насовсем? Пост в канале останется.`))) return;
      try {
        if (item.id) {
          await api.deleteItem(item.id);
        }
        toast('Удалено');
        afterDataChange();
        goBack();
      } catch (e) { toast(e.message, true); }
    }

    drawPhotos();
    drawStatus();
    const field = (label, control, hint) => h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('div', { class: 'field-hint' }, hint) : null);
    root.replaceChildren(h('div', { class: 'sheet-inner form' },
      backBtn(),
      h('h1', {}, isNew ? 'Новая вещь' : 'Редактирование'),
      photosBox,
      h('div', { class: 'field' }, h('span', {}, 'Статус'), seg),
      field('Название', f.title),
      field('Цена, ₽', f.price),
      h('label', { class: 'check' }, f.priceFrom, 'Показывать как «от …» (несколько вариантов)'),
      field('Категория', f.category),
      field('Размер', f.size, 'Пишите как в посте — фильтр по размерам соберётся сам.'),
      field('Состояние', f.condition),
      field('Описание', f.description),
      src && src.msgId ? h('p', { class: 'field-hint' }, src.manual
        ? 'Текст этой вещи правили вручную, поэтому правки поста в канале его не изменят. Хэштеги #ВНАЛИЧИИ и #ПРОДАНО продолжают работать.'
        : 'Вещь связана с постом в канале: правки поста и хэштеги #ВНАЛИЧИИ / #ПРОДАНО подтягиваются сами, раз в 15–30 минут.') : null,
      isNew ? null : h('div', { class: 'form-foot' }, h('button', { class: 'btn btn-danger', type: 'button', onclick: remove }, 'Удалить вещь')),
      h('div', { class: 'item-bar' }, saveBtn)));
    root.scrollTop = 0;
  }

  function renderInfoEditor() {
    const root = $('editor');
    const text = h('textarea', { maxlength: 8000, style: 'min-height:320px' });
    text.value = state.info.text || '';
    const links = h('textarea', { maxlength: 4000, style: 'min-height:130px' });
    links.value = (state.info.links || []).map((l) => `${l.label} | ${l.url}`).join('\n');
    const saveBtn = h('button', { class: 'btn', type: 'button' }, 'Сохранить');
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const parsed = links.value.split('\n').map((l) => l.split('|')).filter((p) => p.length >= 2)
          .map((p) => ({ label: p[0].trim(), url: p.slice(1).join('|').trim() }));
        await api.saveInfo({ text: text.value.replace(/\r/g, '').trim(), links: parsed.filter((l) => l.label && /^https?:\/\//i.test(l.url)) });
        renderInfo();
        toast('Сохранено');
        goBack();
      } catch (e) { toast(e.message, true); }
      saveBtn.disabled = false;
    });
    root.replaceChildren(h('div', { class: 'sheet-inner form' },
      backBtn(),
      h('h1', {}, 'Вкладка «Инфо»'),
      h('label', { class: 'field' }, h('span', {}, 'Текст'), text,
        h('div', { class: 'field-hint' }, 'Первая строка — крупный вводный текст. Строка, которая начинается с #, станет заголовком. Ссылки и @имена станут кликабельными.')),
      h('label', { class: 'field' }, h('span', {}, 'Кнопки-ссылки'), links,
        h('div', { class: 'field-hint' }, 'По одной на строку: Название | https://ссылка')),
      h('div', { class: 'item-bar' }, saveBtn)));
    root.scrollTop = 0;
  }

  function afterDataChange() {
    state.items.forEach((i) => { delete i._hay; });
    renderCatalog();
    refreshFavUi();
    refreshCartUi();
    if (state.admin) renderAdmin();
  }

  // ---------- навигация ----------
  state.depth = 0;
  function route() {
    const hash = location.hash.replace(/^#/, '');
    const [name, arg] = hash.split('/');
    const isSheet = name === 'filters' || name === 'sizes';
    const overlay = name === 'item' ? 'item' : isSheet ? 'filters'
      : name === 'owner' && !state.admin && !DEMO ? 'editor' : (name === 'edit' || name === 'editinfo') && state.admin ? 'editor' : null;
    $('item').hidden = overlay !== 'item';
    $('editor').hidden = overlay !== 'editor';
    $('filters-sheet').hidden = name !== 'filters';
    $('sizes-sheet').hidden = name !== 'sizes';
    document.body.style.overflow = overlay ? 'hidden' : '';
    $('tabbar').hidden = !!overlay;
    if (inTg && tg.BackButton) { if (overlay) tg.BackButton.show(); else tg.BackButton.hide(); }

    if (overlay === 'filters') return; // содержимое шторок уже отрисовано в renderFilters()
    if (overlay === 'item') return renderItem(arg);
    if (overlay === 'editor') return name === 'owner' ? renderOwnerLogin() : name === 'editinfo' ? renderInfoEditor() : renderEditor(arg);

    state.depth = 0;
    const tab = ['fav', 'cart', 'info'].includes(name) ? name : name === 'admin' && state.admin ? 'admin' : 'catalog';
    if (tab !== state.tab) {
      state.scroll[state.tab] = window.scrollY;
      state.tab = tab;
      ['catalog', 'fav', 'cart', 'info', 'admin'].forEach((t) => { $('view-' + t).hidden = t !== tab; });
      if (tab === 'fav') renderFav();
      if (tab === 'cart') renderCart();
      window.scrollTo(0, state.scroll[tab] || 0);
    }
    document.querySelectorAll('#tabbar a').forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  function bind() {
    window.addEventListener('hashchange', route);
    // вкладки не копят историю, а карточки и формы — копят, чтобы «Назад» их закрывал
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      if (a.hasAttribute('data-ext')) { if (inTg) { e.preventDefault(); openLink(a.href); } return; }
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('#')) return;
      e.preventDefault();
      const isOverlay = /^#(item|edit|owner)/.test(href);
      const onOverlay = /^#(item|edit|owner)/.test(location.hash);
      if (isOverlay && !onOverlay) { state.depth++; location.hash = href; }
      else { history.replaceState(null, '', href || location.pathname + location.search); if (!isOverlay) state.depth = 0; route(); }
      if (a.dataset.tab && a.dataset.tab === state.tab && !isOverlay) window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    if (inTg && tg.BackButton) tg.BackButton.onClick(goBack);

    // плашки и шторки фильтров
    $('open-filters').addEventListener('click', () => openSheet('filters'));
    $('open-sizes').addEventListener('click', () => openSheet('sizes'));
    $('close-filters').addEventListener('click', closeSheets);
    $('done-filters').addEventListener('click', closeSheets);
    $('close-sizes').addEventListener('click', closeSheets);
    $('back-filters').addEventListener('click', backToFilters);
    $('done-sizes').addEventListener('click', backToFilters);
    $('reset-sheet').addEventListener('click', resetFilterSheet);
    $('reset-sizes').addEventListener('click', () => { state.sizes.clear(); renderCatalog(); });
    $('cart-send').addEventListener('click', () => openLink(sellerUrl(cartText())));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && /^#(filters|sizes)/.test(location.hash)) goBack();
    });

    const q = $('q');
    let t;
    q.addEventListener('input', () => {
      $('q-clear').hidden = !q.value;
      clearTimeout(t);
      t = setTimeout(() => { state.q = q.value.trim(); renderCatalog(); }, 120);
    });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') q.blur(); });
    $('q-clear').addEventListener('click', () => { q.value = ''; state.q = ''; $('q-clear').hidden = true; renderCatalog(); q.focus(); });
    $('sort').addEventListener('change', (e) => { state.sort = e.target.value; renderCatalog(); });
    $('reset').addEventListener('click', resetFilters);
    $('empty-reset').addEventListener('click', resetFilters);
  }

  async function boot() {
    document.body.classList.toggle('in-tg', inTg);
    if (tg) {
      try {
        tg.ready();
        tg.expand();
        // шапка и фон Telegram — в цвет приложения
        if (tgAtLeast('6.1')) { tg.setHeaderColor('#050507'); tg.setBackgroundColor('#050507'); }
        if (tgAtLeast('7.10') && tg.setBottomBarColor) tg.setBottomBarColor('#0a0b0f');
        if (tgAtLeast('7.7') && tg.disableVerticalSwipes) tg.disableVerticalSwipes(); // чтобы листание галереи не сворачивало окно
      } catch (e) { /* вне Telegram */ }
    }
    bind();
    let data;
    try {
      data = DEMO || await (await fetch('data/catalog.json?v=' + Math.floor(Date.now() / 60000), { cache: 'no-store' })).json();
    } catch (e) {
      $('boot').textContent = 'Не удалось загрузить каталог. Проверьте интернет и откройте приложение ещё раз.';
      return;
    }
    applyCatalog(data);
    if (!DEMO) {
      const token = await storedToken();
      if (token) { try { await signIn(token); } catch (e) { if (e.status === 401) storeToken(''); } }
    }
    document.querySelector('#tabbar [data-tab="admin"]').hidden = !state.admin;

    loadFav();
    loadCart();
    renderCatalog();
    renderInfo();
    if (state.admin) renderAdmin();
    refreshFavUi();
    refreshCartUi();

    // ссылка вида t.me/бот?startapp=item_123 сразу открывает вещь
    const start = (inTg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || new URLSearchParams(location.search).get('tgWebAppStartParam') || '';
    const m = start.match(/^item_(\w+)$/);
    if (m && !/^#item/.test(location.hash)) history.replaceState(null, '', '#item/' + m[1]);
    route();
    $('boot').hidden = true;
  }

  // если что-то пошло не так, не оставляем посетителя на вечной заставке: показываем причину и кнопку обновления
  function bootError() {
    const el = $('boot');
    el.hidden = false;
    el.replaceChildren(h('div', { class: 'boot-err' },
      h('p', { class: 'boot-title' }, 'Не удалось открыть каталог'),
      h('p', {}, 'Скорее всего в браузере осталась старая версия приложения. Обновите страницу.'),
      h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Обновить')));
  }
  boot().catch((e) => { console.error('Каталог не запустился:', e); bootError(); });
})();
