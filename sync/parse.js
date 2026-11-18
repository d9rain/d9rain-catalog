(function () {
'use strict';
// Разбор подписи поста канала в карточку товара.
// Используется и при автоподгрузке новых постов, и при сохранении из админки.

const CATEGORY_RULES = [
  ['Лонгсливы', /^лонгслив/],
  ['Футболки', /^(футболк|майк|поло(?![а-яё])|джерси|хоккейн|топ(?![а-яё]))/],
  ['Худи и зипки', /^(худи|зип|свитшот|свитер|толстовк|кофт|олимпийк|кардиган)/],
  ['Верхняя одежда', /^(бомбер|куртк|пуховик|жилет|ветровк|пальто|анорак|парк[аи]|кожанк|джинсовк)/],
  ['Штаны', /^(джинс|штан|шорт|брюк|карго|треник)/],
  ['Обувь', /^(кроссовк|кед|сапог|ботин|тапк|сланц|туфл|лофер|шлеп|кроксы)/],
  ['Головные уборы', /^(кепк|шапк|балаклав|панам|бейсболк|бини|бандан)/],
  ['Аксессуары', /^(ремень|ремн|перчатк|брелок|браслет|маск|сумк|очки|кольц|цеп|кошел|рюкзак|шарф|носк|трус|боксер|набор трус|подвеск|часы)/],
];
const CATEGORIES = CATEGORY_RULES.map((r) => r[0]).concat('Другое');

function detectCategory(title) {
  const t = String(title || '').trim().toLowerCase();
  for (const [name, re] of CATEGORY_RULES) if (re.test(t)) return name;
  return 'Другое';
}

const LETTER_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'One Size'];
const US_TO_EU = { 6: '38.5', 6.5: '39', 7: '40', 7.5: '40.5', 8: '41', 8.5: '42', 9: '42.5', 9.5: '43', 10: '44', 10.5: '44.5', 11: '45', 11.5: '45.5', 12: '46', 12.5: '47', 13: '47.5', 14: '48.5' };

// "L", "2хл", "S M L", "12us 46eu", "O/S" -> ['L'], ['2XL'], ['S','M','L'], ['EU 46'], ['One Size']
function normalizeSizes(raw, category) {
  const src = String(raw || '');
  if (!src.trim()) return [];
  const out = [];
  const add = (s) => { if (!out.includes(s)) out.push(s); };
  if (/o\s*\/\s*s(?![a-z])|one\s*size|onesize|регулир|универсал|единый/i.test(src)) add('One Size');

  if (category === 'Обувь') {
    const eu = src.match(/(\d{2}(?:[.,]5)?)\s*eu/i);
    const us = src.match(/(\d{1,2}(?:[.,]5)?)\s*us/i);
    const plain = src.match(/(?<![\d.,])(3[5-9]|4[0-9])(?:[.,]5)?(?![\d])/);
    if (eu) add('EU ' + eu[1].replace(',', '.'));
    else if (us && US_TO_EU[parseFloat(us[1].replace(',', '.'))]) add('EU ' + US_TO_EU[parseFloat(us[1].replace(',', '.'))]);
    else if (plain) add('EU ' + plain[0].replace(',', '.'));
    return out;
  }

  // всё после запятой, «факт …», «но …» — это пояснения, а не размер
  const head = src.split(/,|факт|подойд|(?<![а-яё])но(?![а-яё])/i)[0];
  const hat = head.match(/(?<!\d)([67])\s+([1357])\/([248])(?!\d)/);
  if (hat) add(`${hat[1]} ${hat[2]}/${hat[3]}`);
  const re = /(?<![a-zа-яё0-9])(?:([2-5])\s*[xх][lл]|([xх]{1,4})[lл]|([xх]{1,2})[sс]|([sml]))(?![a-zа-яё0-9/]|\s*\/\s*[248])/gi;
  if (!hat) {
    let m;
    const h = head.replace(/o\s*\/\s*s(?![a-z])|one\s*size|onesize/gi, ' ').replace(/\//g, ' ').replace(/-/g, ' ');
    while ((m = re.exec(h))) {
      if (m[1]) add(m[1] + 'XL');
      else if (m[2]) add(m[2].length === 1 ? 'XL' : m[2].length + 'XL');
      else if (m[3]) add(m[3].length === 1 ? 'XS' : 'XXS');
      else add(m[4].toUpperCase());
    }
  }
  if (!out.length && category === 'Штаны') {
    const w = head.match(/(?<![\d.,])(2[4-9]|3[0-9]|4[0-4])(?![\d])/);
    if (w) add('W' + w[1]);
  }
  return out;
}

function sizeRank(s) {
  const i = LETTER_ORDER.indexOf(s);
  if (i >= 0) return i;
  if (s.startsWith('W')) return 100 + parseFloat(s.slice(1));
  if (s.startsWith('EU ')) return 200 + parseFloat(s.slice(3));
  return 400;
}

function parseNumber(s) {
  const m = String(s).match(/(\d{1,3}(?:[.\s ]\d{3})+|\d+)/);
  return m ? parseInt(m[1].replace(/\D/g, ''), 10) : null;
}

function parsePrice(text) {
  const line = text.match(/^[^\S\n]*цена[^\S\n]*:?[^\S\n]*([^\n]*)$/im);
  if (line) {
    const n = parseNumber(line[1]);
    if (n) return { price: n, priceFrom: false };
  }
  const all = [...text.matchAll(/(\d{1,3}(?:[.\s ]\d{3})+|\d+)\s*(?:₽|руб|р(?![а-яё])|Р(?![а-яёА-ЯЁ]))/g)]
    .map((m) => parseInt(m[1].replace(/\D/g, ''), 10)).filter((n) => n >= 50);
  if (all.length) return { price: Math.min(...all), priceFrom: all.length > 1 };
  return { price: null, priceFrom: false };
}

function hashtags(text) {
  return [...String(text || '').matchAll(/#[\p{L}\p{N}_]+/gu)].map((m) => m[0]);
}

// 'available' — #ВНАЛИЧИИ, 'sold' — #ПРОДАНО, null — ни то ни другое
function statusFromText(text) {
  const tags = hashtags(text).map((t) => t.toLowerCase());
  if (tags.some((t) => /^#продан/.test(t))) return 'sold';
  if (tags.includes('#вналичии')) return 'available';
  return null;
}

const STATUS_TAGS = /^#(вналичии|продан[а-яё]*|едут|подзаказ|выкуп|инфо)$/i;

// Служебные строки, которые добавляются в каждый пост (подпись бота, призывы писать).
// В описании вещи они не нужны — иначе покупатель видит их в карточке.
const SERVICE_LINES = [
  /удобн\p{L}*\s+бот/iu,
  /бот\s+для\s+поиска/iu,
  /поиска\s+вещей\s+в\s+наличии/iu,
  /t\.me\/d9rainbot/i,
  /@d9rainbot/i,
  /по\s+всем\s+вопросам/iu,
];
const isServiceLine = (line) => SERVICE_LINES.some((re) => re.test(String(line || '')));

// Чистит готовое описание от служебных строк: нужно и для вещей, сохранённых раньше.
function cleanDescription(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => !isServiceLine(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanTitle(line) {
  return String(line || '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*оригинал\s*$/i, '')
    .replace(/[\s.!📩❗️]+$/u, '')
    .trim();
}

function parseCaption(caption) {
  const text = String(caption || '').replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.replace(/[^\S\n]+/g, ' ').trim());
  const titleIdx = lines.findIndex((l) => l && !/^#/.test(l));
  const title = cleanTitle(titleIdx >= 0 ? lines[titleIdx] : '');
  const category = detectCategory(title);

  let size = '';
  let condition = '';
  const rest = [];
  lines.forEach((l, i) => {
    if (i === titleIdx) return;
    let m;
    if (!size && (m = l.match(/^размер(?:ы)?\s*:?\s*(.+)$/i)) && !/^и\s/i.test(m[1])) { size = m[1].replace(/\s+,/g, ',').trim(); return; }
    if (!condition && (m = l.match(/^состояние\s*:?\s*(.+)$/i))) { condition = m[1].replace(/\s+,/g, ',').trim(); return; }
    if (/^цена\s*:?\s*[\d\s. ]+\s*(₽|р|руб)?\.?\s*$/i.test(l)) return; // чистая строка цены уходит в поле
    if (isServiceLine(l)) return;
    if (l && l.split(' ').every((w) => /^#/.test(w))) return; // строка из одних хэштегов
    rest.push(l.replace(/\s+,/g, ','));
  });
  const description = cleanDescription(rest.join('\n'));
  const { price, priceFrom } = parsePrice(text);
  const tags = hashtags(text).filter((t) => !STATUS_TAGS.test(t));
  return {
    title, category, size, sizes: normalizeSizes(size, category), condition,
    price, priceFrom, description, tags, status: statusFromText(text),
  };
}

const api = { parseCaption, normalizeSizes, detectCategory, statusFromText, sizeRank, hashtags, CATEGORIES, cleanDescription, isServiceLine };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else window.D9Parse = api;
})();
