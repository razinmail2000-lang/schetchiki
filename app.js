'use strict';
/* Сбор счётчиков — веб-приложение для монтажника.
   Данные хранятся в localStorage телефона; выгрузка — Excel (ExcelJS) в формате «Таблица счётчиков». */

const APP_VER = '1.4.0';
const RES = ['Тепло', 'ГВС', 'ХВС'];
const TABLE_NO = { 'Тепло': 1, 'ГВС': 2, 'ХВС': 3 };
const KEY = 'meters.v1';
const $ = id => document.getElementById(id);
const abs = p => new URL(p, location.href).href;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEF = {
  addr: '', worker: '',
  blds: ['Дом'], // подсказки для поля «Строение» (адрес / ЖК); секция выбирается отдельно
  types: ['Квартира', 'Офис', 'Ресторан', 'Фитнес', 'Мед.кабинет', 'МОП', 'ПУИ', 'С/У', 'Душевая'],
  masks: { 'Тепло': '########', 'ГВС': '##_#######?', 'ХВС': '##_#######?' },
  pad: 3, sort: 'num', scanMode: 'auto',
  bldAddr: {}, // строение → адрес для строки 1 Excel (из загруженного файла)
  recs: [], channels: [], ord: 0,
  cur: { res: 'Тепло', bld: 'Дом-Секция 1', type: 'Квартира', name: '001' },
};

let S = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const st = Object.assign({}, DEF, s, { masks: Object.assign({}, DEF.masks, s.masks), cur: Object.assign({}, DEF.cur, s.cur) });
      for (const r of ['ГВС', 'ХВС']) if (st.masks[r] === '##_########') st.masks[r] = DEF.masks[r]; // Пульсар: после года 7 или 8 цифр
      st.blds = [...new Set((st.blds || []).map(b => splitBld(b).name).filter(Boolean))]; // старый формат «Дом-Секция 1» → «Дом»
      return st;
    }
  } catch (e) { console.warn(e); }
  return JSON.parse(JSON.stringify(DEF));
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast('Не удалось сохранить на телефоне: ' + e.message, 4000); }
  renderHeader();
}

/* ---------------- утилиты ---------------- */
function toast(t, ms = 2000) {
  const el = $('toast'); el.classList.remove('act'); el.textContent = t; el.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('on'), ms);
}
/* уведомление с кнопкой «Отменить» */
function toastUndo(t, undo, ms = 6000) {
  const el = $('toast');
  el.innerHTML = `<span>${esc(t)}</span><button type="button">Отменить</button>`;
  el.classList.add('on', 'act');
  el.querySelector('button').onclick = () => { el.classList.remove('on', 'act'); clearTimeout(toast._t); undo(); };
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('on', 'act'), ms);
}
function beep() {
  try {
    navigator.vibrate && navigator.vibrate(80);
    const ac = beep.ac || (beep.ac = new (window.AudioContext || window.webkitAudioContext)());
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 1500; g.gain.value = 0.15;
    o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.09);
  } catch (e) { }
}
function ask(title, html, yes = 'Да', no = 'Отмена') {
  return new Promise(res => {
    const d = $('dlgConfirm');
    $('cTitle').textContent = title; $('cText').innerHTML = html;
    $('cYes').textContent = yes; $('cNo').textContent = no;
    d.returnValue = '';
    d.addEventListener('close', () => res(d.returnValue === 'yes'), { once: true });
    d.showModal();
  });
}
const natCmp = (a, b) => String(a).localeCompare(String(b), 'ru', { numeric: true });
function padName(s) {
  s = String(s ?? '').trim();
  return (/^\d+$/.test(s) && S.pad > 0) ? s.padStart(S.pad, '0') : s;
}
const maskOf = res => (S.masks[res] || '').trim();
/* Маска номера: # — обязательная цифра, ? — необязательная цифра (номера разной длины),
   остальные символы ставятся как есть. «##_#######?»: 20_3969714 и 24_13989086. */
const maskReq = m => (m.match(/#/g) || []).length;
const maskOpt = m => (m.match(/\?/g) || []).length;
const fitsLen = (d, m) => d.length >= maskReq(m) && d.length <= maskReq(m) + maskOpt(m);
const reEsc = c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const maskHint = m => m.replace(/#/g, '0').replace(/\?/g, '(0)');
function maskRe(m) {
  if (!m) return null;
  return new RegExp('^' + m.split('').map(c => c === '#' ? '\\d' : c === '?' ? '\\d?' : reEsc(c)).join('') + '$');
}
/* для поиска в распознанном тексте: разделители маски могут быть прочитаны как _ - . пробел или пропущены */
function looseRe(m) {
  return new RegExp('(?<!\\d)' + m.split('').map(c => c === '#' ? '\\d' : c === '?' ? '\\d?' : '[ _\\-.:/]?').join('') + '(?!\\d)', 'g');
}
function applyMask(digits, m) {
  if (!m || !fitsLen(digits, m)) return digits;
  let i = 0, extra = digits.length - maskReq(m), out = '';
  for (const c of m) {
    if (c === '#') out += digits[i++];
    else if (c === '?') { if (extra > 0) { out += digits[i++]; extra--; } }
    else out += c;
  }
  return out;
}
function fitsMask(num, res) { const re = maskRe(maskOf(res)); return !re || re.test(num); }
/* приводим ручной ввод к маске: «24-13989086» / «24 1398 9086» → «24_13989086» */
function normalizeNum(v, res) {
  v = String(v ?? '').trim().replace(/\s+/g, '');
  if (!v) return '';
  const m = maskOf(res);
  if (m && !fitsMask(v, res)) {
    const d = v.replace(/\D/g, '');
    if (fitsLen(d, m) && /^[\d\-_.\/]+$/.test(v)) return applyMask(d, m);
  }
  return v;
}
/* показания с дисплея (00000346) и прочие числа с ведущими нулями номером не считаем */
const looksLikeReading = d => /^000/.test(d);
/* поиск номеров в распознанном тексте */
function extractNums(text, res) {
  const m = maskOf(res);
  text = String(text);
  const groups = [], hits = [];
  for (const line of text.split(/\n+/)) {
    for (const g of (line.match(/\d(?:[ \-_.]?\d)*/g) || [])) {
      const d = g.replace(/\D/g, '');
      if (d.length >= 4) groups.push(d);
    }
    if (m) for (const mm of line.matchAll(looseRe(m))) {
      const d = mm[0].replace(/\D/g, '');
      if (fitsLen(d, m) && !looksLikeReading(d)) hits.push(applyMask(d, m));
    }
  }
  const uniq = [...new Set(groups)];
  if (!hits.length) // запасной путь: цифры, разорванные пробелами
    for (const d of uniq) if ((m ? fitsLen(d, m) : d.length >= 6) && !looksLikeReading(d)) hits.push(applyMask(d, m));
  return { hits: [...new Set(hits)], all: uniq };
}
const placeKey = r => [r.res, r.bld, r.type, r.name].join('|');
const placeLabel = r => `${r.type && r.type !== 'Квартира' ? r.type + ' ' : 'кв. '}${r.name}`;

function sortRecs(arr) {
  if (S.sort === 'entry') return arr.slice().sort((a, b) => a.ord - b.ord);
  const sp = new Map(arr.map(r => [r, splitBld(r.bld)]));
  const sn = r => { const s = sp.get(r).sec; return s ? +s : 9999; }; // общие помещения без секции — в конце строения
  const tp = r => r.type === 'Квартира' ? 0 : 1;
  return arr.slice().sort((a, b) => natCmp(sp.get(a).name, sp.get(b).name) || sn(a) - sn(b) || tp(a) - tp(b) || natCmp(a.type, b.type) || natCmp(a.name, b.name) || a.ord - b.ord);
}
function dupMap() {
  const m = new Map();
  for (const r of S.recs) if (r.num) m.set(r.num, (m.get(r.num) || 0) + 1);
  return m;
}
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* ---------------- ФОТО счётчиков (IndexedDB, ключ = id записи) ---------------- */
const PDB = {
  db: null,
  open() {
    return this.db || (this.db = new Promise((res, rej) => {
      const r = indexedDB.open('meterPhotos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('p');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('p', mode), rq = fn(t.objectStore('p'));
      t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  put(id, blob) { return this.tx('readwrite', s => s.put(blob, id)); },
  get(id) { return this.tx('readonly', s => s.get(id)); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); },
  clear() { return this.tx('readwrite', s => s.clear()); },
};
/* «говорящее» имя файла: ХВС_Дом-Секция-1_кв012_24_13989086 */
function photoBase(r) {
  const clean = s => String(s || '').replace(/[\\/:*?"<>|№,;]+/g, '-').trim().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const place = (!r.type || r.type === 'Квартира') ? 'кв' + clean(r.name) : clean(r.type) + (r.name ? '_' + clean(r.name) : '');
  return [r.res, clean(r.bld), place, clean(r.num) || 'без-номера'].filter(Boolean).join('_');
}
async function toJpeg(src, w, h, max = 1600, q = 0.8) {
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', q));
}
/* подпись на самом фото — привязка сохранится, даже если файл переименуют */
async function stampPhoto(blob, r) {
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const fs = Math.max(16, Math.round(c.width / 38));
    const d = new Date(r.ts || Date.now());
    const lines = [`${r.res} · ${r.bld} · ${placeLabel(r)}`, `№ ${r.num || '—'} · ${d.toLocaleString('ru-RU')}${S.worker ? ' · ' + S.worker : ''}`];
    const ad = sheetAddr(bldNameOf(r));
    if (ad && ad !== bldNameOf(r)) lines.unshift(ad);
    const h = Math.round(fs * 1.35 * lines.length + fs * 0.6);
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, c.height - h, c.width, h);
    g.fillStyle = '#fff'; g.font = `600 ${fs}px system-ui, sans-serif`; g.textBaseline = 'top';
    lines.forEach((t, i) => g.fillText(t, Math.round(fs * 0.5), c.height - h + Math.round(fs * 0.3) + i * Math.round(fs * 1.35), c.width - fs));
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
  } catch (e) { console.warn(e); return blob; }
}
let pending = null; // фото, снятое до сохранения записи
function setPending(blob) {
  if (pending && pending.url) URL.revokeObjectURL(pending.url);
  pending = blob ? { blob, url: URL.createObjectURL(blob) } : null;
  renderPending();
}
function renderPending() {
  const box = $('photoBox');
  if (!pending) { box.innerHTML = ''; return; }
  const p = Object.assign(curPlace(), { num: normalizeNum($('inNum').value, S.cur.res) });
  box.innerHTML = `<img src="${pending.url}" data-view="1" alt="Фото"><div class="pn"><span class="muted">Фото сохранится как</span><br>${esc(photoBase(p))}.jpg</div><button type="button" id="photoDrop">✕</button>`;
}
function viewPhoto(url) { $('photoViewImg').src = url; $('photoView').classList.add('on'); }

/* ---------------- шапка / вкладки ---------------- */
function renderHeader() {
  // шапка — по текущему строению (адрес / ЖК): у каждого строения свой Excel
  const b = splitBld(S.cur.bld).name, nb = buildingNames().length;
  $('hdrTitle').textContent = sheetAddr(b) || 'Сбор счётчиков';
  const mine = S.recs.filter(r => bldNameOf(r) === b);
  const parts = RES.map(res => {
    const all = mine.filter(r => r.res === res);
    if (!all.length) return null;
    return `${res} ${all.filter(r => r.num).length}/${all.length}`;
  }).filter(Boolean);
  $('hdrSub').textContent = (parts.length ? parts.join(' · ') : 'в этом строении записей нет') + (nb > 1 ? ` · строений: ${nb}` : '');
}
let curView = 'input';
function showView(v) {
  curView = v;
  document.querySelectorAll('.view').forEach(e => e.classList.toggle('on', e.id === 'v-' + v));
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  if (v === 'list') renderList();
  if (v === 'file') renderFile();
  if (v === 'input') renderInput();
  window.scrollTo(0, 0);
}

/* ---------------- ВВОД ---------------- */
function fillSelect(sel, items, val, extra) {
  sel.innerHTML = (extra || '') + items.map(i => `<option${i === val ? ' selected' : ''}>${esc(i)}</option>`).join('');
  if (val != null && !items.includes(val) && !extra) { sel.insertAdjacentHTML('beforeend', `<option selected>${esc(val)}</option>`); }
}
/* «Строение» в таблице = строение/ЖК, введённое вручную + «-Секция N» */
const SEC_MAX = 50;
function glueBld(name, sec) {
  name = String(name || '').trim(); sec = String(sec || '').trim();
  if (!sec) return name;
  return name ? `${name}-Секция ${sec}` : `Секция ${sec}`;
}
function splitBld(b) {
  const m = String(b || '').match(/^(.*?)[\s\-–—,]*Секция\s*(\d+)\s*$/i);
  return m ? { name: m[1].trim(), sec: String(parseInt(m[2], 10)) } : { name: String(b || '').trim(), sec: '' };
}
const SEC_OPTS = '<option value="">без секции</option>' + Array.from({ length: SEC_MAX }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
function fillSec(sel, sec) {
  sel.innerHTML = SEC_OPTS;
  if (sec && +sec > SEC_MAX) sel.insertAdjacentHTML('beforeend', `<option value="${esc(sec)}">${esc(sec)}</option>`);
  sel.value = sec || '';
}
function fillBldList() {
  const names = [...new Set([...S.blds, ...S.recs.map(r => splitBld(r.bld).name)].filter(Boolean))];
  $('bldList').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
}
function setBldFields(bld) {
  const s = splitBld(bld);
  $('inBld').value = s.name; fillSec($('inSec'), s.sec);
  updBldPreview();
}
function updBldPreview() {
  const g = glueBld($('inBld').value, $('inSec').value);
  $('bldPreview').textContent = g ? `В столбец «Строение»: ${g}` : 'Введите строение (адрес / ЖК) и/или выберите секцию';
}
function stepSec(d) {
  const v = parseInt($('inSec').value || '0', 10) + d;
  $('inSec').value = v < 1 ? '' : String(Math.min(SEC_MAX, v));
  onBldChanged();
}
function onBldChanged() {
  const n = $('inBld').value.trim();
  if (n && !S.blds.includes(n)) { S.blds.push(n); fillBldList(); }
  updBldPreview(); syncCur(); renderPlace();
}
function renderInput() {
  const c = S.cur;
  $('resSeg').innerHTML = RES.map(r => `<button data-r="${r}" class="${r === c.res ? 'on' : ''}">${r}</button>`).join('');
  fillBldList(); setBldFields(c.bld);
  $('typeList').innerHTML = S.types.map(t => `<option value="${esc(t)}">`).join('');
  $('inType').value = c.type;
  $('inName').value = c.name;
  $('inNum').placeholder = maskOf(c.res) ? 'формат ' + maskHint(maskOf(c.res)) : 'наведите камеру';
  renderPlace();
  renderRecent();
}
function curPlace() {
  return { res: S.cur.res, bld: glueBld($('inBld').value, $('inSec').value), type: $('inType').value.trim() || 'Квартира', name: padName($('inName').value) };
}
function syncCur() { Object.assign(S.cur, curPlace()); save(); }
function renderPlace() {
  const p = curPlace(), k = placeKey(p);
  const here = sortRecs(S.recs.filter(r => placeKey(r) === k));
  $('placeInfo').innerHTML = here.length
    ? `<span class="muted" style="align-self:center">${esc(p.res)}, ${esc(placeLabel(p))}:</span>` + here.map(r => `<span class="chip ${r.num ? '' : 'empty'}" data-id="${r.id}">${esc(r.num || 'пусто')}${r.photo ? ' 📷' : ''} ✎</span>`).join('')
    : `<span class="muted">${esc(p.res)}, ${esc(placeLabel(p))}: счётчиков ещё нет</span>`;
  const all = S.recs.filter(r => r.res === p.res);
  const empty = all.filter(r => !r.num).length;
  $('slotInfo').textContent = all.length ? `${p.res}: заполнено ${all.length - empty} из ${all.length}` : '';
  $('prevEmpty').disabled = $('nextEmpty').disabled = !empty;
  checkNumField();
}
function renderRecent() {
  const last = S.recs.filter(r => r.num && r.ts).sort((a, b) => b.ts - a.ts).slice(0, 6);
  $('recentTbl').querySelector('tbody').innerHTML = last.length
    ? last.map(r => `<tr data-id="${r.id}"><td>${esc(r.res)}</td><td>${esc(placeLabel(r))}</td><td class="muted">${esc(r.bld)}</td><td class="n">${esc(r.num)}</td></tr>`).join('')
    : '<tr><td class="muted">—</td></tr>';
}
function checkNumField() {
  const p = curPlace();
  const v = $('inNum').value.trim();
  const box = $('numMsg');
  if (!v) { box.innerHTML = ''; return; }
  const n = normalizeNum(v, p.res);
  const msgs = [];
  if (!fitsMask(n, p.res)) msgs.push(`<div class="msg warn">Не по формату ${esc(maskOf(p.res))}</div>`);
  const d = S.recs.find(r => r.num === n);
  if (d) msgs.push(`<div class="msg bad">Уже записан: ${esc(d.res)}, ${esc(placeLabel(d))}, ${esc(d.bld)}</div>`);
  box.innerHTML = msgs.join('');
}
function stepName(delta) {
  const v = $('inName').value.trim();
  if (/^\d+$/.test(v)) {
    $('inName').value = padName(String(Math.max(1, parseInt(v, 10) + delta)));
  } else if (!v) $('inName').value = padName('1');
  onNameChanged();
}
function onNameChanged() {
  const name = padName($('inName').value), type = $('inType').value.trim() || 'Квартира';
  // если это место уже встречалось (в любом ресурсе) — подставляем его строение
  const known = S.recs.find(r => r.name === name && r.type === type && r.res === S.cur.res) || S.recs.find(r => r.name === name && r.type === type);
  if (known && known.bld && known.bld !== glueBld($('inBld').value, $('inSec').value)) setBldFields(known.bld);
  syncCur(); renderPlace();
}
function gotoSlot(r) {
  S.cur = { res: r.res, bld: r.bld, type: r.type || 'Квартира', name: r.name };
  save(); renderInput();
}
function jumpEmpty(dir) {
  const p = curPlace();
  const list = sortRecs(S.recs.filter(r => r.res === p.res));
  const k = placeKey(p);
  let idx = list.findIndex(r => placeKey(r) === k);
  if (dir > 0 && idx >= 0) { while (idx + 1 < list.length && placeKey(list[idx + 1]) === k) idx++; }
  const n = list.length;
  for (let i = 1; i <= n; i++) {
    const j = idx < 0 ? (dir > 0 ? i - 1 : n - i) : (idx + dir * i + n * 2) % n;
    if (!list[j].num && placeKey(list[j]) !== k) return gotoSlot(list[j]);
  }
  const own = list.find(r => !r.num && placeKey(r) === k);
  if (own) return toast('Пустой счётчик есть только в этом месте');
  toast('Пустых нет — всё заполнено');
}
async function saveCurrent(advance) {
  const p = curPlace();
  if (!p.name) { toast('Укажите имя места'); $('inName').focus(); return; }
  const num = normalizeNum($('inNum').value, p.res);
  if (!num) { toast('Введите или отсканируйте номер'); return; }
  if (!fitsMask(num, p.res) && !await ask('Формат номера', `Номер <b>${esc(num)}</b> не соответствует формату <b>${esc(maskOf(p.res))}</b>. Всё равно сохранить?`, 'Сохранить')) return;
  const dup = S.recs.find(r => r.num === num);
  if (dup && !await ask('Повтор номера', `Номер <b>${esc(num)}</b> уже записан:<br>${esc(dup.res)}, ${esc(placeLabel(dup))}, ${esc(dup.bld)}.<br><br>Сохранить ещё раз?`, 'Сохранить повтор')) return;
  if (!S.types.includes(p.type)) S.types.push(p.type);
  const k = placeKey(p);
  const slot = sortRecs(S.recs.filter(r => placeKey(r) === k && !r.num))[0];
  const src = $('inNum').dataset.src || 'ручной';
  let rec = slot;
  const before = slot ? { num: slot.num, src: slot.src, ts: slot.ts, photo: slot.photo } : null;
  if (slot) {
    Object.assign(slot, { num, src, ts: Date.now() });
  } else {
    const same = S.recs.filter(r => placeKey(r) === k);
    const ord = same.length ? Math.max(...same.map(r => r.ord)) + 0.001 : ++S.ord;
    rec = { id: newId(), res: p.res, pos: '', type: p.type, name: p.name, bld: p.bld, num, src, ts: Date.now(), ord };
    S.recs.push(rec);
  }
  let photoMsg = '';
  if (pending) {
    try { await PDB.put(rec.id, await stampPhoto(pending.blob, rec)); rec.photo = 1; photoMsg = ' + фото'; }
    catch (e) { photoMsg = ' (фото НЕ сохранено: ' + e.message + ')'; }
    setPending(null);
  }
  Object.assign(S.cur, p);
  $('inNum').value = ''; delete $('inNum').dataset.src; $('numMsg').innerHTML = '';
  save();
  const savedId = rec.id;
  toastUndo(`Сохранено: ${placeLabel(p)} — ${num}${photoMsg}`, () => {
    const r = S.recs.find(x => x.id === savedId);
    if (!r) return;
    if (before) Object.assign(r, before); else S.recs = S.recs.filter(x => x.id !== savedId);
    if (r.photo && !(before && before.photo)) { delete r.photo; PDB.del(savedId).catch(() => { }); }
    S.cur = { res: p.res, bld: p.bld, type: p.type, name: p.name };
    save(); renderInput();
    $('inNum').value = num; checkNumField();
    toast('Запись отменена — можно пересканировать');
  });
  if (advance) {
    const hasEmpty = S.recs.some(r => r.res === p.res && !r.num);
    if (hasEmpty) {
      const leftHere = S.recs.some(r => placeKey(r) === k && !r.num);
      if (leftHere) { toast('В этом месте есть ещё пустой счётчик'); renderInput(); return; }
      jumpEmpty(1); return;
    }
    stepName(1);
  }
  renderInput();
}

/* ---------------- СПИСОК ---------------- */
function renderList() {
  const dm = dupMap();
  $('stats').innerHTML = RES.map(res => {
    const all = S.recs.filter(r => r.res === res);
    const f = all.filter(r => r.num).length;
    const d = all.filter(r => r.num && dm.get(r.num) > 1).length;
    return `<div class="stat"><span class="muted">${res}</span><b>${f}/${all.length}</b><span class="muted">${d ? 'повторов ' + d : '&nbsp;'}</span></div>`;
  }).join('');
  const fr = $('fRes'), fb = $('fBld');
  if (!fr.options.length) fillSelect(fr, RES, S.cur.res, '<option value="">Все ресурсы</option>');
  const bv = fb.value;
  const bl = [...new Set(S.recs.map(r => r.bld).filter(Boolean))];
  bl.sort((a, b) => { const x = splitBld(a), y = splitBld(b); return natCmp(x.name, y.name) || (+x.sec || 9999) - (+y.sec || 9999); });
  fillSelect(fb, bl, bv || '', '<option value="">Все строения</option>');
  fb.value = bv;
  const q = $('fText').value.trim().toLowerCase(), st = $('fState').value;
  let list = S.recs.filter(r => (!fr.value || r.res === fr.value) && (!fb.value || r.bld === fb.value));
  if (q) list = list.filter(r => (r.name + ' ' + r.type + ' ' + r.num).toLowerCase().includes(q));
  if (st === 'empty') list = list.filter(r => !r.num);
  if (st === 'dup') list = list.filter(r => r.num && dm.get(r.num) > 1);
  if (st === 'bad') list = list.filter(r => r.num && !fitsMask(r.num, r.res));
  list = fr.value ? sortRecs(list) : RES.flatMap(res => sortRecs(list.filter(r => r.res === res)));
  const LIM = 400;
  $('listTbl').querySelector('tbody').innerHTML = list.slice(0, LIM).map(r => {
    const cls = !r.num ? 'emp' : (dm.get(r.num) > 1 ? 'dup' : '');
    return `<tr data-id="${r.id}" class="${cls}"><td>${fr.value ? '' : `<span class="muted">${esc(r.res)}</span> `}${esc(placeLabel(r))}</td><td class="muted">${esc(r.bld)}</td><td class="n">${esc(r.num || 'пусто')}${r.num && !fitsMask(r.num, r.res) ? ' ⚠' : ''}${r.photo ? ' 📷' : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="3" class="muted">Нет записей</td></tr>';
  $('listMore').textContent = list.length > LIM ? `Показано ${LIM} из ${list.length} — уточните фильтр` : `${list.length} шт.`;
}
let editId = null;
function openEdit(id) {
  const r = S.recs.find(x => x.id === id); if (!r) return;
  editId = id;
  fillSelect($('eRes'), RES, r.res);
  fillBldList();
  const sb = splitBld(r.bld); $('eBld').value = sb.name; fillSec($('eSec'), sb.sec);
  $('eType').value = r.type; $('eName').value = r.name; $('eNum').value = r.num;
  $('eMeta').textContent = r.ts ? `Записан ${new Date(r.ts).toLocaleString('ru-RU')} · источник: ${r.src || '—'}` : (r.src === 'import' ? 'Из загруженного файла' : '');
  renderEditPhoto(r);
  editShot = null;
  const d = $('dlgEdit'); d.returnValue = ''; d.showModal();
  checkEditNum();
}
let editPhotoUrl = null;
async function renderEditPhoto(r) {
  const box = $('ePhoto'); box.innerHTML = '';
  if (editPhotoUrl) { URL.revokeObjectURL(editPhotoUrl); editPhotoUrl = null; }
  $('ePhotoBtn').textContent = r.photo ? 'Переснять фото' : 'Сфотографировать счётчик';
  if (!r.photo) return;
  const b = await PDB.get(r.id).catch(() => null);
  if (!b) { box.innerHTML = '<div class="pn muted">Фото не найдено на этом устройстве</div>'; return; }
  editPhotoUrl = URL.createObjectURL(b);
  box.innerHTML = `<img src="${editPhotoUrl}" data-view="1" alt="Фото"><div class="pn">${esc(photoBase(r))}.jpg</div>`;
}
async function editTakePhoto(file) {
  const r = S.recs.find(x => x.id === editId); if (!r) return;
  try {
    const bmp = await createImageBitmap(file);
    const blob = await stampPhoto(await toJpeg(bmp, bmp.width, bmp.height), r);
    await PDB.put(r.id, blob); r.photo = 1; save(); renderEditPhoto(r); toast('Фото сохранено');
  } catch (e) { toast('Фото не сохранено: ' + e.message, 4000); }
}
let editShot = null; // новый кадр после пересканирования из окна правки
function editDraft() {
  return { res: $('eRes').value, bld: glueBld($('eBld').value, $('eSec').value), type: $('eType').value, name: $('eName').value, num: $('eNum').value };
}
function checkEditNum() {
  const res = $('eRes').value, n = normalizeNum($('eNum').value, res), msgs = [];
  if (n && !fitsMask(n, res)) msgs.push(`<div class="msg warn">Не по формату ${esc(maskOf(res))}</div>`);
  const d = n && S.recs.find(x => x.num === n && x.id !== editId);
  if (d) msgs.push(`<div class="msg bad">Уже записан: ${esc(d.res)}, ${esc(placeLabel(d))}, ${esc(d.bld)}</div>`);
  $('eNumMsg').innerHTML = msgs.join('');
}
function rerender() { if (curView === 'list') renderList(); else renderInput(); }
/* удаление / очистка — сразу, с возможностью отменить */
async function removeRec(r, clearOnly) {
  const blob = r.photo ? await PDB.get(r.id).catch(() => null) : null;
  const snap = Object.assign({}, r), idx = S.recs.indexOf(r);
  if (clearOnly) { r.num = ''; r.src = ''; r.ts = 0; delete r.photo; }
  else S.recs.splice(idx, 1);
  if (snap.photo) PDB.del(r.id).catch(() => { });
  save(); rerender();
  toastUndo(`${clearOnly ? 'Номер очищен' : 'Удалено'}: ${snap.res}, ${placeLabel(snap)} ${snap.num || ''}`, async () => {
    if (clearOnly) Object.assign(S.recs.find(x => x.id === snap.id) || {}, snap);
    else S.recs.splice(Math.min(idx, S.recs.length), 0, snap);
    if (blob) await PDB.put(snap.id, blob).catch(() => { });
    save(); rerender(); toast('Восстановлено');
  });
}
async function closeEdit() {
  const d = $('dlgEdit'), r = S.recs.find(x => x.id === editId), rv = d.returnValue;
  if (!r) return;
  if (rv === 'rescan') return; // окно откроется снова после сканирования
  const shot = editShot; editShot = null;
  if (rv === 'del') {
    await removeRec(r, false); return;
  } else if (rv === 'clear') {
    await removeRec(r, true); return;
  } else if (rv === 'ok') {
    const res = $('eRes').value;
    const num = normalizeNum($('eNum').value, res);
    const dup = num && S.recs.find(x => x.num === num && x.id !== r.id);
    if (dup && !await ask('Повтор номера', `Номер <b>${esc(num)}</b> уже есть: ${esc(dup.res)}, ${esc(placeLabel(dup))}. Сохранить?`, 'Сохранить')) return;
    if (num !== r.num) { r.ts = Date.now(); r.src = 'правка'; }
    const bn = $('eBld').value.trim(); if (bn && !S.blds.includes(bn)) S.blds.push(bn);
    Object.assign(r, { res, bld: glueBld(bn, $('eSec').value), type: $('eType').value.trim() || 'Квартира', name: padName($('eName').value), num });
    if (shot) {
      const b = await shot.catch(() => null);
      if (b) { try { await PDB.put(r.id, await stampPhoto(b, r)); r.photo = 1; } catch (e) { toast('Фото не сохранено: ' + e.message, 4000); } }
    }
    save(); toast('Исправлено: ' + placeLabel(r) + ' — ' + (num || 'без номера'));
  }
  rerender();
}
function editRescan() {
  const draft = editDraft(), id = editId;
  const d = $('dlgEdit'); d.close('rescan');
  openScanner({ id, draft });
}
function reopenEdit(target, num, shot) {
  openEdit(target.id);
  const t = target.draft;
  const sb = splitBld(t.bld);
  $('eRes').value = t.res; $('eBld').value = sb.name; fillSec($('eSec'), sb.sec); $('eType').value = t.type; $('eName').value = t.name;
  $('eNum').value = num != null ? normalizeNum(num, t.res) : t.num;
  if (shot) editShot = shot;
  checkEditNum();
}

/* ---------------- ФАЙЛ / НАСТРОЙКИ ---------------- */
function renderFile() {
  $('sAddr').value = S.addr; $('sWorker').value = S.worker;
  $('maskBox').innerHTML = RES.map(r => `<label>${r}</label><input data-mask="${r}" value="${esc(S.masks[r] || '')}" spellcheck="false" autocapitalize="off">`).join('');
  $('sBlds').value = S.blds.join('\n'); $('sTypes').value = S.types.join('\n');
  $('sPad').value = String(S.pad); $('sSort').value = S.sort;
  renderExpBld();
  const ocr = localStorage.getItem('ocrReady');
  $('verInfo').textContent = `Версия ${APP_VER} · записей ${S.recs.length} · распознавание: ${ocr ? 'загружено, работает без интернета' : 'ещё не загружено'}`;
}
function readSettings() {
  S.addr = $('sAddr').value.trim(); S.worker = $('sWorker').value.trim();
  document.querySelectorAll('[data-mask]').forEach(i => S.masks[i.dataset.mask] = i.value.trim());
  const lines = v => [...new Set(v.split('\n').map(s => s.trim()).filter(Boolean))];
  S.blds = lines($('sBlds').value); if (!S.blds.length) S.blds = DEF.blds.slice();
  S.types = lines($('sTypes').value); if (!S.types.length) S.types = DEF.types.slice();
  S.pad = parseInt($('sPad').value, 10) || 0; S.sort = $('sSort').value;
  save();
}
const safeName = s => String(s || '').replace(/[\\/:*?"<>|№,]+/g, ' ').replace(/\s+/g, '_').replace(/^_|_$/g, '').slice(0, 50);
function fileName(bname) {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  const parts = ['Счетчики', bname || S.addr, `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`, S.worker]
    .filter(Boolean).map(safeName);
  return parts.join('_') + '.xlsx';
}
/* «Строение (адрес / ЖК)» без секции — по нему выгрузка делится на отдельные файлы */
const bldNameOf = r => splitBld(r.bld).name;
function buildingNames(recs = S.recs) {
  return [...new Set(recs.map(bldNameOf))].sort((a, b) => (a === '') - (b === '') || natCmp(a, b));
}
/* строка 1 таблицы: адрес из загруженного файла для этого строения, иначе само строение, иначе адрес по умолчанию */
const sheetAddr = bname => (S.bldAddr && S.bldAddr[bname]) || bname || S.addr || '';

const FONT = 'Times New Roman';
const THIN = { style: 'thin', color: { argb: 'FF000000' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const CENTER = { horizontal: 'center', vertical: 'middle', wrapText: true };
const WIDTHS = [9, 24, 12, 12, 24, 18];
const METER_HDR = ['№ поз.', 'Тип места', 'Имя места', 'Ресурс', 'Сетевой адрес', 'Строение'];
const CHAN_HDR = ['№ канала.', 'Тип места', 'Порт', 'Ресурс', 'Сетевой адрес', 'Строение'];

function setupSheet(wb, name, title, header, addr) {
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 3 }],
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, printTitlesRow: '3:3', margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 } },
  });
  ws.columns = WIDTHS.map(w => ({ width: w }));
  ws.mergeCells('A1:F1');
  Object.assign(ws.getCell('A1'), { value: addr || '', font: { name: FONT, size: 12, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
  ws.mergeCells('A2:F2');
  Object.assign(ws.getCell('A2'), { value: title, font: { name: FONT, size: 12, bold: true }, alignment: { horizontal: 'left', vertical: 'middle' } });
  const hr = ws.getRow(3); hr.height = 30;
  header.forEach((h, i) => Object.assign(hr.getCell(i + 1), {
    value: h, font: { name: FONT, size: 11, bold: true }, alignment: CENTER, border: BORDER,
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
  }));
  return ws;
}
function styleRow(ws, r, vals) {
  const row = ws.getRow(r);
  for (let c = 1; c <= 6; c++) {
    const cell = row.getCell(c);
    if (vals && vals[c - 1] != null) cell.value = String(vals[c - 1]);
    cell.font = { name: FONT, size: 11 }; cell.alignment = CENTER; cell.border = BORDER; cell.numFmt = '@';
  }
}
/* one Excel per building: recsAll — записи этого строения, bname — его имя */
async function buildWorkbook(recsAll = S.recs, bname = null) {
  const addr = bname == null ? S.addr : sheetAddr(bname);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Сбор счётчиков ' + APP_VER; wb.created = new Date();
  for (const res of RES) {
    const ws = setupSheet(wb, res, `Таблица ${TABLE_NO[res]} — ${res}`, METER_HDR, addr);
    const recs = sortRecs(recsAll.filter(x => x.res === res));
    const groups = [];
    for (const x of recs) {
      const g = groups[groups.length - 1];
      if (g && placeKey(g.items[0]) === placeKey(x)) g.items.push(x); else groups.push({ items: [x] });
    }
    const usePos = groups.length && groups.every(g => g.items[0].pos);
    let r = 4;
    groups.forEach((g, gi) => {
      const r0 = r;
      for (const x of g.items) { styleRow(ws, r, [null, null, x.name, x.res, x.num || '', x.bld]); r++; }
      ws.getCell(r0, 1).value = usePos ? String(g.items[0].pos) : String(gi + 1);
      ws.getCell(r0, 2).value = g.items[0].type;
      if (r - r0 > 1) { ws.mergeCells(r0, 1, r - 1, 1); ws.mergeCells(r0, 2, r - 1, 2); }
    });
  }
  const ws = setupSheet(wb, 'Каналы', 'Таблица 4 — Каналы УСПД', CHAN_HDR, addr);
  S.channels.forEach((ch, i) => styleRow(ws, 4 + i, ch));
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
/* фото записей recs → в папку dir архива, с говорящими именами */
async function addPhotos(dir, recs, used, progress, cnt) {
  for (const res of RES) {
    for (const r of sortRecs(recs.filter(x => x.res === res && x.photo))) {
      const b = await PDB.get(r.id).catch(() => null);
      if (!b) continue;
      let base = photoBase(r); const k = used.get(base) || 0; used.set(base, k + 1);
      if (k) base += '_' + (k + 1);
      dir.file(base + '.jpg', b, { binary: true });
      cnt.n++; if (progress && cnt.n % 20 === 0) progress(cnt.n);
    }
  }
}
/* Выгрузка: на каждое строение (адрес / ЖК) — свой Excel и своя папка «Фото».
   Одно строение: Excel (или ZIP: Excel + Фото/). Несколько: ZIP с папкой на каждое строение. */
async function buildExport(names, withPhotos, progress) {
  // имя файла: строение, а если для него есть адрес из загруженного файла — адрес + строение
  const xName = b => { const a = sheetAddr(b); return fileName(b && a && a !== b ? `${a} ${b}` : (b || null)); };
  const parts = names.map(b => ({ b, recs: S.recs.filter(r => bldNameOf(r) === b) })).filter(p => p.recs.length);
  if (parts.length === 1 && !withPhotos) {
    const p = parts[0];
    return { blob: await buildWorkbook(p.recs, p.b), name: xName(p.b), files: 1 };
  }
  const zip = new JSZip(), cnt = { n: 0 };
  for (const p of parts) {
    const xname = xName(p.b);
    const dir = parts.length === 1 ? zip : zip.folder(safeName(p.b) || 'Без_строения');
    dir.file(xname, await buildWorkbook(p.recs, p.b));
    if (withPhotos) await addPhotos(dir.folder('Фото'), p.recs, new Map(), progress, cnt);
  }
  const zname = parts.length === 1 ? xName(parts[0].b) : fileName(parts.length + '_строения');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' });
  return { blob, name: zname.replace(/\.xlsx$/, '.zip'), files: parts.length, photos: cnt.n };
}
function renderExpBld() {
  const sel = $('expBld'), v = sel.value, names = buildingNames();
  const cnt = b => S.recs.filter(r => bldNameOf(r) === b).length;
  sel.innerHTML = (names.length > 1 ? `<option value="*">Все строения — отдельный Excel на каждое (${names.length})</option>` : '') +
    names.map(b => `<option value="${esc(b)}">${esc(b || 'без строения')} (записей: ${cnt(b)})</option>`).join('');
  if ([...sel.options].some(o => o.value === v)) sel.value = v;
  $('expInfo').textContent = names.length > 1 ? 'Каждое строение (адрес / ЖК) выгружается отдельным Excel со своими фото.' : '';
}
async function doExport(share, withPhotos) {
  readSettings();
  if (!S.recs.length) { toast('Нет записей для выгрузки'); return; }
  const sv = $('expBld').value, names = sv === '*' || sv == null ? buildingNames() : [sv];
  const scope = S.recs.filter(r => names.includes(bldNameOf(r)));
  const empty = scope.filter(r => !r.num).length, dm = dupMap();
  const dups = scope.filter(r => r.num && dm.get(r.num) > 1).length;
  const noPhoto = withPhotos ? scope.filter(r => r.num && !r.photo).length : 0;
  if ((empty || dups || noPhoto) && !await ask('Проверка перед выгрузкой', `${empty ? `Без номера: <b>${empty}</b><br>` : ''}${dups ? `Повторяющихся номеров: <b>${dups}</b><br>` : ''}${noPhoto ? `С номером, но без фото: <b>${noPhoto}</b><br>` : ''}<br>Выгрузить как есть?`, 'Выгрузить')) return;
  const msg = $('fileMsg'); msg.innerHTML = '<div class="msg">Формирую файл…</div>';
  try {
    const out = await buildExport(names, withPhotos, n => msg.innerHTML = `<div class="msg">Упаковываю фото… ${n}</div>`);
    const blob = out.blob, name = out.name;
    if (share) {
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); msg.innerHTML = `<div class="msg ok">Отправлено: ${esc(name)}${out.files > 1 ? ` (${out.files} Excel)` : ''}</div>`; return; }
        catch (e) { if (e.name === 'AbortError') { msg.innerHTML = ''; return; } }
      }
    }
    download(blob, name);
    msg.innerHTML = `<div class="msg ok">Сохранён файл ${esc(name)}${out.files > 1 ? ` — внутри ${out.files} Excel по строениям` : ''} (папка «Загрузки»)</div>`;
  } catch (e) {
    console.error(e); msg.innerHTML = `<div class="msg bad">Ошибка выгрузки: ${esc(e.message)}</div>`;
  }
}
/* загрузка списка из Excel в том же формате */
function cellText(ws, r, c, keepNl) {
  let cell = ws.getCell(r, c);
  if (cell.isMerged && cell.master) cell = cell.master;
  let t = cell.text;
  if (t == null || t === '') { const v = cell.value; t = v == null ? '' : (typeof v === 'object' ? (v.result ?? v.text ?? (v.richText ? v.richText.map(x => x.text).join('') : '')) : v); }
  t = String(t ?? '');
  return (keepNl ? t.replace(/[ \t]+/g, ' ').replace(/ *\r?\n */g, '\n') : t.replace(/\s+/g, ' ')).trim();
}
async function parseWorkbook(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const recs = [], channels = []; let addr = '', ord = 0; const blds = new Set(), types = new Set();
  wb.eachSheet(ws => {
    let hdr = 0;
    for (let r = 1; r <= Math.min(12, ws.rowCount); r++) if (cellText(ws, r, 1).startsWith('№')) { hdr = r; break; }
    if (!hdr) return;
    const isChan = /канал/i.test(cellText(ws, hdr, 1));
    if (hdr > 1 && !addr) { const a = cellText(ws, 1, 1); if (a && a !== 'Адрес объекта') addr = a; }
    const title = [ws.name, ...Array.from({ length: hdr - 1 }, (_, i) => cellText(ws, i + 1, 1))].join(' ');
    const sheetRes = RES.find(x => new RegExp('(^|[^А-ЯЁа-яё])' + x + '([^А-ЯЁа-яё]|$)').test(title)) || '';
    for (let r = hdr + 1; r <= ws.rowCount; r++) {
      const v = [1, 2, 3, 4, 5, 6].map(c => cellText(ws, r, c, isChan));
      if (!v.some(Boolean)) continue;
      if (isChan) { channels.push(v); continue; }
      const res = sheetRes || RES.find(x => x === v[3]) || v[3];
      if (!RES.includes(res)) continue;
      const rec = { id: newId(), res, pos: v[0], type: v[1] || 'Квартира', name: padName(v[2]), bld: v[5], num: v[4].replace(/\s+/g, ''), src: v[4] ? 'import' : '', ts: 0, ord: ++ord };
      if (!rec.name && !rec.num) continue;
      if (rec.bld) { const n = splitBld(rec.bld).name; if (n) blds.add(n); }
      if (rec.type) types.add(rec.type);
      recs.push(rec);
    }
  });
  return { recs, channels, addr, blds: [...blds], types: [...types] };
}
async function doImport(file) {
  const msg = $('fileMsg');
  try {
    msg.innerHTML = '<div class="msg">Читаю файл…</div>';
    const data = await parseWorkbook(await file.arrayBuffer());
    if (!data.recs.length) { msg.innerHTML = '<div class="msg bad">В файле не найдено строк со счётчиками (нужна шапка «№ поз.» и листы Тепло/ГВС/ХВС).</div>'; return; }
    const cnt = RES.map(r => `${r}: ${data.recs.filter(x => x.res === r).length}`).join(', ');
    const filled = data.recs.filter(r => r.num).length;
    const fileBlds = [...new Set(data.recs.map(bldNameOf))];
    let append = false;
    if (S.recs.length) {
      const have = buildingNames(), overlap = fileBlds.filter(b => have.includes(b));
      append = await ask('Загрузка списка',
        `В приложении уже <b>${S.recs.length}</b> записей (строения: ${esc(have.map(b => b || 'без строения').join(', '))}).<br>` +
        `В файле: ${cnt}; с номерами ${filled}; строения: ${esc(fileBlds.map(b => b || 'без строения').join(', '))}.<br><br>` +
        `Добавить записи из файла к текущим?${overlap.length ? `<br><b>Внимание:</b> строения ${esc(overlap.join(', '))} уже есть — записи добавятся к ним.` : ''}`,
        'Добавить', 'Нет');
      if (!append && !await ask('Заменить всё?', `Все текущие записи (<b>${S.recs.length}</b>) и их фото будут удалены и заменены данными из файла.<br><br>Совет: сначала выгрузите Excel или сделайте «Резервную копию».`, 'Заменить всё')) { msg.innerHTML = ''; return; }
    }
    if (append) {
      for (const r of data.recs) r.ord += S.ord;
      S.recs = S.recs.concat(data.recs); S.ord += data.recs.length + 1;
      if (data.channels.length && !S.channels.length) S.channels = data.channels;
    } else {
      if (S.recs.some(r => r.photo)) await PDB.clear().catch(() => { });
      S.recs = data.recs; S.channels = data.channels; S.ord = data.recs.length + 1;
      S.bldAddr = {};
      if (data.addr) S.addr = data.addr;
    }
    // адрес из строки 1 файла запоминаем для его строений — он вернётся в строку 1 при выгрузке
    S.bldAddr = S.bldAddr || {};
    if (data.addr) for (const b of fileBlds) if (b && b !== data.addr) S.bldAddr[b] = data.addr;
    for (const b of data.blds) if (!S.blds.includes(b)) S.blds.push(b);
    for (const t of data.types) if (!S.types.includes(t)) S.types.push(t);
    S.sort = 'entry';
    const firstEmpty = data.recs.find(r => !r.num) || data.recs[0];
    S.cur = { res: firstEmpty.res, bld: firstEmpty.bld, type: firstEmpty.type, name: firstEmpty.name };
    save(); renderFile();
    msg.innerHTML = `<div class="msg ok">Загружено ${data.recs.length} строк (${cnt}); уже с номерами: ${filled}. Порядок строк — как в файле.</div>`;
  } catch (e) {
    console.error(e); msg.innerHTML = `<div class="msg bad">Не удалось прочитать файл: ${esc(e.message)}</div>`;
  }
}

/* ---------------- РАСПОЗНАВАНИЕ ---------------- */
let ocrWorker = null, ocrLoading = null, barcode;
function ocrStatus(t) { const el = $('scanStatus'); if (el) el.textContent = t; }
function getOcr(progress) {
  if (ocrWorker) return Promise.resolve(ocrWorker);
  if (ocrLoading) return ocrLoading;
  ocrLoading = (async () => {
    const w = await Tesseract.createWorker('eng', 1, {
      workerPath: abs('lib/tesseract/worker.min.js'),
      corePath: abs('lib/tesseract/core'),
      langPath: abs('lib/tesseract/lang'),
      workerBlobURL: false,
      logger: m => { if (progress && m.status && !/recogniz/.test(m.status)) progress(m); },
    });
    await w.setParameters({ tessedit_char_whitelist: '0123456789-_', tessedit_pageseg_mode: '6', user_defined_dpi: '300' });
    try { localStorage.setItem('ocrReady', '1'); } catch (e) { }
    ocrWorker = w; return w;
  })();
  ocrLoading.catch(() => { ocrLoading = null; });
  return ocrLoading;
}
async function getBarcode() {
  if (barcode !== undefined) return barcode;
  barcode = null;
  try {
    if ('BarcodeDetector' in window) {
      const f = await window.BarcodeDetector.getSupportedFormats();
      if (f && f.length) return (barcode = new window.BarcodeDetector({ formats: f }));
    }
  } catch (e) { }
  try {
    const api = window.BarcodeDetectionAPI;
    api.prepareZXingModule({ overrides: { locateFile: (p, prefix) => p.endsWith('.wasm') ? abs('lib/zxing/' + p) : prefix + p } });
    barcode = new api.BarcodeDetector({ formats: ['qr_code', 'data_matrix', 'code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e', 'pdf417', 'aztec'] });
  } catch (e) { console.warn('barcode', e); barcode = null; }
  return barcode;
}

const SC = { on: false, paused: false, stream: null, track: null, hist: [], res: 'Тепло', ocrTimer: 0, codeTimer: 0 };
const useText = () => S.scanMode !== 'code';
const useCode = () => S.scanMode !== 'text';

async function openScanner(target) {
  SC.target = target || null; // {id, draft} — пересканирование из окна правки
  if (!SC.target) syncCur();
  const pl = SC.target ? SC.target.draft : S.cur;
  SC.res = pl.res; SC.on = true; SC.paused = false; SC.hist = []; SC.shot = null;
  $('scan').classList.add('on');
  $('scanRes').classList.remove('on');
  $('scanTitle').textContent = `${SC.target ? 'Исправление · ' : ''}${SC.res}, ${placeLabel(pl)} · ${maskOf(SC.res) ? 'формат ' + maskHint(maskOf(SC.res)) : ''}`;
  $('scanRaw').textContent = '';
  document.querySelectorAll('#scanModes button').forEach(b => b.classList.toggle('on', b.dataset.m === S.scanMode));
  setFrameShape();
  ocrStatus('Запуск камеры…');
  try {
    SC.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) {
    ocrStatus('Нет доступа к камере: ' + e.message + '. Разрешите камеру в настройках браузера или используйте кнопку «Фото».');
    return;
  }
  if (!SC.on) { stopStream(); return; }
  const v = $('video'); v.srcObject = SC.stream; await v.play().catch(() => { });
  SC.track = SC.stream.getVideoTracks()[0];
  setupTrackControls();
  ocrStatus('Наведите рамку на номер счётчика');
  if (useText()) startOcrLoop();
  if (useCode()) startCodeLoop();
}
function setFrameShape() {
  const f = $('frame');
  if (S.scanMode === 'code') { f.style.top = '22%'; f.style.height = '36%'; }
  else { f.style.top = '32%'; f.style.height = '16%'; }
}
function setupTrackControls() {
  const t = SC.track, caps = t && t.getCapabilities ? t.getCapabilities() : {};
  try { if (caps.focusMode && caps.focusMode.includes('continuous')) t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { }
  const tb = $('scanTorch'); tb.hidden = !caps.torch; tb.classList.remove('on');
  const z = $('scanZoom');
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    z.hidden = false; z.min = caps.zoom.min; z.max = Math.min(caps.zoom.max, caps.zoom.min * 8); z.step = caps.zoom.step || 0.1;
    z.value = (t.getSettings && t.getSettings().zoom) || caps.zoom.min;
  } else z.hidden = true;
}
function stopStream() {
  if (SC.stream) SC.stream.getTracks().forEach(t => t.stop());
  SC.stream = null; SC.track = null; $('video').srcObject = null;
}
function closeScanner() {
  SC.on = false; clearTimeout(SC.ocrTimer); clearTimeout(SC.codeTimer);
  stopStream(); $('scan').classList.remove('on'); $('frame').classList.remove('hit');
}
/* вырезаем область рамки из кадра и усиливаем контраст */
function grabCrop() {
  const v = $('video'), f = $('frame');
  const vw = v.videoWidth, vh = v.videoHeight; if (!vw) return null;
  const vr = v.getBoundingClientRect(), fr = f.getBoundingClientRect();
  const sc = Math.max(vr.width / vw, vr.height / vh);
  const ox = (vr.width - vw * sc) / 2, oy = (vr.height - vh * sc) / 2;
  let sx = (fr.left - vr.left - ox) / sc, sy = (fr.top - vr.top - oy) / sc, sw = fr.width / sc, sh = fr.height / sc;
  sx = Math.max(0, sx); sy = Math.max(0, sy); sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
  return preprocess(v, sx, sy, sw, sh, 240);
}
/* мелкий шрифт номера надо увеличивать в 4–6 раз: при ×3 OCR путает 9 и 8 */
function preprocess(src, sx, sy, sw, sh, targetH, maxW = 2000, stretch = true) {
  const k = Math.min(targetH / sh, maxW / sw, 6);
  const W = Math.round(sw * k), H = Math.round(sh * k);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
  if (!stretch) return c; // весь снимок: растяжка контраста по белому фону «съедает» мелкий шрифт
  const img = g.getImageData(0, 0, W, H), d = img.data, n = W * H;
  const gray = new Uint8ClampedArray(n), hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) { const y = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8; gray[i] = y; hist[y]++; }
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > n * 0.02) break; }
  acc = 0; for (; hi > 0; hi--) { acc += hist[hi]; if (acc > n * 0.02) break; }
  const span = Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < n; i++, j += 4) { const y = Math.max(0, Math.min(255, (gray[i] - lo) * 255 / span)); d[j] = d[j + 1] = d[j + 2] = y; d[j + 3] = 255; }
  g.putImageData(img, 0, 0);
  return c;
}
async function startOcrLoop() {
  clearTimeout(SC.ocrTimer);
  let w;
  try {
    w = await getOcr(m => ocrStatus(`Загрузка распознавания… ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`));
  } catch (e) { ocrStatus('Не удалось загрузить распознавание: ' + e.message); return; }
  ocrStatus('Наведите рамку на номер счётчика');
  let n = 0;
  const tick = async () => {
    if (!SC.on || SC.paused || !useText()) return;
    const cv = grabCrop();
    if (cv) {
      try {
        // кадры по очереди: «только цифры» и «весь текст» — второй лучше разделяет «№», подписи и номер
        await setWhitelist(w, (n++ % 2) === 0);
        const { data } = await w.recognize(cv);
        if (SC.on && !SC.paused) onOcrText(data.text || '');
      } catch (e) { console.warn(e); }
    }
    if (SC.on && !SC.paused) SC.ocrTimer = setTimeout(tick, 80);
  };
  tick();
}
function onOcrText(text) {
  const ex = extractNums(text, SC.res);
  $('scanRaw').textContent = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  SC.hist.push(ex.hits); if (SC.hist.length > 6) SC.hist.shift();
  const counts = new Map();
  for (const fr of SC.hist) for (const h of fr) counts.set(h, (counts.get(h) || 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] >= 2) showResult(best[0], 'Распознано по цифрам', ex.all);
  else if (ex.hits.length) { $('frame').classList.add('hit'); ocrStatus('Держите ровно… ' + ex.hits[0]); }
  else { $('frame').classList.remove('hit'); ocrStatus(ex.all.length ? 'Видно: ' + ex.all.slice(0, 3).join(', ') + ' — не по формату' : 'Наведите рамку на номер счётчика'); }
}
async function startCodeLoop() {
  clearTimeout(SC.codeTimer);
  const bd = await getBarcode();
  if (!bd) { if (S.scanMode === 'code') ocrStatus('Штрихкоды на этом устройстве не поддерживаются'); return; }
  let n = 0;
  const tick = async () => {
    if (!SC.on || SC.paused || !useCode()) return;
    const v = $('video');
    if (v.videoWidth) {
      try {
        // через кадр — весь кадр и увеличенный центр (QR на Пульсаре мелкий, ~1 см)
        const src = (n++ % 2) ? centerCrop(v) : v;
        const codes = await bd.detect(src);
        if (SC.on && !SC.paused && codes && codes.length) onCodes(codes);
      } catch (e) { console.warn(e); }
    }
    if (SC.on && !SC.paused) SC.codeTimer = setTimeout(tick, 150);
  };
  tick();
}
/* видимая середина кадра (60% ширины экрана), увеличенная ×2 */
function centerCrop(v) {
  const vw = v.videoWidth, vh = v.videoHeight, vr = v.getBoundingClientRect();
  const sc = Math.max(vr.width / vw, vr.height / vh);
  const side = Math.min(vr.width, vr.height) * 0.6 / sc;
  const c = centerCrop.c || (centerCrop.c = document.createElement('canvas'));
  const out = Math.min(1400, Math.round(side * 2));
  c.width = c.height = out;
  c.getContext('2d').drawImage(v, (vw - side) / 2, (vh - side) / 2 + vh * 0.0, side, side, 0, 0, out, out);
  return c;
}
const codeName = f => /qr/.test(f) ? 'QR-код' : /matrix/.test(f) ? 'DataMatrix' : 'Штрихкод';
function onCodes(codes) {
  for (const c of codes) {
    const raw = String(c.rawValue || '');
    const ex = extractNums(raw, SC.res);
    if (ex.hits.length) return showResult(ex.hits[0], `${codeName(c.format)}: ${raw.slice(0, 40)}`, ex.all);
  }
  // код содержит «чистый» номер, но не по маске (другой тип счётчика) — показываем, монтажник решит сам
  const clean = codes.map(c => String(c.rawValue || '').trim()).find(r => /^[\d_\-]{6,20}$/.test(r));
  if (clean) return showResult(normalizeNum(clean, SC.res), `${codeName(codes[0].format)}: ${clean} — не по формату ${maskHint(maskOf(SC.res))}`, []);
  if (S.scanMode === 'code') {
    const raw = String(codes[0].rawValue || '').trim();
    const ex = extractNums(raw, SC.res);
    showResult(ex.all.sort((a, b) => b.length - a.length)[0] || raw, `${codeName(codes[0].format)}: ${raw.slice(0, 40)} — не по формату`, ex.all);
  }
}
function showResult(num, src, all) {
  SC.paused = true; clearTimeout(SC.ocrTimer); clearTimeout(SC.codeTimer);
  beep();
  const v = $('video');
  SC.shot = v.videoWidth ? toJpeg(v, v.videoWidth, v.videoHeight) : null; // кадр счётчика в момент распознавания
  $('frame').classList.add('hit');
  $('scanResSrc').textContent = src;
  $('scanResNum').value = num;
  const m = maskOf(SC.res);
  const alts = [...new Set((all || []).map(d => applyMask(d, m)))].filter(x => x !== num).slice(0, 6);
  $('scanCands').innerHTML = alts.map(a => `<button type="button">${esc(a)}</button>`).join('');
  const dup = S.recs.find(r => r.num === num);
  ocrStatus(dup ? `⚠ Уже записан: ${dup.res}, ${placeLabel(dup)}` : '');
  $('scanRes').classList.add('on');
  SC.lastSrc = /QR/.test(src) ? 'QR' : /Штрих|DataMatrix/.test(src) ? 'штрихкод' : 'камера';
}
function retryScan() {
  SC.paused = false; SC.hist = [];
  $('scanRes').classList.remove('on'); $('frame').classList.remove('hit');
  ocrStatus('Наведите рамку на номер счётчика');
  if (useText()) startOcrLoop();
  if (useCode()) startCodeLoop();
}
function cancelScanner() {
  const t = SC.target; SC.target = null;
  closeScanner();
  if (t) reopenEdit(t, null, null);
}
async function acceptScan() {
  const v = $('scanResNum').value.trim();
  const shot = SC.shot; SC.shot = null;
  const t = SC.target; SC.target = null;
  closeScanner();
  if (t) { reopenEdit(t, v, shot); return; }
  $('inNum').value = normalizeNum(v, S.cur.res);
  $('inNum').dataset.src = SC.lastSrc || 'камера';
  checkNumField();
  if (shot) { const b = await shot.catch(() => null); if (b) setPending(b); } else renderPending();
}
let wlState = true;
async function setWhitelist(w, digitsOnly, psm) {
  const p = {};
  if (digitsOnly !== wlState) { p.tessedit_char_whitelist = digitsOnly ? '0123456789-_' : ''; wlState = digitsOnly; }
  if (psm) p.tessedit_pageseg_mode = psm;
  if (Object.keys(p).length) await w.setParameters(p);
}
async function detectCodes(bd, src, res) {
  const found = [], all = [];
  let codes = [];
  try { codes = await bd.detect(src); } catch (e) { }
  if (!codes.length && src.width && Math.max(src.width, src.height) < 1600) { // мелкий QR — пробуем увеличенным
    const c = document.createElement('canvas'), k = 2; c.width = src.width * k; c.height = src.height * k;
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    try { codes = await bd.detect(c); } catch (e) { }
  }
  for (const c of codes) { const ex = extractNums(c.rawValue || '', res); found.push(...ex.hits); all.push(...ex.all); }
  return { found, all, codes };
}
/* распознавание с фотографии (запасной вариант, если живая камера недоступна) */
async function recognizePhoto(file) {
  const box = $('numMsg');
  box.innerHTML = '<div class="msg">Распознаю фото…</div>';
  try {
    const bmp = await createImageBitmap(file);
    setPending(await toJpeg(bmp, bmp.width, bmp.height));
    const res = S.cur.res;
    let found = [], all = [];
    const bd = await getBarcode();
    if (bd) { const r = await detectCodes(bd, bmp, res); found.push(...r.found); all.push(...r.all); }
    const w = await getOcr(m => box.innerHTML = `<div class="msg">Загрузка распознавания… ${m.progress ? Math.round(m.progress * 100) + '%' : ''}</div>`);
    // весь снимок, без ограничения «только цифры»: так OCR находит строку «№ 20_3969714» среди надписей
    const k = Math.min(2400 / Math.max(bmp.width, bmp.height), 6);
    await setWhitelist(w, false, '11');
    try {
      for (const stretch of [false, true]) {
        const big = preprocess(bmp, 0, 0, bmp.width, bmp.height, bmp.height * k, bmp.width * k + 1, stretch);
        const { data } = await w.recognize(big); const ex = extractNums(data.text, res);
        found.push(...ex.hits); all.push(...ex.all);
        if (ex.hits.length) break;
      }
    } finally { await setWhitelist(w, true, '6'); }
    found = [...new Set(found)];
    const m = maskOf(res);
    const alts = [...new Set(all.map(d => applyMask(d, m)))].filter(x => !found.includes(x)).slice(0, 8);
    if (found.length) { $('inNum').value = found[0]; $('inNum').dataset.src = 'фото'; renderPending(); }
    const chips = [...found.slice(1), ...alts];
    box.innerHTML = (found.length ? `<div class="msg ok">Найдено: ${esc(found[0])} — проверьте</div>` : '<div class="msg warn">Номер по формату не найден. Снимите ближе и ровнее или введите вручную.</div>') +
      (chips.length ? `<div class="chips">${chips.map(c => `<button type="button" class="chip" data-pick="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : '');
    if (found.length) { const keep = box.innerHTML; checkNumField(); box.innerHTML = keep + box.innerHTML; }
  } catch (e) {
    console.error(e); box.innerHTML = `<div class="msg bad">Ошибка распознавания: ${esc(e.message)}</div>`;
  }
}

/* ---------------- события ---------------- */
function bind() {
  document.querySelectorAll('nav.tabs button').forEach(b => b.onclick = () => { if (curView === 'file') readSettings(); showView(b.dataset.v); });
  $('resSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.cur.res = b.dataset.r; save(); renderInput(); };
  $('inBld').onchange = onBldChanged;
  $('inBld').oninput = updBldPreview;
  $('inSec').onchange = onBldChanged;
  $('secDec').onclick = () => stepSec(-1);
  $('secInc').onclick = () => stepSec(1);
  $('inType').onchange = () => { syncCur(); renderPlace(); };
  $('inName').onchange = onNameChanged;
  $('inName').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('inName').blur(); } };
  $('nameDec').onclick = () => stepName(-1);
  $('nameInc').onclick = () => stepName(1);
  $('prevEmpty').onclick = () => jumpEmpty(-1);
  $('nextEmpty').onclick = () => jumpEmpty(1);
  $('inNum').oninput = () => { $('inNum').dataset.src = 'ручной'; checkNumField(); renderPending(); };
  $('photoBox').onclick = e => {
    if (e.target.id === 'photoDrop') setPending(null);
    else if (e.target.dataset.view && pending) viewPhoto(pending.url);
  };
  $('ePhoto').onclick = e => { if (e.target.dataset.view && editPhotoUrl) viewPhoto(editPhotoUrl); };
  $('photoView').onclick = () => $('photoView').classList.remove('on');
  $('ePhotoBtn').onclick = () => $('ePhotoInput').click();
  $('ePhotoInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) editTakePhoto(f); };
  $('inNum').onblur = () => { const v = normalizeNum($('inNum').value, S.cur.res); if (v !== $('inNum').value) { $('inNum').value = v; checkNumField(); } };
  $('inNum').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); saveCurrent(true); } };
  $('numMsg').onclick = e => { const b = e.target.closest('[data-pick]'); if (b) { $('inNum').value = b.dataset.pick; checkNumField(); } };
  $('btnSaveNext').onclick = () => saveCurrent(true);
  $('btnSaveSame').onclick = () => saveCurrent(false);
  $('btnScan').onclick = () => openScanner();
  $('placeInfo').onclick = e => { const c = e.target.closest('[data-id]'); if (c) openEdit(c.dataset.id); };
  $('eRescan').onclick = editRescan;
  $('eClear').onclick = () => $('dlgEdit').close('clear');
  $('eNum').oninput = checkEditNum;
  $('eRes').onchange = checkEditNum;
  $('btnPhoto').onclick = () => { syncCur(); $('photoInput').click(); };
  $('photoInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) recognizePhoto(f); };
  $('recentTbl').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) openEdit(tr.dataset.id); };
  // сканер
  $('scanClose').onclick = cancelScanner;
  $('scanRetry').onclick = retryScan;
  $('scanAccept').onclick = acceptScan;
  $('scanCands').onclick = e => { const b = e.target.closest('button'); if (b) $('scanResNum').value = b.textContent; };
  $('scanModes').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S.scanMode = b.dataset.m; save();
    document.querySelectorAll('#scanModes button').forEach(x => x.classList.toggle('on', x === b));
    setFrameShape(); if (!SC.paused) retryScan();
  };
  $('scanTorch').onclick = async () => {
    const b = $('scanTorch'), on = !b.classList.contains('on');
    try { await SC.track.applyConstraints({ advanced: [{ torch: on }] }); b.classList.toggle('on', on); } catch (e) { toast('Фонарик недоступен'); }
  };
  $('scanZoom').oninput = e => { try { SC.track.applyConstraints({ advanced: [{ zoom: +e.target.value }] }); } catch (er) { } };
  document.addEventListener('visibilitychange', () => { if (document.hidden && SC.on) cancelScanner(); });
  // список
  ['fRes', 'fBld', 'fState'].forEach(id => $(id).onchange = renderList);
  $('fText').oninput = renderList;
  $('listTbl').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) openEdit(tr.dataset.id); };
  $('dlgEdit').addEventListener('close', closeEdit);
  // файл
  ['sAddr', 'sWorker', 'sBlds', 'sTypes', 'sPad', 'sSort'].forEach(id => $(id).addEventListener('change', readSettings));
  $('maskBox').addEventListener('change', readSettings);
  $('btnExportZip').onclick = () => doExport(true, true);
  $('btnExport').onclick = () => doExport(true, false);
  $('btnExportSave').onclick = () => doExport(false, !!S.recs.some(r => r.photo));
  $('btnImport').onclick = () => $('importInput').click();
  $('importInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) doImport(f); };
  $('btnBackup').onclick = () => {
    readSettings();
    download(new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' }), fileName().replace(/\.xlsx$/, '.json'));
  };
  $('btnRestore').onclick = () => $('restoreInput').click();
  $('restoreInput').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (!Array.isArray(s.recs)) throw new Error('это не резервная копия приложения');
      if (!await ask('Восстановить?', `Текущие данные (${S.recs.length} записей) будут заменены копией (${s.recs.length} записей).`, 'Восстановить')) return;
      S = Object.assign(JSON.parse(JSON.stringify(DEF)), s); save(); renderFile(); toast('Восстановлено');
    } catch (er) { $('fileMsg').innerHTML = `<div class="msg bad">Ошибка: ${esc(er.message)}</div>`; }
  };
  $('btnClear').onclick = async () => {
    if (!await ask('Очистить всё?', `Будут удалены все <b>${S.recs.length}</b> записей. Настройки сохранятся.<br>Перед этим лучше выгрузить Excel.`, 'Удалить всё')) return;
    S.recs = []; S.channels = []; S.ord = 0; await PDB.clear().catch(() => { }); save(); renderFile(); toast('Данные и фото очищены');
  };
}

/* ---------------- запуск ---------------- */
function init() {
  bind();
  renderHeader();
  renderInput();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
  }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { }
  // при первом запуске с интернетом заранее скачиваем распознавание, чтобы на объекте работало без сети
  if (!localStorage.getItem('ocrReady') && navigator.onLine && location.protocol !== 'file:') {
    setTimeout(() => getOcr().then(() => { if (curView === 'file') renderFile(); }).catch(() => { }), 3000);
  }
}
window.addEventListener('DOMContentLoaded', init);
