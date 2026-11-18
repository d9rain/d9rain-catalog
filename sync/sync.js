'use strict';
// Запускается планировщиком GitHub (см. .github/workflows/sync.yml) раз в 15 минут.
// Забирает у бота новые посты канала и их правки, обновляет data/catalog.json и скачивает фото.
const fs = require('fs');
const path = require('path');
const { parseCaption, statusFromText, cleanDescription } = require('./parse');

const ROOT = path.join(__dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'catalog.json');
const STATE = path.join(ROOT, 'data', 'state.json');
const TOKEN = process.env.BOT_TOKEN || '';
const BASE = (process.env.TG_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(/[,\s]+/).filter(Boolean);
const CHANNEL_ID = process.env.CHANNEL_ID || '-1002420564843';
const REPO = process.env.GITHUB_REPOSITORY || ''; // owner/name
const TEXT_FIELDS = ['title', 'category', 'size', 'sizes', 'condition', 'price', 'priceFrom', 'description', 'tags'];
const now = () => Math.floor(Date.now() / 1000);
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const log = (...a) => console.log(...a);

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const state = Object.assign({ offset: 0, albums: {}, albumOrder: [] }, fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {});
const before = JSON.stringify(catalog);

async function api(method, params) {
  const res = await fetch(`${BASE}/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}), signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data.result;
}
async function download(fileId, dest) {
  const file = await api('getFile', { file_id: fileId });
  const res = await fetch(`${BASE}/file/bot${TOKEN}/${file.file_path}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('download ' + res.status);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}
const notes = [];
const notify = (text) => notes.push(text);

function isOurChannel(chat) {
  if (!chat) return false;
  if (String(chat.id) === String(CHANNEL_ID)) return true;
  const u = (catalog.config.channel || '').toLowerCase();
  return !!(u && chat.username && chat.username.toLowerCase() === u);
}
const albumKey = (msg) => (msg.media_group_id ? 'g' + msg.media_group_id : 'm' + msg.message_id);

function rememberPhoto(msg) {
  if (!msg.photo || !msg.photo.length) return;
  const key = albumKey(msg);
  if (!state.albums[key]) {
    state.albums[key] = [];
    state.albumOrder.push(key);
    while (state.albumOrder.length > 400) delete state.albums[state.albumOrder.shift()];
  }
  const sizes = [...msg.photo].sort((a, b) => a.width * a.height - b.width * b.height);
  const full = sizes[sizes.length - 1];
  const thumb = sizes.find((s) => Math.max(s.width, s.height) >= 400) || full;
  const entry = { id: msg.message_id, full: full.file_id, thumb: thumb.file_id, w: full.width, h: full.height };
  const list = state.albums[key];
  const i = list.findIndex((p) => p.id === entry.id);
  if (i >= 0) list[i] = entry; else list.push(entry);
}

async function syncPhotos(item) {
  for (const p of state.albums[item.mgid] || []) {
    if (item.photos.some((x) => String(x.id) === String(p.id))) continue;
    if ((item.removedPhotos || []).includes(p.id)) continue;
    try {
      const rel = `items/${item.id}/${p.id}`;
      await download(p.full, path.join(ROOT, 'photos', rel + '.jpg'));
      let t = rel + '.jpg';
      if (p.thumb !== p.full) { await download(p.thumb, path.join(ROOT, 'photos', rel + '_t.jpg')); t = rel + '_t.jpg'; }
      item.photos.push({ id: p.id, f: rel + '.jpg', t, w: p.w, h: p.h });
      item.photos.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    } catch (e) { log(`не скачалось фото ${p.id} для «${item.title}»: ${e.message}`); }
  }
}

async function onChannelPost(msg, isEdit) {
  if (!isOurChannel(msg.chat)) return;
  if (msg.chat.username) catalog.config.channel = msg.chat.username;
  rememberPhoto(msg);
  const text = msg.caption || msg.text || '';
  const key = albumKey(msg);
  let item = catalog.items.find((i) => i.source === 'channel' && i.msgId === msg.message_id);

  if (item) {
    const tagStatus = statusFromText(text) || 'hidden';
    if (tagStatus !== item.tagStatus) {
      item.tagStatus = tagStatus;
      if (item.status !== tagStatus) {
        item.status = tagStatus;
        notify(tagStatus === 'available' ? `Вернул в продажу: ${item.title}` : `Снял с продажи: ${item.title}`);
      }
    }
    if (!item.manual) Object.assign(item, pick(parseCaption(text), TEXT_FIELDS));
    item.mgid = key;
    item.updated = now();
    await syncPhotos(item);
    return;
  }
  if (text && statusFromText(text) === 'available' && state.albums[key]) {
    item = Object.assign({
      id: String(msg.message_id), source: 'channel', msgId: msg.message_id, mgid: key,
      status: 'available', tagStatus: 'available', manual: false, photos: [], date: msg.date || now(), updated: now(),
    }, pick(parseCaption(text), TEXT_FIELDS));
    if (!item.title) item.title = 'Без названия';
    catalog.items.push(item);
    await syncPhotos(item);
    const price = item.price ? `, ${item.price.toLocaleString('ru-RU')} ₽` : '';
    const partial = isEdit && msg.media_group_id && item.photos.length < 2 ? '\nПодтянулось только первое фото — остальные можно добавить в «Управлении».' : '';
    notify(`Добавил в каталог: ${item.title}${price}${partial}`);
    return;
  }
  if (!text && msg.media_group_id) {
    item = catalog.items.find((i) => i.source === 'channel' && i.mgid === key);
    if (item) { await syncPhotos(item); item.updated = now(); }
  }
}

async function onPrivate(msg, url) {
  const text = (msg.text || '').trim();
  if (/^\/id\b/.test(text)) return api('sendMessage', { chat_id: msg.chat.id, text: `Ваш Telegram ID: ${msg.from.id}` });
  const params = { chat_id: msg.chat.id, text: 'Каталог вещей в наличии — по кнопке ниже.' };
  if (url) params.reply_markup = { inline_keyboard: [[{ text: 'Открыть каталог', web_app: { url } }]] };
  return api('sendMessage', params);
}

async function main() {
  if (!TOKEN) { log('BOT_TOKEN не задан — добавьте секрет BOT_TOKEN в настройках репозитория'); process.exit(1); }
  const [owner, name] = REPO.split('/');
  const userSite = owner && name && name.toLowerCase() === owner.toLowerCase() + '.github.io';
  const url = process.env.PAGES_URL || (owner ? `https://${owner.toLowerCase()}.github.io/${userSite ? '' : name + '/'}` : '');
  if (REPO) catalog.config.repo = REPO;

  const me = await api('getMe');
  catalog.config.bot = me.username;
  if (url && state.menuUrl !== url) {
    await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Каталог', web_app: { url } } });
    state.menuUrl = url;
    log('кнопка «Каталог» у бота настроена на', url);
  }
  // аватарка канала
  try {
    const chat = await api('getChat', { chat_id: CHANNEL_ID });
    if (chat.photo && chat.photo.big_file_id && (state.avatarId !== chat.photo.big_file_unique_id || !fs.existsSync(path.join(ROOT, 'avatar.jpg')))) {
      await download(chat.photo.big_file_id, path.join(ROOT, 'avatar.jpg'));
      state.avatarId = chat.photo.big_file_unique_id;
      log('аватарка канала обновлена');
    }
  } catch (e) { log('аватарка канала не загрузилась:', e.message, '(бот добавлен администратором в канал?)'); }

  let total = 0;
  for (let round = 0; round < 20; round++) {
    const updates = await api('getUpdates', { offset: state.offset || 0, timeout: 0, limit: 100, allowed_updates: ['message', 'channel_post', 'edited_channel_post'] });
    if (!updates.length) break;
    for (const u of updates) {
      try {
        if (u.channel_post) await onChannelPost(u.channel_post, false);
        else if (u.edited_channel_post) await onChannelPost(u.edited_channel_post, true);
        else if (u.message && u.message.chat && u.message.chat.type === 'private') await onPrivate(u.message, url);
      } catch (e) { log('ошибка обработки:', e.message); }
      state.offset = u.update_id + 1;
      total++;
    }
  }
  // раз в неделю обновляем отметку, чтобы GitHub не отключил планировщик из-за «неактивного» репозитория
  if (!state.beat || now() - state.beat > 7 * 86400) state.beat = now();

  // одноразовая (и безопасная при повторе) чистка: убираем из описаний служебные подписи,
  // которые раньше попадали в карточку вещи вместе с текстом поста
  for (const item of catalog.items) {
    if (!item.description) continue;
    const cleaned = cleanDescription(item.description);
    if (cleaned !== item.description) {
      item.description = cleaned;
      item.updated = now();
    }
  }

  if (JSON.stringify(catalog) !== before) fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 0));
  fs.writeFileSync(STATE, JSON.stringify(state));
  for (const text of notes) for (const id of ADMIN_IDS) await api('sendMessage', { chat_id: id, text }).catch(() => {});
  log(`готово: обработано событий ${total}, вещей в каталоге ${catalog.items.length}`);
}
main().catch((e) => { console.error('Сбой синхронизации:', e.message); process.exit(1); });
