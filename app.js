const BOOKS = window.__BOOKS__;
let PAGES = [];
let total = 0;
let current = 0;      // page index (0-based), source of truth in portrait mode
let spreads = [];
let spreadIdx = 0;    // spread index, source of truth in landscape mode
let slideCount = 0;   // number of slides in the *current* mode
let index = 0;        // current slide index in the active mode

const pageNumEl = document.getElementById('pageNum');
const pageTotalEl = document.getElementById('pageTotal');
const dotsEl = document.getElementById('dots');
const endCard = document.getElementById('endCard');
const shelfScreen = document.getElementById('shelfScreen');
const readerScreen = document.getElementById('readerScreen');
const shelfBoardBooks = document.getElementById('shelfBoardBooks');
const shelfBoardPhotos = document.getElementById('shelfBoardPhotos');
const shelfFooter = document.getElementById('shelfFooter');
const stageViewport = document.getElementById('stageViewport');
const stageTrack = document.getElementById('stageTrack');
const pageIndicatorBtn = document.getElementById('pageIndicatorBtn');
const pageSliderWrap = document.getElementById('pageSliderWrap');
const pageSlider = document.getElementById('pageSlider');
const jumpModal = document.getElementById('jumpModal');
const jumpInput = document.getElementById('jumpInput');
const jumpCancelBtn = document.getElementById('jumpCancelBtn');
const jumpGoBtn = document.getElementById('jumpGoBtn');
const orientToggleBtn = document.getElementById('orientToggleBtn');
const readerLoading = document.getElementById('readerLoading');

// pages beyond this count also get a drag-slider in addition to tap-to-jump
const SLIDER_PAGE_THRESHOLD = 30;

// manual たて/よこ override, for when the device's own rotation lock is on
let manualLandscape = false;

// ---- resume-from-last-position, per book ----
let currentBookId = null;
const PROGRESS_KEY_PREFIX = 'honnoheya_progress_';
function saveProgress(bookId, pageIdx){
  try{ localStorage.setItem(PROGRESS_KEY_PREFIX + bookId, String(pageIdx)); }catch(err){ /* ignore (e.g. private mode) */ }
}
function loadProgress(bookId, maxIdx){
  try{
    const v = localStorage.getItem(PROGRESS_KEY_PREFIX + bookId);
    if(v == null) return 0;
    const n = parseInt(v, 10);
    if(isNaN(n)) return 0;
    return Math.max(0, Math.min(maxIdx, n));
  }catch(err){ return 0; }
}

function requestAppFullscreen(){
  const el = document.documentElement;
  try{
    if(el.requestFullscreen) el.requestFullscreen().catch(()=>{});
    else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }catch(err){ /* fullscreen not available (e.g. iOS Safari) - ignore */ }
}

// ---- shelves: two permanent shelves split by type (book vs photos) ----
function renderBookCover(book){
  const wrap = document.createElement('div');
  const cover = document.createElement('div');
  cover.className = 'book-cover';
  cover.innerHTML = `<div class="spine"></div><img src="${book.pages[0]}" alt="${book.title}">`;
  cover.addEventListener('click', ()=>{ requestAppFullscreen(); openReader(book.id); });
  const label = document.createElement('div');
  label.className = 'book-label';
  const labelSpan = document.createElement('span');
  labelSpan.textContent = book.title;
  label.appendChild(labelSpan);
  wrap.appendChild(cover);
  wrap.appendChild(label);
  if(book.series){
    const seriesEl = document.createElement('div');
    seriesEl.className = 'book-series';
    seriesEl.textContent = book.series;
    wrap.appendChild(seriesEl);
  }
  return wrap;
}

const bookItems = BOOKS.filter(b => b.type !== 'photos');
const photoItems = BOOKS.filter(b => b.type === 'photos');
bookItems.forEach(b => shelfBoardBooks.appendChild(renderBookCover(b)));
photoItems.forEach(b => shelfBoardPhotos.appendChild(renderBookCover(b)));

shelfFooter.textContent = `v1.7 ・ ぞうちくちゅう ・ えほん${bookItems.length}さつ / アルバム${photoItems.length}さつ`;

// ---- real-book page pairing: front cover alone, back cover alone, everything
// else paired sequentially; a leftover odd middle page pairs with a blank
// filler (null) instead of also being forced standalone. Used for storybooks. ----
function buildSpreads(n){
  if(n <= 1) return [[0]];
  const s = [[0]];
  const last = n-1;
  let i = 1;
  while(i < last){
    if(i+1 < last){ s.push([i, i+1]); i += 2; }
    else { s.push([i, null]); i += 1; }
  }
  s.push([last]);
  return s;
}
function lastRealPage(s){
  for(let i=s.length-1; i>=0; i--){ if(s[i] != null) return s[i]; }
  return s[0];
}
// plain sequential pairing for photo albums: no cover-alone convention, just
// [0,1],[2,3]... with a lone leftover at the end if the count is odd
function buildSpreadsPlain(n){
  const s = [];
  for(let i=0;i<n;i+=2){
    if(i+1<n) s.push([i,i+1]); else s.push([i]);
  }
  return s;
}
function spreadIndexForPage(pageIdx){
  const idx = spreads.findIndex(s => s.includes(pageIdx));
  return idx === -1 ? 0 : idx;
}
function isLandscape(){
  return manualLandscape || window.matchMedia('(orientation: landscape)').matches;
}
function deviceIsNaturallyLandscape(){
  return window.matchMedia('(orientation: landscape)').matches;
}
function updateForceLandscapeVisual(){
  // only need to visually rotate when we're forcing landscape onto a
  // viewport that isn't already landscape-shaped on its own
  const needsRotate = manualLandscape && !deviceIsNaturallyLandscape();
  readerScreen.classList.toggle('force-landscape', needsRotate);
  orientToggleBtn.classList.toggle('active', manualLandscape);
}

let IMG_DIMS = []; // {w,h} per page, preloaded once per book so we can size slides synchronously
function loadImageDims(src){
  return new Promise(resolve=>{
    const img = new Image();
    img.onload = ()=> resolve({w: img.naturalWidth || 1, h: img.naturalHeight || 1});
    img.onerror = ()=> resolve({w:1, h:1});
    img.src = src;
  });
}

// ---- build the slide track for the current orientation mode. Each slide is
// exactly the viewport width (so neighbors never peek in at rest); content
// inside is sized to each image's real aspect ratio and centered ----
function buildSlides(){
  stageTrack.innerHTML = '';
  const landscape = isLandscape();
  const vh = stageHeight();
  const vw = stageWidth();

  if(landscape){
    slideCount = spreads.length;
    spreads.forEach(s=>{
      const slide = document.createElement('div');
      slide.className = 'slide';
      slide.style.width = vw + 'px';
      if(s.length === 2){
        const p0 = s[0], p1 = s[1];
        const realDim = (p0 != null ? IMG_DIMS[p0] : null) || (p1 != null ? IMG_DIMS[p1] : null) || {w:1,h:1};
        const d0 = p0 != null ? (IMG_DIMS[p0] || realDim) : realDim;
        const d1 = p1 != null ? (IMG_DIMS[p1] || realDim) : realDim;
        let w0 = vh * (d0.w / d0.h);
        let w1 = vh * (d1.w / d1.h);
        let pairH = vh;
        let pairW = w0 + w1;
        if(pairW > vw){ const scale = vw / pairW; w0 *= scale; w1 *= scale; pairH *= scale; pairW = vw; }
        const leftContent = p0 != null ? `<img src="${PAGES[p0]}" alt="">` : '';
        const rightContent = p1 != null ? `<img src="${PAGES[p1]}" alt="">` : '';
        slide.innerHTML = `
          <div class="spread-pair" style="width:${pairW}px;height:${pairH}px;">
            <div class="spread-half left" style="width:${w0}px;height:${pairH}px;">${leftContent}</div>
            <div class="spread-half right" style="width:${w1}px;height:${pairH}px;">${rightContent}</div>
          </div>`;
      } else {
        const d0 = IMG_DIMS[s[0]] || {w:1,h:1};
        let w0 = vh * (d0.w / d0.h);
        let h0 = vh;
        if(w0 > vw){ const scale = vw / w0; w0 = vw; h0 *= scale; }
        slide.innerHTML = `
          <div class="spread-pair cover-only" style="width:${w0}px;height:${h0}px;">
            <div class="spread-half right" style="width:${w0}px;height:${h0}px;"><img src="${PAGES[s[0]]}" alt=""></div>
          </div>`;
      }
      stageTrack.appendChild(slide);
    });
  } else {
    slideCount = total;
    PAGES.forEach(src=>{
      const slide = document.createElement('div');
      slide.className = 'slide';
      slide.style.width = vw + 'px';
      slide.innerHTML = `<div class="page-square" style="width:100%;height:100%;"><img src="${src}" alt=""></div>`;
      stageTrack.appendChild(slide);
    });
  }
}

function updateDots(){
  dotsEl.innerHTML = '';
  for(let i=0;i<slideCount;i++){
    const d = document.createElement('div');
    d.className = 'dot' + (i===index ? ' on' : '');
    dotsEl.appendChild(d);
  }
}

function updateIndicator(){
  if(isLandscape()){
    const s = spreads[spreadIdx];
    if(s.length === 2 && s[0] != null && s[1] != null){
      pageNumEl.textContent = `${s[0]+1}-${s[1]+1}`;
    } else {
      pageNumEl.textContent = `${lastRealPage(s)+1}`;
    }
  } else {
    pageNumEl.textContent = current + 1;
  }
  pageTotalEl.textContent = total;
}

function updateSlider(){
  pageSlider.max = Math.max(0, slideCount-1);
  pageSlider.value = index;
  pageSliderWrap.classList.toggle('visible', total > SLIDER_PAGE_THRESHOLD);
}

function syncStateFromIndex(){
  if(isLandscape()){
    spreadIdx = index;
    const s = spreads[spreadIdx];
    current = lastRealPage(s);
  } else {
    current = index;
    spreadIdx = spreadIndexForPage(current);
  }
  updateIndicator();
  updateDots();
  updateSlider();
  endCard.classList.remove('visible');
  if(currentBookId) saveProgress(currentBookId, current);
}

function stageWidth(){
  const w = stageViewport.clientWidth;
  return w > 0 ? w : window.innerWidth;
}
function stageHeight(){
  const h = stageViewport.clientHeight;
  return h > 0 ? h : window.innerHeight;
}
function setTranslate(px, animate){
  stageTrack.style.transition = animate ? 'transform .3s cubic-bezier(.22,1,.36,1)' : 'none';
  stageTrack.style.transform = `translateX(${px}px)`;
}
function goToIndex(newIndex, animate){
  resetZoom();
  newIndex = Math.max(0, Math.min(slideCount-1, newIndex));
  index = newIndex;
  setTranslate(-index*stageWidth(), animate !== false);
  syncStateFromIndex();
}

function applyLayoutMode(){
  const landscape = isLandscape();
  readerScreen.classList.toggle('landscape-mode', landscape);
  readerScreen.classList.toggle('ui-hidden', landscape);
  if(!PAGES.length) return;
  endCard.classList.remove('visible');
  // decide the index to land on in the new mode, carrying over reading position
  let targetPageForLanding = current;
  buildSlides();
  if(isLandscape()){
    index = spreadIndexForPage(targetPageForLanding);
  } else {
    // land on the left/lower page of whatever spread we were viewing
    index = spreads.length ? spreads[spreadIndexForPage(targetPageForLanding)][0] : targetPageForLanding;
  }
  setTranslate(-index*stageWidth(), false);
  syncStateFromIndex();
}

async function openReader(bookId){
  const book = BOOKS.find(b => b.id === bookId);
  currentBookId = bookId;
  PAGES = book.pages;
  total = PAGES.length;
  spreads = book.pageStyle === 'plain' ? buildSpreadsPlain(total) : buildSpreads(total);
  current = loadProgress(bookId, total - 1);
  spreadIdx = spreadIndexForPage(current);
  index = current;
  endCard.classList.remove('visible');
  readerLoading.classList.add('visible');
  IMG_DIMS = await Promise.all(PAGES.map(loadImageDims));
  readerLoading.classList.remove('visible');
  updateForceLandscapeVisual();
  applyLayoutMode();
  shelfScreen.style.opacity = '0';
  setTimeout(()=>{ shelfScreen.style.display='none'; }, 300);
  readerScreen.classList.add('visible');
}
function closeReader(){
  readerScreen.classList.remove('visible');
  shelfScreen.style.display = 'flex';
  requestAnimationFrame(()=>{ shelfScreen.style.opacity = '1'; });
}

function goNext(){
  if(index >= slideCount-1){ endCard.classList.add('visible'); return; }
  goToIndex(index+1);
}
function goPrev(){
  if(index <= 0) return;
  endCard.classList.remove('visible');
  goToIndex(index-1);
}

document.getElementById('closeBtn').addEventListener('click', closeReader);
document.getElementById('backToShelfBtn').addEventListener('click', closeReader);
document.getElementById('restartBtn').addEventListener('click', ()=>{ goToIndex(0); });
orientToggleBtn.addEventListener('click', ()=>{
  manualLandscape = !manualLandscape;
  updateForceLandscapeVisual();
  applyLayoutMode();
});

/* ---------- page jump (tap page number) ---------- */
function openJumpModal(){
  jumpInput.min = 1;
  jumpInput.max = total;
  jumpInput.value = current + 1;
  jumpModal.classList.add('visible');
  setTimeout(()=>{ jumpInput.focus(); jumpInput.select(); }, 50);
}
function closeJumpModal(){
  jumpModal.classList.remove('visible');
}
function doJump(){
  let n = parseInt(jumpInput.value, 10);
  closeJumpModal();
  if(isNaN(n)) return;
  n = Math.max(1, Math.min(total, n));
  const pageIdx = n - 1;
  if(isLandscape()){
    goToIndex(spreadIndexForPage(pageIdx));
  } else {
    goToIndex(pageIdx);
  }
}
pageIndicatorBtn.addEventListener('click', openJumpModal);
jumpCancelBtn.addEventListener('click', closeJumpModal);
jumpGoBtn.addEventListener('click', doJump);
jumpInput.addEventListener('keydown', e=>{
  if(e.key === 'Enter') doJump();
  if(e.key === 'Escape') closeJumpModal();
});
jumpModal.addEventListener('click', e=>{
  if(e.target === jumpModal) closeJumpModal();
});

/* ---------- page slider (long albums) ---------- */
pageSlider.addEventListener('input', e=>{
  goToIndex(parseInt(e.target.value, 10), false);
});

/* ---------- real-time drag-follow swipe, with tap-to-turn and elastic edges ---------- */
let dragging = false;
let dragStartX = 0;
let dragBaseTranslate = 0;
let lastMoveX = 0;
let lastMoveT = 0;
let velocity = 0;
let moved = false;

/* ---------- pinch & double-tap zoom ---------- */
let zoomScale = 1;
let zoomX = 0, zoomY = 0;
let isZoomed = false;
let pinching = false;
let pinchStartDist = 0;
let pinchStartScale = 1;
let panning = false;
let panStartX = 0, panStartY = 0, panStartOffsetX = 0, panStartOffsetY = 0;
let lastTapTime = 0, lastTapX = 0, lastTapY = 0;

function touchDist(t1, t2){
  const dx = t1.clientX - t2.clientX, dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx*dx + dy*dy);
}
function currentSlideEl(){
  return stageTrack.children[index];
}
function applyZoomTransform(animate){
  const el = currentSlideEl();
  if(!el) return;
  el.style.transition = animate ? 'transform .25s ease' : 'none';
  el.style.transform = `scale(${zoomScale}) translate(${zoomX}px, ${zoomY}px)`;
}
function clampPan(){
  const el = currentSlideEl();
  const contentEl = el ? (el.firstElementChild || el) : null;
  const w = contentEl ? contentEl.offsetWidth : stageWidth();
  const h = contentEl ? contentEl.offsetHeight : stageHeight();
  const vw = stageWidth();
  const vh = stageHeight();
  const maxOffsetX = Math.max(0, w/2 - vw/(2*zoomScale));
  const maxOffsetY = Math.max(0, h/2 - vh/(2*zoomScale));
  zoomX = Math.max(-maxOffsetX, Math.min(maxOffsetX, zoomX));
  zoomY = Math.max(-maxOffsetY, Math.min(maxOffsetY, zoomY));
}
function resetZoom(){
  const el = currentSlideEl();
  zoomScale = 1; zoomX = 0; zoomY = 0; isZoomed = false;
  if(el){ el.style.transition = 'transform .25s ease'; el.style.transform = 'scale(1) translate(0px,0px)'; }
}
function toggleZoomAt(){
  if(isZoomed){
    resetZoom();
  } else {
    zoomScale = 2.2; zoomX = 0; zoomY = 0; isZoomed = true;
    applyZoomTransform(true);
  }
}

function currentTranslate(){
  return -index*stageWidth();
}

// when the reader is visually rotated 90deg (manual たて/よこ override on a
// device whose real screen didn't rotate), real touch X/Y need remapping so
// swipes still feel natural relative to what's on screen: a real vertical
// finger movement becomes the page-turn axis, and a real horizontal
// movement becomes the pan axis.
function isRotatedView(){
  return readerScreen.classList.contains('force-landscape');
}
function localSwipeX(clientX, clientY){
  return isRotatedView() ? clientY : clientX;
}
function localPanDelta(dxScreen, dyScreen){
  return isRotatedView() ? { dx: dyScreen, dy: -dxScreen } : { dx: dxScreen, dy: dyScreen };
}

stageViewport.addEventListener('touchstart', e=>{
  if(e.touches.length === 2){
    pinching = true; dragging = false; panning = false;
    pinchStartDist = touchDist(e.touches[0], e.touches[1]);
    pinchStartScale = zoomScale;
    return;
  }
  if(e.touches.length !== 1) return;
  const t = e.touches[0];
  const now = performance.now();

  // double-tap detection
  if(now - lastTapTime < 300 && Math.abs(t.clientX-lastTapX) < 30 && Math.abs(t.clientY-lastTapY) < 30){
    toggleZoomAt();
    lastTapTime = 0;
    return;
  }
  lastTapTime = now; lastTapX = t.clientX; lastTapY = t.clientY;

  if(isZoomed){
    panning = true;
    panStartX = t.clientX; panStartY = t.clientY;
    panStartOffsetX = zoomX; panStartOffsetY = zoomY;
    return;
  }

  dragging = true;
  moved = false;
  dragStartX = localSwipeX(t.clientX, t.clientY);
  lastMoveX = dragStartX;
  lastMoveT = now;
  velocity = 0;
  dragBaseTranslate = currentTranslate();
  stageTrack.style.transition = 'none';
}, {passive:true});

stageViewport.addEventListener('touchmove', e=>{
  if(pinching && e.touches.length === 2){
    const dist = touchDist(e.touches[0], e.touches[1]);
    zoomScale = Math.max(1, Math.min(4, pinchStartScale * (dist / pinchStartDist)));
    isZoomed = zoomScale > 1.05;
    applyZoomTransform(false);
    return;
  }
  if(panning){
    const t = e.touches[0];
    const d = localPanDelta(t.clientX - panStartX, t.clientY - panStartY);
    zoomX = panStartOffsetX + d.dx / zoomScale;
    zoomY = panStartOffsetY + d.dy / zoomScale;
    clampPan();
    applyZoomTransform(false);
    return;
  }
  if(!dragging) return;
  const t = e.touches[0];
  const lx = localSwipeX(t.clientX, t.clientY);
  const dx = lx - dragStartX;
  if(Math.abs(dx) > 6) moved = true;
  const now = performance.now();
  const dt = now - lastMoveT;
  if(dt > 0) velocity = (lx - lastMoveX) / dt;
  lastMoveX = lx;
  lastMoveT = now;

  let effectiveDx = dx;
  if(index === 0 && dx > 0) effectiveDx = 0;
  if(index === slideCount-1 && dx < 0) effectiveDx = 0;
  stageTrack.style.transform = `translateX(${dragBaseTranslate + effectiveDx}px)`;
}, {passive:true});

stageViewport.addEventListener('touchend', e=>{
  if(pinching){
    pinching = false;
    if(zoomScale <= 1.05){ resetZoom(); }
    else { isZoomed = true; applyZoomTransform(true); }
    return;
  }
  if(panning){
    panning = false;
    return;
  }
  if(!dragging) return;
  dragging = false;
  const dx = lastMoveX - dragStartX;

  if(!moved){
    // treat as a tap: left ~40% = prev, right ~40% = next (along whichever
    // real screen axis currently corresponds to the page-turn direction)
    const rect = stageViewport.getBoundingClientRect();
    const ratio = isRotatedView()
      ? (lastMoveX - rect.top) / rect.height
      : (lastMoveX - rect.left) / rect.width;
    if(ratio < 0.4) goPrev();
    else if(ratio > 0.6) goNext();
    else {
      if(isLandscape()) readerScreen.classList.toggle('ui-hidden');
      setTranslate(currentTranslate(), true);
    }
    return;
  }

  const passedThreshold = Math.abs(dx) > stageWidth() * 0.22 || Math.abs(velocity) > 0.5;
  const atStartEdge = index === 0 && dx > 0;
  const atEndEdge = index === slideCount-1 && dx < 0;

  if(atStartEdge || atEndEdge){
    if(atEndEdge) endCard.classList.add('visible');
    setTranslate(currentTranslate(), true); // firmly snap back, no bounce
  } else if(passedThreshold){
    if(dx < 0) goNext(); else goPrev();
  } else {
    setTranslate(currentTranslate(), true);
  }
}, {passive:true});

// keyboard (for desktop preview convenience)
document.addEventListener('keydown', e=>{
  if(!readerScreen.classList.contains('visible')) return;
  if(e.key === 'ArrowRight') goNext();
  if(e.key === 'ArrowLeft') goPrev();
  if(e.key === 'Escape') closeReader();
});

// orientation / resize -> rebuild slides for the new mode, keep reading position
window.addEventListener('resize', ()=>{ updateForceLandscapeVisual(); applyLayoutMode(); });
window.addEventListener('orientationchange', ()=>{ updateForceLandscapeVisual(); applyLayoutMode(); });