// BookPlayer（ブラウザ版）：VoiceBook の「スマホ用にまとめる」で作った <書名>.book.zip を、ページを見ながら聞く
// 形式は audiobook\player\まとめた本の形式.txt を見てください
'use strict';

const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const RUBY_ROOM = 0.6;        // 光らせる所を、ふりがなの側へどれだけ広げるか（文字の太さに対して）
const BROWSE_SECONDS = 10;    // ページをめくって見ているとき、何秒さわらなければ読んでいる所にもどるか
const $ = (id) => document.getElementById(id);

// ---------------- しまっておく所（IndexedDB と localStorage） ----------------
const DB_NAME = 'bookplayer', STORE = 'books';
function openDb() {
  return new Promise((ok, ng) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ng(r.error);
  });
}
async function dbDo(mode, fn) {
  const db = await openDb();
  return new Promise((ok, ng) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => ok(req && req.result);
    tx.onerror = () => ng(tx.error);
    tx.onabort = () => ng(tx.error);
  });
}
const dbAll = () => dbDo('readonly', (s) => s.getAll());
const dbGet = (id) => dbDo('readonly', (s) => s.get(id));
const dbPut = (rec) => dbDo('readwrite', (s) => s.put(rec));
const dbDel = (id) => dbDo('readwrite', (s) => s.delete(id));

function loadJson(key, def) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function saveJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { } }
const settings = Object.assign({ speed: '1.0', volume: 100, hl: 'dim', spread: 'auto' }, loadJson('bp_settings', {}));
const saveSettings = () => saveJson('bp_settings', settings);

// ---------------- ZIP を読む（縮めずに入れた ZIP。縮めたものも読める） ----------------
async function readBytes(blob, start, end) { return new Uint8Array(await blob.slice(start, end).arrayBuffer()); }
async function openZip(blob) {
  const size = blob.size;
  const tailLen = Math.min(size, 65557);
  const tail = await readBytes(blob, size - tailLen, size);
  const dv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('ZIP ではないようです');
  const n = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
  const cd = await readBytes(blob, cdOff, cdOff + cdSize);
  const cv = new DataView(cd.buffer);
  const dec = new TextDecoder();
  const entries = {};
  let p = 0;
  for (let k = 0; k < n; k++) {
    if (cv.getUint32(p, true) !== 0x02014b50) break;
    const method = cv.getUint16(p + 10, true), csize = cv.getUint32(p + 20, true), usize = cv.getUint32(p + 24, true);
    const nl = cv.getUint16(p + 28, true), el = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true);
    const lho = cv.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nl));
    entries[name] = { method, csize, usize, lho };
    p += 46 + nl + el + cl;
  }
  return {
    has: (name) => name in entries,
    async blob(name, type) {
      const e = entries[name];
      if (!e) throw new Error('本の中に ' + name + ' がありません');
      const lh = await readBytes(blob, e.lho, e.lho + 30);
      const lv = new DataView(lh.buffer);
      const start = e.lho + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
      const raw = blob.slice(start, start + e.csize, type || '');
      if (e.method === 0) return raw;
      if (e.method === 8 && typeof DecompressionStream !== 'undefined') {
        const s = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Blob([await new Response(s).arrayBuffer()], { type: type || '' });
      }
      throw new Error('この ZIP の縮め方には対応していません');
    },
    async json(name) { return JSON.parse(await (await this.blob(name)).text()); },
  };
}

// ---------------- 本棚 ----------------
async function showLibrary() {
  stopAll();
  document.body.classList.remove('full');
  $('player').hidden = true; $('library').hidden = false;
  const books = (await dbAll()).sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
  const box = $('books'); box.innerHTML = '';
  $('libHint').hidden = books.length > 0;
  for (const b of books) {
    const el = document.createElement('div'); el.className = 'book';
    const img = document.createElement('img'); img.alt = '';
    if (b.cover) img.src = URL.createObjectURL(b.cover);
    const t = document.createElement('div'); t.className = 't'; t.textContent = b.title;
    const a = document.createElement('div'); a.className = 'a'; a.textContent = b.author || '';
    const st = loadJson('bp_pos_' + b.id, null);
    const p = document.createElement('div'); p.className = 'p';
    p.textContent = Math.round(b.size / 1048576) + ' MB' + (st && b.tracks && b.tracks[st.track] ? '・' + b.tracks[st.track].title + ' の続きから' : '');
    const del = document.createElement('button'); del.className = 'btn del'; del.textContent = '消す';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('「' + b.title + '」をこの端末から消しますか？（もとの ZIP は消えません）')) return;
      await dbDel(b.id); localStorage.removeItem('bp_pos_' + b.id); showLibrary();
    };
    el.append(img, t, a, p, del);
    el.onclick = () => openBook(b.id);
    box.append(el);
  }
  if (navigator.storage && navigator.storage.estimate) {
    const e = await navigator.storage.estimate();
    $('storage').textContent = 'この端末で使っている量：' + Math.round((e.usage || 0) / 1048576) + ' MB' +
      (e.quota ? '（使える量の目安：' + Math.round(e.quota / 1073741824 * 10) / 10 + ' GB）' : '');
  }
}

async function addBook(blob, fileName) {
  const zip = await openZip(blob);
  if (!zip.has('book.json')) throw new Error('book.json がありません。VoiceBook の「スマホ用にまとめる」で作った ZIP を選んでください');
  const m = await zip.json('book.json');
  if (m.format !== 'bookplayer-book') throw new Error('BookPlayer の本ではないようです');
  const cover = m.cover && zip.has(m.cover) ? await zip.blob(m.cover, 'image/jpeg') : null;
  const id = (m.title || fileName) + '｜' + (m.author || '');
  const old = await dbGet(id);
  const rec = { id, title: m.title || fileName, author: m.author || '', tracks: m.tracks, size: blob.size,
    added: Date.now(), opened: old ? old.opened : 0, zip: blob, cover: cover ? new Blob([await cover.arrayBuffer()], { type: 'image/jpeg' }) : null };
  await dbPut(rec);
  if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { } }
  return id;
}

$('fileInput').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; ev.target.value = '';
  if (!f) return;
  const hint = $('libHint'); hint.hidden = false;
  // いま何をしているかと、何秒たったかを出す（止まっているのか、進んでいるのかがわかるように）
  const t0 = Date.now(); let step = '';
  const show = () => { hint.textContent = '「' + f.name + '」（' + Math.round(f.size / 1048576) + ' MB）を取りこんでいます：' + step + '（' + Math.round((Date.now() - t0) / 1000) + '秒）'; };
  const tick = setInterval(show, 500);
  try {
    // 選んだファイルを、この端末の中にしまう（あとでファイルが動いても聞けるように、中身を写す）
    step = 'ファイルを読んでいます'; show();
    const blob = new Blob([await f.arrayBuffer()], { type: 'application/zip' });
    step = '端末の中にしまっています'; show();
    await addBook(blob, f.name.replace(/\.book\.zip$|\.zip$/i, ''));
    hint.textContent = '';
  } catch (e) {
    alert('取りこめませんでした：' + (e && e.message ? e.message : e));
  }
  clearInterval(tick);
  showLibrary();
});

// ---------------- 再生 ----------------
const S = {
  book: null, zip: null, manifest: null, pdf: null, track: -1, sync: null, items: [], vertical: true,
  cur: -1, curChar: -1, view: { start: -1, count: 1 }, browsing: false, browseAt: 0, url: null, raf: 0, lastSave: 0,
  renderToken: 0,
};
const audio = $('audio');

function stopAll() {
  try { audio.pause(); } catch (e) { }
  if (S.url) { URL.revokeObjectURL(S.url); S.url = null; }
  cancelAnimationFrame(S.raf);
}

async function openBook(id) {
  const rec = await dbGet(id);
  if (!rec) return;
  rec.opened = Date.now(); dbPut(rec);
  S.book = rec;
  $('library').hidden = true; $('player').hidden = false;
  // 前に本文だけを大きくしていたら、そのまま（ブラウザの枠の全画面は、ボタンを押したときだけ）
  document.body.classList.toggle('full', !!settings.full);
  $('bookTitle').textContent = rec.title + (rec.author ? '　' + rec.author : '');
  $('loading').hidden = false; $('pages').innerHTML = '';
  const t0 = Date.now();
  const tick = setInterval(() => { $('loading').textContent = '読みこんでいます…（' + Math.round((Date.now() - t0) / 1000) + '秒）'; }, 500);
  try { await openBookInner(rec, id); }
  catch (e) { alert('開けませんでした：' + (e && e.message ? e.message : e)); showLibrary(); }
  finally { clearInterval(tick); $('loading').textContent = '読みこんでいます…'; }
}

async function openBookInner(rec, id) {
  S.zip = await openZip(rec.zip);
  S.manifest = await S.zip.json('book.json');
  const sel = $('trackSel'); sel.innerHTML = '';
  S.manifest.tracks.forEach((t, i) => { const o = document.createElement('option'); o.value = i; o.textContent = t.title + (t.sync ? '' : '（対応データなし）'); sel.append(o); });
  // PDF は丸ごと読まずに、出すページに要る所だけをそのつど読む（大きい PDF でもすぐ開ける）
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const pdfBlob = await S.zip.blob(S.manifest.pdf, 'application/pdf');
  const range = new pdfjsLib.PDFDataRangeTransport(pdfBlob.size, null);
  range.requestDataRange = (begin, end) => {
    pdfBlob.slice(begin, end).arrayBuffer().then((b) => range.onDataRange(begin, new Uint8Array(b)));
  };
  S.pdf = await pdfjsLib.getDocument({ range, length: pdfBlob.size, disableAutoFetch: true, disableStream: true, rangeChunkSize: 262144 }).promise;
  $('loading').hidden = true;
  const st = loadJson('bp_pos_' + id, { track: 0, pos: 0 });
  await loadTrack(Math.min(st.track || 0, S.manifest.tracks.length - 1), st.pos || 0);
}

async function loadTrack(i, pos) {
  stopAll();
  S.track = i; $('trackSel').value = i;
  const t = S.manifest.tracks[i];
  S.sync = null; S.items = []; S.cur = -1; S.curChar = -1; S.view = { start: -1, count: 1 }; S.browsing = false;
  if (t.sync && S.zip.has(t.sync)) {
    S.sync = await S.zip.json(t.sync);
    S.items = S.sync.items || [];
    let v = 0, h = 0;
    for (const it of S.items) for (const r of it.rects || []) { if (r[4] - r[2] > r[3] - r[1]) v++; else h++; }
    S.vertical = v >= h;
    $('pages').style.direction = S.vertical ? 'rtl' : 'ltr';
    // 右とじ（縦書き）の本は、位置のつまみも右から左へ進む（時間の表示も左に）
    $('seek').style.direction = S.vertical ? 'rtl' : 'ltr';
    document.querySelector('.seekrow').style.flexDirection = S.vertical ? 'row-reverse' : 'row';
  }
  S.url = URL.createObjectURL(await S.zip.blob(t.audio, 'audio/mpeg'));
  audio.src = S.url;
  audio.playbackRate = parseFloat(settings.speed);
  audio.volume = settings.volume / 100;
  await new Promise((ok) => { audio.addEventListener('loadedmetadata', ok, { once: true }); setTimeout(ok, 4000); });
  try { audio.currentTime = pos; } catch (e) { }
  setPlayIcon();
  setMediaSession();
  if (!S.sync) { $('line').textContent = 'この曲には対応データがありません。音だけ再生します。'; $('pages').innerHTML = ''; }
  update(true, pos);
  updateTime();
}

function fmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}
let seeking = false;
function updateTime() {
  const d = audio.duration || 0, p = audio.currentTime || 0;
  $('time').textContent = fmt(p) + ' / ' + fmt(d);
  if (!seeking && d > 0) $('seek').value = Math.round(1000 * p / d);
}
function savePos(force) {
  if (!S.book || S.track < 0) return;
  const now = Date.now();
  if (!force && now - S.lastSave < 5000) return;
  S.lastSave = now;
  saveJson('bp_pos_' + S.book.id, { track: S.track, pos: Math.round(audio.currentTime * 10) / 10 });
}

function findItem(t) {
  const a = S.items; if (!a.length) return -1;
  let lo = 0, hi = a.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
function findChar(it, t) {
  const cs = it.chars; if (!cs || !cs.length) return -1;
  let lo = 0, hi = cs.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cs[mid][5] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
// 読んでいる文字のページ（なければ文のページ。見出しなど、ページにない文は次の文のページ）
function pageAt(i, j) {
  const it = S.items[i];
  let pg = j >= 0 ? it.chars[j][0] : it.page;
  for (let k = i + 1; pg == null && k < Math.min(S.items.length, i + 4); k++) if (S.items[k].page != null) pg = S.items[k].page;
  return pg;
}

// いまの時刻の文に色を付け、読んでいる文字のページが見えていなければめくる
function update(force, at) {
  if (!S.sync) return;
  if (S.browsing) {
    if (!force && (Date.now() - S.browseAt) / 1000 < BROWSE_SECONDS) return;
    S.browsing = false; force = true;
  }
  const t = at != null ? at : audio.currentTime;
  const i = findItem(t); if (i < 0) return;
  const it = S.items[i], j = findChar(it, t);
  if (i === S.cur && j === S.curChar && !force) return;
  const same = i === S.cur;
  S.cur = i; S.curChar = j;
  if (!same || force) $('line').textContent = it.text || '';
  const pg = pageAt(i, j);
  if (pg != null && !shown(pg)) showPage(pg);
  else if (!same || force) drawOverlays();
}

// ---------------- ページを出す ----------------
function spreadCount() {
  const st = $('stage');
  return settings.spread === 'auto' && st.clientWidth > st.clientHeight * 1.15 ? 2 : 1;
}
const shown = (pg) => pg >= S.view.start && pg < S.view.start + S.view.count;
function showPage(pg, browsing) {
  const n = spreadCount();
  const total = S.pdf ? S.pdf.numPages : 0;
  if (pg < 0 || pg >= total) return;
  S.view = { start: n === 2 ? pg - (pg % 2) : pg, count: n };
  if (browsing) { S.browsing = true; S.browseAt = Date.now(); }
  renderView();
}
function movePage(step) {
  if (!S.pdf || S.view.start < 0) return;
  const n = S.view.count;
  const to = S.view.start + step * n;
  if (to < 0 || to >= S.pdf.numPages) return;
  showPage(to, true);
}

async function renderView() {
  const token = ++S.renderToken;
  const box = $('pages'), st = $('stage');
  const n = S.view.count, dpr = window.devicePixelRatio || 1;
  const W = st.clientWidth / n, H = st.clientHeight;
  const els = [];
  for (let k = 0; k < n; k++) {
    const pn = S.view.start + k;
    if (pn >= S.pdf.numPages) break;
    const page = await S.pdf.getPage(pn + 1);
    if (token !== S.renderToken) return;
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(W / vp1.width, H / vp1.height);
    const vp = page.getViewport({ scale: scale * dpr });
    const el = document.createElement('div'); el.className = 'page';
    el.style.width = Math.floor(vp1.width * scale) + 'px'; el.style.height = Math.floor(vp1.height * scale) + 'px';
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    c.style.width = el.style.width; c.style.height = el.style.height;
    const o = document.createElement('canvas'); o.width = c.width; o.height = c.height; o.style.width = c.style.width; o.style.height = c.style.height;
    el.append(c, o);
    el.dataset.pn = pn;
    el._scale = scale * dpr; el._css = scale; el._overlay = o;
    els.push({ el, page, vp, c });
  }
  if (token !== S.renderToken) return;
  box.innerHTML = '';
  for (const x of els) box.append(x.el);
  drawOverlays();
  const nums = els.map((x) => +x.el.dataset.pn + 1);
  $('pageInfo').textContent = (nums.length > 1 ? nums.join('・') : nums[0]) + ' ページ' + (S.browsing ? '（見ているだけ）' : '');
  for (const x of els) {
    await x.page.render({ canvasContext: x.c.getContext('2d'), viewport: x.vp }).promise;
    if (token !== S.renderToken) return;
  }
}

function drawOverlays() {
  const dpr = window.devicePixelRatio || 1;
  for (const el of $('pages').children) {
    const o = el._overlay, g = o.getContext('2d');
    g.clearRect(0, 0, o.width, o.height);
    if (S.cur < 0 || !S.items[S.cur]) continue;
    const pn = +el.dataset.pn, k = el._scale, pad = 3 * dpr;
    const boxes = [];
    for (const r of S.items[S.cur].rects || []) {
      if (r[0] !== pn) continue;
      let x = r[1] * k - pad, y = r[2] * k - pad, w = (r[3] - r[1]) * k + 2 * pad, h = (r[4] - r[2]) * k + 2 * pad;
      // ふりがなの所まで広げる：縦書きは行の右、横書きは行の上
      if (h > w) w += (w - 2 * pad) * RUBY_ROOM; else { const ex = (h - 2 * pad) * RUBY_ROOM; y -= ex; h += ex; }
      boxes.push([x, y, w, h]);
    }
    // 2ページ出しているとき、読んでいる文のないほうのページも、まわりと同じように暗くする
    if (!boxes.length) {
      if (settings.hl === 'dim' || settings.hl === 'dimpen') { g.fillStyle = 'rgba(30,35,45,0.43)'; g.fillRect(0, 0, o.width, o.height); }
      continue;
    }
    const dim = () => {
      g.beginPath(); g.rect(0, 0, o.width, o.height);
      for (const b of boxes) g.rect(b[0], b[1], b[2], b[3]);
      g.fillStyle = 'rgba(30,35,45,0.43)'; g.fill('evenodd');
    };
    if (settings.hl === 'dim') dim();
    else if (settings.hl === 'dimpen') { dim(); g.fillStyle = 'rgba(255,230,0,0.27)'; for (const b of boxes) g.fillRect(...b); }
    else if (settings.hl === 'line') {
      const th = 4 * dpr; g.fillStyle = 'rgba(255,214,0,0.51)';
      for (const b of boxes) {
        if (b[3] > b[2]) g.fillRect(b[0] + pad - th - dpr, b[1] + pad, th, b[3] - 2 * pad);
        else g.fillRect(b[0] + pad, b[1] + b[3] - pad + dpr, b[2] - 2 * pad, th);
      }
    } else {
      g.fillStyle = 'rgba(255,214,0,0.35)'; g.strokeStyle = 'rgba(245,158,11,0.8)'; g.lineWidth = 1.5 * dpr;
      for (const b of boxes) { g.fillRect(...b); g.strokeRect(...b); }
    }
  }
}

// ---------------- 操作 ----------------
function setPlayIcon() { $('btnPlay').textContent = $('fullPlay').textContent = audio.paused ? '▶' : '⏸'; }

// 本文だけを大きく出す（上と下の帯をかくす）。できる端末では、ブラウザの枠も消して画面いっぱいにする
function setFull(on) {
  document.body.classList.toggle('full', on);
  const de = document.documentElement;
  try {
    if (on && !document.fullscreenElement && !document.webkitFullscreenElement) {
      const r = de.requestFullscreen ? de.requestFullscreen() : (de.webkitRequestFullscreen ? de.webkitRequestFullscreen() : null);
      if (r && r.catch) r.catch(() => { });
    } else if (!on && (document.fullscreenElement || document.webkitFullscreenElement)) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    }
  } catch (e) { }
  // ページの大きさが変わるので出し直す（resize のしくみを使う）
  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
}
$('btnFull').onclick = () => { settings.full = true; saveSettings(); setFull(true); };
$('fullExit').onclick = () => { settings.full = false; saveSettings(); setFull(false); };
$('fullPlay').onclick = togglePlay;
// ブラウザの枠の全画面を、ほかの操作（Esc など）でやめたときは、帯ももどす
const onFsChange = () => {
  if (!document.fullscreenElement && !document.webkitFullscreenElement && document.body.classList.contains('full')) { settings.full = false; saveSettings(); setFull(false); }
};
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);
function togglePlay() {
  if (!S.url) return;
  if (audio.paused) { audio.play(); if (S.browsing) update(true); } else audio.pause();
}
function seekTo(s) {
  const d = audio.duration || 0;
  s = Math.max(0, d > 0 ? Math.min(s, d - 0.2) : s);
  audio.currentTime = s;
  update(true, s); updateTime(); savePos(true);
}
const posNow = () => audio.currentTime || 0;
$('btnPlay').onclick = togglePlay;
$('btnBack15').onclick = () => seekTo(posNow() - 15);
$('btnFwd30').onclick = () => seekTo(posNow() + 30);
$('btnPrevS').onclick = () => {
  if (!S.sync) return seekTo(posNow() - 5);
  const i = findItem(posNow());
  if (i >= 0 && posNow() - S.items[i].start > 2) seekTo(S.items[i].start); else if (i > 0) seekTo(S.items[i - 1].start);
};
$('btnNextS').onclick = () => {
  if (!S.sync) return seekTo(posNow() + 5);
  const i = findItem(posNow());
  if (i + 1 < S.items.length) seekTo(S.items[i + 1].start);
};
$('seek').addEventListener('input', () => { seeking = true; const d = audio.duration || 0; $('time').textContent = fmt(d * $('seek').value / 1000) + ' / ' + fmt(d); });
$('seek').addEventListener('change', () => { seeking = false; seekTo((audio.duration || 0) * $('seek').value / 1000); });
$('trackSel').onchange = () => { savePos(true); loadTrack(+$('trackSel').value, 0); };
$('btnBack').onclick = () => { savePos(true); showLibrary(); };
// 縦書きの本は、左が次のページ
$('navPrev').onclick = () => movePage(S.vertical ? 1 : -1);
$('navNext').onclick = () => movePage(S.vertical ? -1 : 1);

audio.addEventListener('play', () => { setPlayIcon(); loop(); });
audio.addEventListener('pause', () => { setPlayIcon(); savePos(true); cancelAnimationFrame(S.raf); });
audio.addEventListener('timeupdate', () => { updateTime(); savePos(false); if (audio.paused) update(false); });
audio.addEventListener('ended', () => {
  // 章ごとの曲は、次の章へ続けて進む
  const t = S.manifest && S.manifest.tracks;
  if (t && t[S.track].kind === 'chapter' && S.track + 1 < t.length && t[S.track + 1].kind === 'chapter') loadTrack(S.track + 1, 0).then(() => audio.play());
});
function loop() {
  cancelAnimationFrame(S.raf);
  const step = () => { if (audio.paused) return; update(false); updateTime(); S.raf = requestAnimationFrame(step); };
  S.raf = requestAnimationFrame(step);
}

// ページをタップ：その文から再生。左右にはらう：ページをめくる
let down = null;
$('stage').addEventListener('pointerdown', (e) => { if (e.target.closest('.nav') || e.target.closest('#fullCtrl')) return; down = { x: e.clientX, y: e.clientY, t: Date.now() }; });
$('stage').addEventListener('pointerup', (e) => {
  if (!down) return;
  const dx = e.clientX - down.x, dy = e.clientY - down.y; down = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    // 縦書き：右へはらうと次のページ（本をめくる向き）
    movePage((dx > 0) === S.vertical ? 1 : -1);
    return;
  }
  if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
  const el = e.target.closest('.page'); if (!el || !S.sync) return;
  const rc = el.getBoundingClientRect();
  const px = (e.clientX - rc.left) / el._css, py = (e.clientY - rc.top) / el._css, pn = +el.dataset.pn;
  let best = -1, bestD = Infinity;
  S.items.forEach((it, i) => {
    for (const r of it.rects || []) {
      if (r[0] !== pn) continue;
      const d = Math.max(0, r[1] - px, px - r[3]) + Math.max(0, r[2] - py, py - r[4]);
      if (d < bestD) { bestD = d; best = i; }
    }
  });
  if (best >= 0 && bestD < 12) { S.browsing = false; seekTo(S.items[best].start); if (audio.paused) audio.play(); }
});
// キーボード（iPad のキーボードやパソコンでためすとき）
document.addEventListener('keydown', (e) => {
  if ($('player').hidden || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') $('btnPrevS').click();
  else if (e.key === 'ArrowRight') $('btnNextS').click();
  else if (e.key === 'PageDown') movePage(1);
  else if (e.key === 'PageUp') movePage(-1);
});
let rsz = 0;
// 向きや大きさが変わったら出し直す（見ているだけのときはそのページ、そうでなければ読んでいる所のページ）
window.addEventListener('resize', () => {
  clearTimeout(rsz);
  rsz = setTimeout(() => {
    if (S.view.start < 0) return;
    const pg = !S.browsing && S.cur >= 0 ? pageAt(S.cur, S.curChar) : S.view.start;
    showPage(pg != null ? pg : S.view.start, S.browsing);
  }, 200);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(true); });

// 設定
$('btnMenu').onclick = () => { $('menu').hidden = false; };
$('btnMenuClose').onclick = () => { $('menu').hidden = true; };
$('menu').addEventListener('click', (e) => { if (e.target.id === 'menu') $('menu').hidden = true; });
$('speedSel').value = settings.speed; $('vol').value = settings.volume; $('volN').textContent = settings.volume + '%';
$('hlSel').value = settings.hl; $('spreadSel').value = settings.spread;
$('speedSel').onchange = () => { settings.speed = $('speedSel').value; audio.playbackRate = parseFloat(settings.speed); saveSettings(); };
$('vol').oninput = () => { settings.volume = +$('vol').value; audio.volume = settings.volume / 100; $('volN').textContent = settings.volume + '%'; saveSettings(); };
$('hlSel').onchange = () => { settings.hl = $('hlSel').value; saveSettings(); drawOverlays(); };
$('spreadSel').onchange = () => { settings.spread = $('spreadSel').value; saveSettings(); if (S.view.start >= 0) showPage(S.view.start); };
const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
$('volNote').hidden = !isApple;

// 画面を消したときやロック画面の操作
function setMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = S.manifest.tracks[S.track];
  const art = S.book.cover ? [{ src: URL.createObjectURL(S.book.cover), sizes: '512x512', type: 'image/jpeg' }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: S.book.author, album: S.book.title, artwork: art });
  const h = {
    play: () => audio.play(), pause: () => audio.pause(),
    seekbackward: () => seekTo(posNow() - 15), seekforward: () => seekTo(posNow() + 30),
    previoustrack: () => $('btnPrevS').click(), nexttrack: () => $('btnNextS').click(),
  };
  for (const k in h) { try { navigator.mediaSession.setActionHandler(k, h[k]); } catch (e) { } }
}

// 試しに使うとき：?src=<ZIP のアドレス> で、その ZIP を取りこむ（パソコンでためす用）
(async () => {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') { try { await navigator.serviceWorker.register('sw.js'); } catch (e) { } }
  const src = new URLSearchParams(location.search).get('src');
  if (src) {
    try {
      $('libHint').textContent = '取りこんでいます…';
      const b = await (await fetch(src)).blob();
      const id = await addBook(new Blob([b], { type: 'application/zip' }), decodeURIComponent(src.split('/').pop()).replace(/\.book\.zip$|\.zip$/i, ''));
      history.replaceState(null, '', location.pathname);
      return openBook(id);
    } catch (e) { alert('取りこめませんでした：' + e.message); }
  }
  showLibrary();
})();
