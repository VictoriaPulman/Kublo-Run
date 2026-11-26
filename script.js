/* ============================================================================
   KUBLO RUN — бесконечный раннер с археологом Кубло.
   Чистый Vanilla JS + HTML5 Canvas. Никаких внешних библиотек и аудиофайлов.

   Структура файла:
     1. Настройки и служебные функции (хранение, звук, загрузка кадров лица)
     2. Состояние игры и ввод (клавиатура, тач, экранные кнопки)
     3. Игровая логика (физика, генерация препятствий, столкновения)
     4. Отрисовка (фон с параллаксом, мир, герой, интерфейс, заставки)
     5. Главный цикл и запуск
   ============================================================================ */

(() => {
  'use strict';

  /* ------------------------------------------------------------------
     1. НАСТРОЙКИ И СЛУЖЕБНЫЕ ФУНКЦИИ
     ------------------------------------------------------------------ */

  const LOGICAL_H = 420;          // Виртуальная высота поля (ширина считается от пропорций экрана)
  const GROUND_Y = 358;           // Уровень земли в виртуальных координатах
  const HERO_X = 112;             // Герой бежит на месте, мир движется мимо него
  const FACE_RATIO = 171 / 232;   // Точные пропорции исходных фотографий лица
  const GRAVITY = 0.62;           // Гравитация за один игровой кадр (1/60 с)
  const JUMP_V = -10.2;           // Начальная скорость прыжка
  const HOLD_FORCE = -0.36;       // Дополнительная тяга, если зажать клавишу прыжка
  const MAX_HOLD_FRAMES = 11;     // Максимальная длительность «дозажима» прыжка
  const FACE_FRAME_MS = 165;      // Смена кадров лица/шагов (~150–180 мс)

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const assetHint = document.getElementById('assetHint');
  const soundBtn = document.getElementById('soundToggle');
  const btnJump = document.getElementById('btnJump');
  const btnDuck = document.getElementById('btnDuck');
  const touchControls = document.getElementById('touchControls');
  const modalLayer = document.getElementById('modalLayer');
  const btnStart = document.getElementById('btnStart');
  const btnRestart = document.getElementById('btnRestart');

  let W = 1000;       // Виртуальная ширина, пересчитывается при изменении размера окна
  let scaleX = 1, scaleY = 1; // Масштаб виртуальных координат в реальные пиксели Canvas

  // Адаптивный Canvas: рисуем в виртуальных координатах, но с учётом devicePixelRatio,
  // чтобы картинка была чёткой на экранах с повышенной плотностью пикселей.
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    W = Math.round(LOGICAL_H * rect.width / rect.height);
    scaleX = canvas.width / W;
    scaleY = canvas.height / LOGICAL_H;
  }

  // Безопасная работа с localStorage (в приватном режиме доступ может быть запрещён)
  function storeGet(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (e) { return fallback; }
  }
  function storeSet(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (e) { /* игнорируем */ }
  }

  let hi = Number(storeGet('kublo_hi', 0)) || 0;       // Лучший рекорд
  let runs = Number(storeGet('kublo_runs', 0)) || 0;   // Общее число забегов
  let soundOn = storeGet('kublo_sound', '1') !== '0';

  /* --- Звук через Web Audio API: всё синтезируется на лету --- */

  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  // Один тон с плавным изменением частоты и затуханием громкости
  function tone(freq, dur, type = 'square', vol = 0.06, endFreq = freq) {
    if (!soundOn) return;
    ensureAudio();
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // Короткий шум (используется для смешного «бум!» столкновения)
  function noiseBurst(dur, vol) {
    if (!soundOn) return;
    ensureAudio();
    if (!audioCtx) return;
    const len = Math.floor(audioCtx.sampleRate * dur);
    const buffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    gain.gain.value = vol;
    src.buffer = buffer;
    src.connect(gain);
    gain.connect(audioCtx.destination);
    src.start();
  }

  const sfx = {
    jump: () => tone(320, 0.17, 'square', 0.055, 700),
    artifact: () => {
      tone(880, 0.10, 'sine', 0.05, 1300);
      setTimeout(() => tone(1320, 0.14, 'sine', 0.045, 1800), 70);
    },
    milestone: () => {
      tone(660, 0.08, 'triangle', 0.045, 880);
      setTimeout(() => tone(990, 0.12, 'triangle', 0.04, 1200), 80);
    },
    crash: () => {
      noiseBurst(0.36, 0.10);
      tone(190, 0.38, 'sawtooth', 0.07, 55);
    }
  };

  function updateSoundButton() {
    soundBtn.textContent = soundOn ? '🔊' : '🔇';
    soundBtn.setAttribute('aria-label', soundOn ? 'Выключить звук' : 'Включить звук');
  }
  updateSoundButton();
  soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    storeSet('kublo_sound', soundOn ? '1' : '0');
    updateSoundButton();
    if (soundOn) { ensureAudio(); tone(700, 0.08, 'sine', 0.04, 900); }
  });

  /* --- Загрузка двух кадров лица (171×232) с умным fallback --- */

  const faces = { a: null, b: null, mode: 'loading' }; // mode: loading | images | smiley

  // Если есть только первый кадр — делаем второй зеркальным отражением первого.
  function makeMirror(img) {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.translate(c.width, 0);
    g.scale(-1, 1);
    g.drawImage(img, 0, 0);
    return c;
  }

  function loadFaces() {
    const a = new Image();
    const b = new Image();
    let doneA = false, doneB = false;

    function finish() {
      if (!doneA || !doneB) return;
      if (!faces.a) {
        // Ни одного файла: рисуем забавного смайла-заглушку и показываем подсказку.
        faces.mode = 'smiley';
        assetHint.hidden = false;
      } else {
        if (!faces.b) faces.b = makeMirror(faces.a);
        faces.mode = 'images';
        assetHint.hidden = true;
      }
    }

    a.onload = () => { faces.a = a; doneA = true; finish(); };
    a.onerror = () => { doneA = true; finish(); };
    b.onload = () => { faces.b = b; doneB = true; finish(); };
    b.onerror = () => { doneB = true; finish(); };

    // Файлы берутся из той же папки, где лежит эта игра
    a.src = 'kublo1.png';
    b.src = 'kublo2.png';
  }

  /* --- Вспомогательная математика --- */

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smoothstep = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mixColor(c1, c2, t, alpha = 1) {
    const a = hexToRgb(c1), b = hexToRgb(c2);
    return `rgba(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)},${alpha})`;
  }
  // Замена прозрачности у уже готового цвета rgba(...) — нужно для свечения солнца/луны
  function withAlpha(color, alpha) {
    if (color[0] === '#') {
      const [r, g, b] = hexToRgb(color);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    const p = color.replace(/rgba?\(|\)/g, '').split(',');
    return `rgba(${p[0]},${p[1]},${p[2]},${alpha})`;
  }
  function roundedRectPath(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function rankFor(record) {
    if (record < 300) return 'Новичок с киркой';
    if (record < 800) return 'Подмастерье раскопок';
    if (record < 1500) return 'Гроза экскаваторов';
    if (record < 3000) return 'Повелитель скелетов';
    return 'Легенда раскопок';
  }

  /* ------------------------------------------------------------------
     2. СОСТОЯНИЕ ИГРЫ И ВВОД
     ------------------------------------------------------------------ */

  let state = 'start'; // start | run | over
  let score = 0, speed = 6, scroll = 0, gameTime = 0;
  let nextSpawn = 420, shake = 0, overTimer = 0, lastMilestone = 0;
  let obstacles = [], artifacts = [], particles = [], dust = [];

  const hero = {
    y: 0,          // Смещение по вертикали: 0 — на земле, отрицательное — в прыжке
    vy: 0,
    jumpHeld: false,
    holdTime: 0,
    jumpCount: 0,  // Счётчик прыжков: разрешено максимум два до касания земли
    ducking: false,
    faceFrame: 0,
    faceTimer: 0
  };

  // Облака и звёзды создаём один раз, они движутся с разной скоростью (параллакс)
  const clouds = Array.from({ length: 7 }, (_, i) => ({
    x: i * 220 + rand(0, 100), y: rand(35, 130), s: rand(0.6, 1.3), a: rand(0.35, 0.75)
  }));
  const stars = Array.from({ length: 90 }, () => ({
    x: Math.random(), y: Math.random() * 0.65, r: rand(0.5, 1.5), p: rand(0, 6.28)
  }));

  // Синхронизация DOM-слоёв: модальные кнопки поверх Canvas и мобильные кнопки под полем
  function syncUI() {
    const modalOpen = state !== 'run';
    modalLayer.hidden = !modalOpen;
    btnStart.hidden = state !== 'start';
    btnRestart.hidden = state !== 'over';
    // Пока открыт «Старт» или «Раскоп остановлен!», игровые кнопки недоступны
    touchControls.classList.toggle('is-blocked', modalOpen);
    canvas.style.cursor = modalOpen ? 'pointer' : 'default';
  }

  function resetGame() {
    score = 0; speed = 6; scroll = 0;
    obstacles = []; artifacts = []; particles = []; dust = [];
    nextSpawn = 430; shake = 0; overTimer = 0; lastMilestone = 0;
    hero.y = 0; hero.vy = 0; hero.jumpHeld = false; hero.holdTime = 0; hero.jumpCount = 0;
    hero.ducking = false; hero.faceFrame = 0; hero.faceTimer = 0;
    state = 'run';
    syncUI();
  }

  function pressJump() {
    ensureAudio();
    if (state === 'start') { resetGame(); return; }
    if (state === 'over') { if (overTimer > 350) resetGame(); return; }

    // Первый прыжок — с земли, второй — прямо в воздухе (но не больше двух подряд)
    const fromGround = hero.y === 0 && hero.jumpCount === 0;
    const doubleJump = hero.y < 0 && hero.jumpCount < 2;
    if ((fromGround || doubleJump) && !hero.jumpHeld) {
      hero.vy = doubleJump ? JUMP_V * 0.92 : JUMP_V;
      hero.jumpCount++;
      hero.jumpHeld = true;
      hero.holdTime = 0;
      hero.faceFrame = 1;
      if (doubleJump) {
        // Небольшое облачко пыли под сапогами и заметный наклон назад
        for (let i = 0; i < 5; i++) {
          dust.push({
            x: HERO_X + rand(-4, 24), y: GROUND_Y + hero.y + 12,
            vx: rand(-2.2, -0.4), vy: rand(-0.8, 0.4), life: rand(14, 24), r: rand(2, 4)
          });
        }
      }
      sfx.jump();
    }
  }
  function releaseJump() { hero.jumpHeld = false; hero.holdTime = MAX_HOLD_FRAMES; }
  function pressDuck() {
    if (state === 'run' && hero.y < 0) hero.vy += 2.6; // в воздухе — быстрое падение
    hero.ducking = true;
  }
  function releaseDuck() { hero.ducking = false; }

  // Клавиатура: Пробел / ↑ / W — прыжок, ↓ / S — пригнуться
  const JUMP_KEYS = ['Space', 'ArrowUp', 'KeyW'];
  const DUCK_KEYS = ['ArrowDown', 'KeyS'];

  window.addEventListener('keydown', e => {
    if (JUMP_KEYS.includes(e.code) || DUCK_KEYS.includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    if (JUMP_KEYS.includes(e.code)) pressJump();
    if (DUCK_KEYS.includes(e.code)) pressDuck();
  });
  window.addEventListener('keyup', e => {
    if (JUMP_KEYS.includes(e.code)) releaseJump();
    if (DUCK_KEYS.includes(e.code)) releaseDuck();
  });
  window.addEventListener('blur', () => { releaseJump(); releaseDuck(); });

  // Полностью отключаем контекстное меню: долгое нажатие на телефоне не должно мешать игре
  document.getElementById('gameWrap').addEventListener('contextmenu', e => e.preventDefault());

  // Тач по полю: левая половина — прыжок, правая — пригнуться (в том числе свайп вниз).
  // Пока открыты «Старт» или Game Over, Canvas НЕ перехватывает касания:
  // их обрабатывает прозрачный слой с кнопкой поверх Canvas.
  canvas.addEventListener('touchstart', e => {
    if (state !== 'run') return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.touches[0].clientX - rect.left;
    if (x < rect.width / 2) pressJump(); else pressDuck();
  }, { passive: false });
  canvas.addEventListener('touchend', e => {
    if (state !== 'run') return;
    e.preventDefault();
    releaseJump(); releaseDuck();
  }, { passive: false });
  canvas.addEventListener('touchcancel', () => { releaseJump(); releaseDuck(); });

  // Экранные кнопки работают и мышью, и пальцем; во время модалки заблокированы
  function bindTouchButton(el, onDown, onUp) {
    el.addEventListener('pointerdown', e => {
      if (state !== 'run') return;
      e.preventDefault(); el.classList.add('is-pressed'); onDown();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => {
      el.addEventListener(type, e => { e.preventDefault(); el.classList.remove('is-pressed'); onUp(); });
    });
  }
  bindTouchButton(btnJump, pressJump, releaseJump);
  bindTouchButton(btnDuck, pressDuck, releaseDuck);

  // «Старт» и «Бежать снова»: мгновенный отклик на touchend/click без системной задержки
  let lastModalTouchEnd = -Infinity;
  function modalRestart(e) {
    const now = performance.now();
    if (e.type === 'touchend') {
      e.preventDefault();
      lastModalTouchEnd = now; // реагируем сразу на отпускание пальца
    } else if (now - lastModalTouchEnd < 400) {
      return; // игнорируем дублирующий click, который браузер посылает после touchend
    }
    if (state === 'start' || state === 'over') {
      ensureAudio();
      resetGame(); // перезапуск сразу, без игрового кулдауна
    }
  }
  [btnStart, btnRestart].forEach(btn => {
    btn.addEventListener('touchend', modalRestart, { passive: false });
    btn.addEventListener('click', modalRestart);
  });

  // Клик по полю мышью (тач обработан выше)
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') return;
    if (state !== 'run') pressJump();
  });

  /* ------------------------------------------------------------------
     3. ИГРОВАЯ ЛОГИКА
     ------------------------------------------------------------------ */

  // Палитры времени суток: день → закат → ночь → снова день
  const PALETTES = [
    { top: '#74c9f4', bottom: '#f7e0a8', sun: '#fff3a8', sunY: 85, night: 0,
      duneFar: '#e7be78', duneNear: '#cf9b53', ruin: '#a87946', ground: '#caa06a', line: '#8c6538', text: '#33261a' },
    { top: '#614280', bottom: '#f4a267', sun: '#ffd07a', sunY: 252, night: 0.22,
      duneFar: '#a46a68', duneNear: '#7c4a50', ruin: '#613848', ground: '#916257', line: '#5b3c34', text: '#fff0d8' },
    { top: '#101a38', bottom: '#40506f', sun: '#e6eeff', sunY: 78, night: 1,
      duneFar: '#303b5e', duneNear: '#242e49', ruin: '#19213a', ground: '#3b435a', line: '#232b40', text: '#eaf0ff' }
  ];

  // Плавный переход между соседними палитрами каждые 850 очков
  function currentLook() {
    const band = 850;
    const idx = Math.floor(score / band) % 3;
    const local = score % band;
    const nextIdx = (idx + 1) % 3;
    const t = local > band - 130 ? smoothstep((local - (band - 130)) / 130) : 0;
    const a = PALETTES[idx], b = PALETTES[nextIdx];
    const lerp = key => mixColor(a[key], b[key], t);
    return {
      top: lerp('top'), bottom: lerp('bottom'), sun: lerp('sun'),
      sunY: a.sunY + (b.sunY - a.sunY) * t,
      night: a.night + (b.night - a.night) * t,
      duneFar: lerp('duneFar'), duneNear: lerp('duneNear'), ruin: lerp('ruin'),
      ground: lerp('ground'), line: lerp('line'), text: lerp('text')
    };
  }

  function spawnObstacle() {
    const r = Math.random();
    let type;
    if (score >= 300 && r < 0.20) type = 'ptero';
    else if (score >= 120 && r < 0.40) type = 'excavator';
    else if (r < 0.61) type = 'skeletonBig';
    else if (r < 0.78) type = 'skeletonGroup';
    else type = 'skeletonSmall';

    if (type === 'ptero') {
      // Только один уровень полёта: на уровне головы и верхней части туловища стоящего Кубло.
      // Нижний край = GROUND_Y - 124. Стоя хитбокс пересекается гарантированно,
      // а при пригибании (верх хитбокса GROUND_Y - 72) птица пролетает над головой с запасом.
      const h = 38, w = 66;
      const bottom = GROUND_Y - 124;
      obstacles.push({ type, x: W + 60, w, h, baseY: bottom - h, phase: rand(0, 6.28) });
    } else {
      const defs = {
        skeletonSmall: { w: 46, h: 38 },
        skeletonBig:   { w: 70, h: 76 },
        skeletonGroup: { w: 116, h: 62 },
        excavator:     { w: 142, h: 106 }
      };
      const d = defs[type];
      obstacles.push({ type, x: W + 40, w: d.w, h: d.h, baseY: GROUND_Y - d.h, phase: rand(0, 6.28) });
    }
  }

  function spawnArtifact() {
    artifacts.push({
      x: W + 30,
      y: GROUND_Y - rand(105, 170),
      phase: rand(0, 6.28),
      got: false
    });
  }

  // Хитбокс героя: при пригибании высота уменьшается ровно вдвое (146 → 72),
  // поэтому под птицей среднего эшелона можно пробежать 100% безопасно.
  function heroBox() {
    const feet = GROUND_Y + hero.y;
    if (hero.ducking && hero.y === 0) return { x: HERO_X + 2, y: feet - 72, w: 44, h: 72 };
    return { x: HERO_X + 8, y: feet - 148, w: 32, h: 146 };
  }
  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function gameOver() {
    state = 'over';
    overTimer = 0;
    shake = 13;
    hero.faceFrame = 1;       // при столкновении всегда второй кадр
    hero.jumpHeld = false;
    runs += 1;
    storeSet('kublo_runs', runs);
    if (score > hi) { hi = Math.floor(score); storeSet('kublo_hi', hi); }
    sfx.crash();
    syncUI();
  }

  function addFloatingText(text, x, y, color) {
    particles.push({ text, x, y, color, life: 70 });
  }

  // Один фиксированный шаг игры = 1/60 секунды
  function update() {
    gameTime += 16.6667;

    // Фон движется даже на заставке и после проигрыша, но медленнее
    const ambientSpeed = state === 'run' ? speed : 2;
    scroll += ambientSpeed;
    clouds.forEach(c => {
      c.x -= ambientSpeed * 0.13;
      if (c.x < -180) { c.x = W + rand(60, 260); c.y = rand(35, 130); }
    });

    if (state === 'over') {
      overTimer += 16.6667;
      shake *= 0.88;
      if (shake < 0.15) shake = 0;
    }

    // Смена кадров лица на заставке (ритмичное «оживление» портрета)
    if (state === 'start') {
      hero.faceTimer += 16.6667;
      if (hero.faceTimer >= 430) { hero.faceTimer = 0; hero.faceFrame ^= 1; }
    }

    if (state !== 'run') {
      updateParticles();
      return;
    }

    /* --- Дистанция, скорость и нарастание сложности --- */
    score += speed * 0.028; // примерно 10 метров в секунду на старте
    speed = Math.min(6 + score * 0.012, 17);

    const milestone = Math.floor(score / 100);
    if (milestone > lastMilestone) {
      lastMilestone = milestone;
      sfx.milestone();
      addFloatingText(`${milestone * 100} м!`, HERO_X + 60, GROUND_Y - 165, '#fff3b0');
    }

    /* --- Физика прыжка: чем дольше зажата клавиша, тем выше прыжок --- */
    if (hero.y < 0 || hero.vy < 0) {
      if (hero.jumpHeld && hero.vy < 0 && hero.holdTime < MAX_HOLD_FRAMES) {
        hero.vy += HOLD_FORCE;
        hero.holdTime++;
      }
      hero.vy += GRAVITY;
      hero.y += hero.vy;
      if (hero.y >= 0) {
        hero.y = 0; hero.vy = 0; hero.jumpHeld = false;
        hero.jumpCount = 0; // приземлились — снова доступны два прыжка
      }
    }

    // Кадры лица переключаются синхронно с шагами
    hero.faceTimer += 16.6667;
    if (hero.faceTimer >= FACE_FRAME_MS) {
      hero.faceTimer = 0;
      hero.faceFrame ^= 1;
    }
    if (hero.y < 0) hero.faceFrame = 1; // в прыжке — второй кадр

    /* --- Генерация препятствий с честным интервалом для приземления --- */
    nextSpawn -= speed;
    if (nextSpawn <= 0) {
      spawnObstacle();
      // Зазор растёт вместе со скоростью: всегда хватает места, чтобы перепрыгнуть
      nextSpawn = Math.max(340, speed * 48) + rand(150, 280);
      if (Math.random() < 0.34) spawnArtifact();
    }

    obstacles.forEach(o => { o.x -= speed; });
    artifacts.forEach(a => { a.x -= speed; });
    obstacles = obstacles.filter(o => o.x + o.w > -60);
    artifacts = artifacts.filter(a => a.x > -60);

    /* --- Столкновения --- */
    const hb = heroBox();
    for (const o of obstacles) {
      // У каждого препятствия своя «честная» зона попадания, чтобы не цеплять пустоту над ковшом
      let box;
      if (o.type === 'excavator') box = { x: o.x + 12, y: o.baseY + 30, w: o.w - 18, h: o.h - 32 };
      else if (o.type === 'ptero') box = { x: o.x + 9, y: o.baseY + 6, w: o.w - 18, h: o.h - 12 };
      else box = { x: o.x + 5, y: o.baseY + 4, w: o.w - 10, h: o.h - 6 };
      if (overlaps(hb, box)) { gameOver(); break; }
    }
    if (state === 'run') {
      for (const a of artifacts) {
        // Артефакт подбирается, если он рядом с телом/головой (в прыжке — выше)
        if (Math.abs(a.x - (HERO_X + 20)) < 32 && a.y > hb.y - 18 && a.y < hb.y + hb.h) {
          a.got = true;
          score += 50;
          sfx.artifact();
          addFloatingText('+50', a.x, a.y - 10, '#ffe066');
        }
      }
      artifacts = artifacts.filter(a => !a.got);
    }

    /* --- Пыль из-под сапог --- */
    if (hero.y === 0 && Math.random() < 0.35) {
      dust.push({ x: HERO_X + rand(-6, 18), y: GROUND_Y - rand(0, 5), vx: -rand(1, 3), vy: -rand(0.2, 1.1), life: rand(14, 26), r: rand(1.5, 3.5) });
    }
    dust.forEach(p => { p.x += p.vx; p.y += p.vy; p.life--; });
    dust = dust.filter(p => p.life > 0);
    updateParticles();
  }

  function updateParticles() {
    particles.forEach(p => { p.y -= 0.55; p.life--; });
    particles = particles.filter(p => p.life > 0);
  }

  /* ------------------------------------------------------------------
     4. ОТРИСОВКА
     ------------------------------------------------------------------ */

  // Голова выводится прямо через drawImage: никаких масок, клипов и овальных рамок.
  // Пропорции 171×232 сохраняются (w / h = FACE_RATIO), прозрачный фон фото
  // садится прямо на шею нарисованного тела.
  function drawFace(frame, cx, cy, w, h, tilt = 0) {
    const img = (frame === 0 ? faces.a : faces.b);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(tilt);

    if ((faces.mode === 'images' || faces.mode === 'loading') && img) {
      // Прямая отрисовка картинки без обрезки: источник уже имеет нужное соотношение сторон
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      // Заглушка: два выражения забавного смайла-археолога (тоже без маски)
      ctx.save();
      ctx.scale(w / 100, h / 100);
      ctx.fillStyle = '#f2c68c';
      ctx.fillRect(-50, -50, 100, 100);
      ctx.fillStyle = '#8c5a2b'; // «волосы» / край шляпы
      ctx.fillRect(-50, -50, 100, 13);
      ctx.fillStyle = '#2b1f16';
      if (frame === 0) {
        ctx.beginPath(); ctx.arc(-19, -8, 5, 0, 6.3); ctx.arc(19, -8, 5, 0, 6.3); ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = '#2b1f16';
        ctx.beginPath(); ctx.arc(0, 8, 20, 0.15, Math.PI - 0.15); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(-19, -8, 6, 0, 6.3); ctx.arc(19, -8, 6, 0, 6.3); ctx.fill();
        ctx.beginPath(); ctx.ellipse(0, 12, 10, 14, 0, 0, 6.3); ctx.fill();
      }
      ctx.fillStyle = 'rgba(220,110,80,0.35)';
      ctx.beginPath(); ctx.arc(-32, 10, 8, 0, 6.3); ctx.arc(32, 10, 8, 0, 6.3); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawBackground(look) {
    const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    sky.addColorStop(0, look.top);
    sky.addColorStop(1, look.bottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, GROUND_Y);

    // Звёзды проявляются только ночью
    if (look.night > 0.02) {
      stars.forEach((s, i) => {
        const a = look.night * (0.45 + 0.55 * Math.sin(gameTime / 420 + s.p));
        ctx.fillStyle = `rgba(255,255,255,${clamp(a, 0, 1)})`;
        ctx.beginPath();
        ctx.arc(s.x * W, s.y * GROUND_Y, s.r, 0, 6.283);
        ctx.fill();
      });
    }

    // Солнце / луна: днём высоко, на закате у горизонта
    const sx = W * 0.79, sy = look.sunY;
    const glow = ctx.createRadialGradient(sx, sy, 2, sx, sy, 78);
    glow.addColorStop(0, withAlpha(look.sun, 0.55));
    glow.addColorStop(1, withAlpha(look.sun, 0));
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(sx, sy, 78, 0, 6.283); ctx.fill();
    ctx.fillStyle = look.sun;
    ctx.beginPath(); ctx.arc(sx, sy, 27, 0, 6.283); ctx.fill();
    if (look.night > 0.4) {
      // Кратеры луны
      ctx.fillStyle = `rgba(120,135,165,${look.night * 0.35})`;
      ctx.beginPath(); ctx.arc(sx - 8, sy - 6, 6, 0, 6.283); ctx.arc(sx + 9, sy + 7, 4, 0, 6.283); ctx.fill();
    }

    // Облака плывут медленнее земли (параллакс)
    clouds.forEach(c => {
      const x = ((c.x % (W + 300)) + W + 300) % (W + 300) - 120;
      ctx.fillStyle = `rgba(255,255,255,${c.a * (1 - look.night * 0.55)})`;
      ctx.beginPath();
      ctx.ellipse(x, c.y, 42 * c.s, 13 * c.s, 0, 0, 6.283);
      ctx.ellipse(x + 27 * c.s, c.y - 7 * c.s, 30 * c.s, 15 * c.s, 0, 0, 6.283);
      ctx.ellipse(x - 27 * c.s, c.y + 2 * c.s, 25 * c.s, 11 * c.s, 0, 0, 6.283);
      ctx.fill();
    });

    // Две полосы барханов с разной скоростью смещения
    function duneLayer(offset, color, base, amp, freq) {
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y);
      for (let x = 0; x <= W + 12; x += 12) {
        const y = base + Math.sin((x + offset) / freq) * amp + Math.sin((x + offset) / (freq * 0.41)) * amp * 0.3;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, GROUND_Y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
    duneLayer(scroll * 0.18, look.duneFar, GROUND_Y - 96, 30, 130);
    duneLayer(scroll * 0.38, look.duneNear, GROUND_Y - 48, 22, 92);

    // Силуэты древних руин на среднем плане
    const period = 430;
    const shift = (scroll * 0.45) % period;
    for (let i = -1; i < Math.ceil(W / period) + 1; i++) {
      const x = i * period - shift + (i % 2 ? 90 : 0);
      const y = GROUND_Y - 52;
      ctx.fillStyle = look.ruin;
      ctx.fillRect(x, y - 44, 14, 44);
      ctx.fillRect(x + 30, y - 62, 14, 62);
      ctx.fillRect(x + 60, y - 44, 14, 44);
      ctx.fillRect(x - 4, y - 70, 92, 9);              // перекрытие колонн
      ctx.beginPath();                                 // фронтон «храма»
      ctx.moveTo(x - 8, y - 70); ctx.lineTo(x + 44, y - 94); ctx.lineTo(x + 96, y - 70);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(x, y - 2, 92, 4);
    }
  }

  function drawGround(look) {
    ctx.fillStyle = look.ground;
    ctx.fillRect(0, GROUND_Y, W, LOGICAL_H - GROUND_Y);
    ctx.fillStyle = look.line;
    ctx.fillRect(0, GROUND_Y, W, 3);

    // Песок, камешки и следы раскопок — повторяющаяся текстура, движущаяся вместе с землёй
    const tile = 140;
    for (let i = -1; i < Math.ceil(W / tile) + 1; i++) {
      const base = i * tile - (scroll % tile);
      ctx.fillStyle = 'rgba(90,60,30,0.13)';
      for (let j = 0; j < 3; j++) {
        const px = base + 18 + j * 46;
        const py = GROUND_Y + 12 + (j * 17) % 44;
        ctx.beginPath(); ctx.ellipse(px, py, 3 + j, 1.6, 0, 0, 6.283); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(80,55,28,0.16)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(base + 78, GROUND_Y + 20); ctx.lineTo(base + 92, GROUND_Y + 30);
      ctx.moveTo(base + 92, GROUND_Y + 20); ctx.lineTo(base + 78, GROUND_Y + 30);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,240,200,0.14)';
      ctx.fillRect(base + 30, GROUND_Y + 43, 38, 2);
    }

    // Пыль из-под сапог
    dust.forEach(p => {
      ctx.fillStyle = `rgba(240,215,160,${clamp(p.life / 26, 0, 0.55)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
    });
  }

  function drawHero() {
    const airborne = hero.y < 0;
    const feet = GROUND_Y + hero.y;
    const duck = hero.ducking && !airborne;
    const phase = gameTime * Math.PI / FACE_FRAME_MS; // один шаг = пол цикла смены кадра
    const swing = airborne ? 3 : Math.sin(phase) * 9;
    // В приседе корпус и голова прижимаются к земле, хитбокс становится вдвое ниже
    const shoulderY = duck ? feet - 44 : feet - 84;
    const hipY = duck ? feet - 16 : feet - 28;

    ctx.save();
    if (state === 'over' && shake > 0) ctx.translate(rand(-shake, shake) * 0.35, rand(-shake, shake) * 0.25);

    // Ноги с анимацией перебирания и тяжёлыми сапогами
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#4a3524';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(HERO_X - 5, hipY);
    ctx.lineTo(HERO_X - 8 - swing * 0.4, hipY + 13);
    ctx.lineTo(HERO_X - 7 - swing, feet - 4);
    ctx.moveTo(HERO_X + 5, hipY);
    ctx.lineTo(HERO_X + 8 + swing * 0.4, hipY + 13);
    ctx.lineTo(HERO_X + 7 + swing, feet - 4);
    ctx.stroke();
    ctx.fillStyle = '#332318';
    ctx.fillRect(HERO_X - 18 - swing, feet - 6, 17, 6);
    ctx.fillRect(HERO_X + 2 + swing, feet - 6, 17, 6);

    // Кирка наперевес: сбоку от тела, под углом ~30–45° вверх и вперёд.
    const handX = HERO_X + (duck ? 14 : 12);
    const handY = shoulderY + (duck ? 8 : 14);
    const angle = (duck ? -0.45 : -0.72) + (airborne ? 0 : Math.sin(phase) * 0.04);
    const handleLen = 38; // прямой деревянный прямоугольник 38×5
    ctx.save();
    ctx.translate(handX, handY);
    ctx.rotate(angle);

    // Деревянная рукоять: ровный прямоугольник с тёмной обводкой
    ctx.fillStyle = '#8a5a2f';
    ctx.strokeStyle = '#3b2717';
    ctx.lineWidth = 1.4;
    ctx.fillRect(0, -2.5, handleLen, 5);
    ctx.strokeRect(0, -2.5, handleLen, 5);
    ctx.fillStyle = '#b98448'; // светлая кромка дерева
    ctx.fillRect(2, -1.5, handleLen - 4, 1);
    ctx.strokeStyle = '#4a301b'; // кожаная обмотка у хвата
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(4 + i * 4, -2.5); ctx.lineTo(6 + i * 4, 2.5);
      ctx.stroke();
    }

    // Обух: прямоугольная втулка 8×8 строго перпендикулярно рукояти
    ctx.fillStyle = '#555e63';
    ctx.strokeStyle = '#2b3337';
    ctx.lineWidth = 1.2;
    ctx.fillRect(handleLen - 4, -4, 8, 8);
    ctx.strokeRect(handleLen - 4, -4, 8, 8);

    // Два симметричных острых клина: вверх-назад и вниз-вперёд.
    // Кончики слегка загнуты к игроку (к рукояти), а не наружу.
    function pickTooth(dir) {
      ctx.fillStyle = '#aeb7bb';
      ctx.strokeStyle = '#2b3337';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(handleLen - 4, dir * 3);
      ctx.lineTo(handleLen + 4, dir * 3);
      ctx.quadraticCurveTo(handleLen + 3, dir * 11, handleLen - 1, dir * 16);
      ctx.lineTo(handleLen - 6, dir * 18); // острый кончик, загнут назад к рукояти
      ctx.quadraticCurveTo(handleLen - 6, dir * 9, handleLen - 4, dir * 3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Светло-серый блик по внешнему краю лезвия
      ctx.strokeStyle = '#e8eef0';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(handleLen + 3, dir * 5);
      ctx.quadraticCurveTo(handleLen + 2, dir * 11, handleLen - 4, dir * 15);
      ctx.stroke();
    }
    pickTooth(-1);
    pickTooth(1);
    ctx.restore();

    // Точка второй руки на середине рукояти (в мировых координатах)
    const gripX = handX + Math.cos(angle) * 19;
    const gripY = handY + Math.sin(angle) * 19;

    // Туловище, жилетка, ремень и сумка archeologist'а
    ctx.fillStyle = '#d8bb83';                     // рубашка
    ctx.beginPath();
    ctx.moveTo(HERO_X - 14, shoulderY);
    ctx.lineTo(HERO_X + 14, shoulderY);
    ctx.lineTo(HERO_X + 16, hipY + 3);
    ctx.lineTo(HERO_X - 16, hipY + 3);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#7c4c27';                     // жилет
    ctx.beginPath();
    ctx.moveTo(HERO_X - 13, shoulderY + 2);
    ctx.lineTo(HERO_X - 3, shoulderY + 2);
    ctx.lineTo(HERO_X - 5, hipY + 1);
    ctx.lineTo(HERO_X - 15, hipY + 1);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(HERO_X + 3, shoulderY + 2);
    ctx.lineTo(HERO_X + 13, shoulderY + 2);
    ctx.lineTo(HERO_X + 15, hipY + 1);
    ctx.lineTo(HERO_X + 5, hipY + 1);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#5b3820';                   // ремень через плечо
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(HERO_X - 11, shoulderY + 4); ctx.lineTo(HERO_X + 13, hipY); ctx.stroke();
    ctx.fillStyle = '#a9743b';                     // сумка для находок
    ctx.fillRect(HERO_X + 9, hipY - 4, 13, 12);
    ctx.fillStyle = '#4b3320';
    ctx.fillRect(HERO_X - 16, hipY, 33, 5);

    // Две руки держат рукоять сбоку от тела: одна у хвата, вторая чуть вперёд
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#c9a976';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(HERO_X + 7, shoulderY + 11);
    ctx.lineTo(gripX, gripY);
    ctx.stroke();
    ctx.strokeStyle = '#d8bb83';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(HERO_X + 10, shoulderY + 8);
    ctx.lineTo(handX, handY);
    ctx.stroke();
    // Кисти с тёмной обводкой
    ctx.fillStyle = '#e8c99a';
    ctx.strokeStyle = '#8a6537';
    ctx.lineWidth = 1.2;
    [[handX, handY], [gripX, gripY]].forEach(([px, py]) => {
      ctx.beginPath(); ctx.arc(px, py, 4.2, 0, 6.283); ctx.fill(); ctx.stroke();
    });

    // Голова: точные пропорции 171×232, в прыжке — лёгкий наклон назад
    const headW = 46, headH = 46 / FACE_RATIO;
    const bob = airborne || duck ? 0 : Math.abs(Math.sin(phase)) * 2 - 1;
    const headY = (duck ? feet - 46 : feet - 116) + bob;
    // Второй прыжок — с заметным наклоном назад
    const tilt = state === 'over' ? -0.30
      : hero.jumpCount === 2 ? -0.30
      : airborne ? -0.16 : Math.sin(phase) * 0.035;
    drawFace(hero.faceFrame, HERO_X + 2, headY, headW, headH, tilt);
    ctx.restore();
  }

  // Окаменелости динозавров: слоновая кость + тёмная обводка для контраста на песке.
  function drawSkeleton(o, kind) {
    const x = o.x, y = o.baseY;
    const bone = '#f2e5c8', dark = '#4b3826';

    // Кость с тёмным контуром: сначала обводка, потом светлая внутренняя линия
    function limb(x1, y1, x2, y2, width) {
      ctx.lineCap = 'round';
      ctx.strokeStyle = dark;
      ctx.lineWidth = width + 2.4;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.strokeStyle = bone;
      ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    // Отдельный позвонок
    function vert(cx, cy, r) {
      ctx.fillStyle = bone;
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.7, 0, 0, 6.283); ctx.fill(); ctx.stroke();
    }
    // Дугообразное ребро
    function rib(cx, cy, rx, ry) {
      ctx.strokeStyle = dark; ctx.lineWidth = 5.2;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, Math.PI * 1.02, Math.PI * 1.98); ctx.stroke();
      ctx.strokeStyle = bone; ctx.lineWidth = 3.2;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, Math.PI * 1.02, Math.PI * 1.98); ctx.stroke();
    }
    // Коготь на конце лапы
    function claw(px, py, dir) {
      ctx.fillStyle = bone;
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(px, py); ctx.lineTo(px + dir * 7, py + 1); ctx.lineTo(px, py + 4);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }

    // Хищный череп в профиль с глазницей, ноздрёй и острыми зубами
    function raptorSkull(sx, sy, s) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(s, s);
      ctx.fillStyle = bone;
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.quadraticCurveTo(9, -10, 17, -8);
      ctx.lineTo(27, -4); ctx.lineTo(31, -1); ctx.lineTo(27, 2);
      ctx.lineTo(12, 4); ctx.quadraticCurveTo(3, 8, 0, 6);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(2, 7); ctx.lineTo(27, 5); ctx.lineTo(23, 10); ctx.lineTo(3, 12);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = dark;
      ctx.beginPath(); ctx.arc(8, -2, 3.2, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.arc(23, -3, 1.3, 0, 6.283); ctx.fill();
      ctx.fillStyle = bone;
      for (let i = 0; i < 5; i++) {
        const tx = 12 + i * 3;
        ctx.beginPath(); ctx.moveTo(tx, 3); ctx.lineTo(tx + 1.4, 6.5); ctx.lineTo(tx + 3, 3);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    // Крупный череп тираннозавра с открытой зубастой пастью
    function trexSkull(sx, sy, s) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(s, s);
      ctx.fillStyle = bone;
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.quadraticCurveTo(14, -14, 29, -10);
      ctx.lineTo(50, -4); ctx.lineTo(55, 0); ctx.lineTo(50, 5);
      ctx.lineTo(30, 8); ctx.quadraticCurveTo(10, 11, 2, 6);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(3, 11); ctx.lineTo(49, 15); ctx.lineTo(43, 20); ctx.lineTo(6, 18);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = dark;
      ctx.beginPath(); ctx.arc(15, -4, 5, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.arc(44, -2, 1.8, 0, 6.283); ctx.fill();
      ctx.fillStyle = bone;
      for (let i = 0; i < 7; i++) {
        const tx = 20 + i * 4;
        ctx.beginPath(); ctx.moveTo(tx, 7); ctx.lineTo(tx + 1.6, 12); ctx.lineTo(tx + 3.4, 7);
        ctx.closePath(); ctx.fill();
      }
      for (let i = 0; i < 5; i++) {
        const tx = 25 + i * 4;
        ctx.beginPath(); ctx.moveTo(tx, 15); ctx.lineTo(tx + 1.6, 11); ctx.lineTo(tx + 3.4, 15);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    if (kind === 'small') {
      // Раптор в профиль: хвост из позвонков, дуги рёбер, лапы с когтями, хищный череп
      const tail = [[x + 3, y + 33], [x + 7, y + 29], [x + 11, y + 25], [x + 15, y + 22], [x + 20, y + 20]];
      for (let i = 0; i < tail.length - 1; i++) {
        limb(tail[i][0], tail[i][1], tail[i + 1][0], tail[i + 1][1], 3.4 - i * 0.35);
        vert(tail[i][0], tail[i][1], 2.6 - i * 0.2);
      }
      limb(x + 20, y + 20, x + 33, y + 17, 3.2);
      vert(x + 28, y + 18, 3);
      rib(x + 24, y + 22, 5, 8);
      rib(x + 28, y + 22, 5, 8);
      rib(x + 32, y + 21, 4.5, 7);
      limb(x + 22, y + 22, x + 18, y + 29, 3.6);
      limb(x + 18, y + 29, x + 14, y + 36, 3.2);
      claw(x + 14, y + 36, -1);
      limb(x + 30, y + 20, x + 33, y + 28, 3.6);
      limb(x + 33, y + 28, x + 38, y + 36, 3.2);
      claw(x + 38, y + 36, 1);
      raptorSkull(x + 14, y + 8, 0.85);
    } else if (kind === 'big') {
      // Брахиозавр: хвост, грудная клетка, длинная шея из позвонков и маленькая голова наверху
      limb(x + 24, y + 57, x + 14, y + 64, 4);
      limb(x + 14, y + 64, x + 4, y + 68, 3.2);
      vert(x + 14, y + 64, 3);
      vert(x + 7, y + 67, 2.6);
      for (let i = 0; i < 5; i++) {
        const px = x + 20 + i * 7;
        vert(px, y + 56 - i * 0.3, 3.2);
        if (i < 4) limb(px, y + 56 - i * 0.3, px + 7, y + 56 - (i + 1) * 0.3, 3.2);
      }
      for (let i = 0; i < 4; i++) rib(x + 26 + i * 7, y + 58, 7, 12);
      limb(x + 24, y + 58, x + 20, y + 70, 5);
      limb(x + 20, y + 70, x + 18, y + 75, 4);
      claw(x + 18, y + 75, -1);
      limb(x + 47, y + 55, x + 49, y + 70, 5);
      limb(x + 49, y + 70, x + 52, y + 75, 4);
      claw(x + 52, y + 75, 1);
      const neck = [[x + 50, y + 55], [x + 53, y + 43], [x + 55, y + 31], [x + 56, y + 20], [x + 57, y + 12]];
      for (let i = 0; i < neck.length - 1; i++) {
        limb(neck[i][0], neck[i][1], neck[i + 1][0], neck[i + 1][1], 3.5 - i * 0.3);
        vert(neck[i][0], neck[i][1], 3.2 - i * 0.3);
      }
      ctx.fillStyle = bone;
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.ellipse(x + 58, y + 10, 9, 5.5, 0, 0, 6.283); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + 64, y + 9); ctx.lineTo(x + 70, y + 11); ctx.lineTo(x + 64, y + 13);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = dark;
      ctx.beginPath(); ctx.arc(x + 56, y + 9, 2, 0, 6.283); ctx.fill();
    } else {
      // Композиция: огромный череп тираннозавра, рёбра, хвост и череп второго динозавра
      trexSkull(x + 5, y + 10, 1);
      for (let i = 0; i < 6; i++) {
        const px = x + 60 + i * 9;
        vert(px, y + 30 + i * 2, 3.2 - i * 0.2);
        if (i < 5) limb(px, y + 30 + i * 2, px + 9, y + 32 + i * 2, 3);
      }
      for (let i = 0; i < 4; i++) rib(x + 68 + i * 8, y + 37 + i * 2, 6, 11);
      limb(x + 80, y + 40, x + 84, y + 55, 4.5);
      limb(x + 84, y + 55, x + 89, y + 60, 3.8);
      claw(x + 89, y + 60, 1);
      limb(x + 62, y + 34, x + 56, y + 50, 4.2);
      limb(x + 56, y + 50, x + 51, y + 59, 3.6);
      claw(x + 51, y + 59, -1);
      raptorSkull(x + 90, y + 6, 0.55);
    }
  }

  function drawExcavator(o) {
    const x = o.x, y = o.baseY;
    // Гусеницы
    ctx.fillStyle = '#37312a';
    roundedRectPath(ctx, x + 4, y + o.h - 22, 116, 20, 8); ctx.fill();
    ctx.fillStyle = '#6b6258';
    for (let i = 0; i < 8; i++) ctx.fillRect(x + 10 + i * 14, y + o.h - 19, 8, 13);
    // Кузов и кабина
    ctx.fillStyle = '#e8b423';
    roundedRectPath(ctx, x + 14, y + 48, 84, 40, 6); ctx.fill();
    ctx.fillStyle = '#f5ca42';
    roundedRectPath(ctx, x + 78, y + 16, 50, 62, 6); ctx.fill();
    ctx.fillStyle = '#9fd4df';
    roundedRectPath(ctx, x + 86, y + 23, 31, 28, 4); ctx.fill();
    ctx.fillStyle = '#e8b423';
    ctx.fillRect(x + 20, y + 38, 50, 12);
    // Стрела и ковш (немного покачиваются)
    const wave = Math.sin(gameTime / 300 + o.phase) * 3;
    ctx.strokeStyle = '#d19b18';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(x + 64, y + 50);
    ctx.lineTo(x + 24, y + 30 + wave);
    ctx.lineTo(x + 4, y + 58 + wave);
    ctx.stroke();
    ctx.fillStyle = '#8d8f8b';
    ctx.beginPath();
    ctx.moveTo(x + 2, y + 54 + wave);
    ctx.lineTo(x + 30, y + 62 + wave);
    ctx.lineTo(x + 22, y + 82 + wave);
    ctx.lineTo(x - 2, y + 74 + wave);
    ctx.closePath(); ctx.fill();
    // Надпись на борту
    ctx.fillStyle = '#6b4a12';
    ctx.font = 'bold 11px "Trebuchet MS", sans-serif';
    ctx.fillText('РАСКОП', x + 22, y + 70);
  }

  // Птеродактиль: длинный острый клюв, гребень на затылке и костистые крылья
  // с перепонками, которые взмахивают при полёте.
  function drawPtero(o) {
    const cx = o.x + o.w / 2;
    const cy = o.baseY + o.h / 2;
    const flap = Math.sin(gameTime / 90 + o.phase) * 11;
    const skin = '#6f567e', membrane = 'rgba(156,120,171,0.88)';
    const bone = '#efe2c4', dark = '#3b2d43';

    // Одно крыло: перепонка + три костистых «пальца»
    function wing(dir) {
      const sx = cx + dir * 7, sy = cy - 2;
      const ex = cx + dir * 26, ey = cy - 10 - flap * 0.55;
      const tx = cx + dir * 46, ty = cy - 5 - flap;
      ctx.fillStyle = membrane;
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(ex, ey, tx, ty);
      ctx.quadraticCurveTo(cx + dir * 30, cy + 10, sx, cy + 4);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      // Костистые распорки крыла
      ctx.strokeStyle = bone;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(cx + dir * 30, cy + 10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(cx + dir * 30, cy + 10); ctx.stroke();
    }
    wing(-1);
    wing(1);

    // Тело
    ctx.fillStyle = skin;
    ctx.strokeStyle = dark;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.ellipse(cx, cy + 3, 11, 8, 0, 0, 6.283); ctx.fill(); ctx.stroke();

    // Голова с очень длинным острым клювом
    ctx.beginPath();
    ctx.moveTo(cx + 4, cy - 6);
    ctx.lineTo(cx + 13, cy - 8);
    ctx.lineTo(cx + 32, cy + 1);
    ctx.lineTo(cx + 13, cy + 5);
    ctx.lineTo(cx + 4, cy + 5);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    // Характерный гребень на затылке
    ctx.beginPath();
    ctx.moveTo(cx + 5, cy - 7);
    ctx.lineTo(cx - 5, cy - 19);
    ctx.lineTo(cx + 10, cy - 8);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    // Глаз и маленькие лапки
    ctx.fillStyle = '#f6e6b8';
    ctx.beginPath(); ctx.arc(cx + 10, cy - 3, 2.3, 0, 6.283); ctx.fill();
    ctx.fillStyle = dark;
    ctx.beginPath(); ctx.arc(cx + 10.6, cy - 3, 1.1, 0, 6.283); ctx.fill();
    ctx.strokeStyle = bone;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 2, cy + 10); ctx.lineTo(cx - 4, cy + 14);
    ctx.moveTo(cx + 4, cy + 10); ctx.lineTo(cx + 6, cy + 14);
    ctx.stroke();
  }

  function drawObstacles() {
    obstacles.forEach(o => {
      switch (o.type) {
        case 'skeletonSmall': drawSkeleton(o, 'small'); break;
        case 'skeletonBig': drawSkeleton(o, 'big'); break;
        case 'skeletonGroup': drawSkeleton(o, 'group'); break;
        case 'excavator': drawExcavator(o); break;
        case 'ptero': drawPtero(o); break;
      }
    });
  }

  function drawArtifacts() {
    artifacts.forEach(a => {
      const wobble = Math.sin(gameTime / 180 + a.phase) * 4;
      const size = 11 + Math.sin(gameTime / 130 + a.phase) * 1.5;
      ctx.save();
      ctx.translate(a.x, a.y + wobble);
      ctx.rotate(gameTime / 260 + a.phase);
      const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, 26);
      glow.addColorStop(0, 'rgba(255,230,120,0.55)');
      glow.addColorStop(1, 'rgba(255,230,120,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(0, 0, 26, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#ffd54a';
      ctx.beginPath();
      ctx.moveTo(0, -size); ctx.lineTo(size * 0.65, 0); ctx.lineTo(0, size); ctx.lineTo(-size * 0.65, 0);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff1ad';
      ctx.beginPath();
      ctx.moveTo(0, -size); ctx.lineTo(0, size); ctx.lineTo(-size * 0.65, 0);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    });
  }

  function drawParticles() {
    particles.forEach(p => {
      ctx.globalAlpha = clamp(p.life / 70, 0, 1);
      ctx.fillStyle = p.color;
      ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
      ctx.fillText(p.text, p.x, p.y);
    });
    ctx.globalAlpha = 1;
  }

  function drawHUD(look) {
    ctx.textAlign = 'left';
    ctx.fillStyle = look.text;
    ctx.font = 'bold 22px "Trebuchet MS", sans-serif';
    ctx.fillText(`${String(Math.floor(score)).padStart(5, '0')} м`, 18, 34);
    ctx.textAlign = 'right';
    ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
    ctx.fillText(`HI ${String(hi).padStart(5, '0')}`, W - 18, 34);
    ctx.textAlign = 'left';
  }

  function drawStartScreen() {
    // Полупрозрачная «табличка» с заголовком и крупным портретом в центре
    const pw = Math.min(W - 36, 660), ph = 382;
    const px = (W - pw) / 2, py = 18;
    ctx.fillStyle = 'rgba(255,244,215,0.90)';
    roundedRectPath(ctx, px, py, pw, ph, 18); ctx.fill();
    ctx.strokeStyle = '#8a6537';
    ctx.lineWidth = 4;
    roundedRectPath(ctx, px, py, pw, ph, 18); ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#4a3019';
    ctx.font = 'bold 46px "Trebuchet MS", sans-serif';
    ctx.fillText('KUBLO RUN', W / 2, py + 50);
    ctx.font = 'bold 17px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#8a6537';
    ctx.fillText('Бегущий Кубло · раскопки без передышки', W / 2, py + 74);

    // Крупный анимированный портрет: кадры меняются, как живое лицо
    const portraitH = Math.min(170, ph * 0.46);
    const portraitW = portraitH * FACE_RATIO;
    drawFace(hero.faceFrame, W / 2, py + 168, portraitW, portraitH, Math.sin(hero.faceTimer / 430 * Math.PI) * 0.04);

    ctx.fillStyle = '#4a3019';
    ctx.font = 'bold 20px "Trebuchet MS", sans-serif';
    ctx.fillText('ПРОБЕЛ / ↑ / ТАП — НАЧАТЬ ЗАБЕГ', W / 2, py + 285);
    ctx.font = 'bold 15px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#7a5631';
    ctx.fillText(`Рекорд: ${hi} м  ·  Забегов: ${runs}  ·  Звание: ${rankFor(hi)}`, W / 2, py + 315);
    ctx.font = '13px "Trebuchet MS", sans-serif';
    ctx.fillText('↓ / S или удержание справа — пригнуться под птеродактилем', W / 2, py + 343);
    ctx.textAlign = 'left';
  }

  function drawGameOver() {
    ctx.fillStyle = 'rgba(24,16,10,0.60)';
    ctx.fillRect(0, 0, W, LOGICAL_H);

    const bw = Math.min(480, W - 30), bh = 216;
    const bx = (W - bw) / 2, by = (LOGICAL_H - bh) / 2 - 8;
    ctx.fillStyle = '#8b5c30';
    roundedRectPath(ctx, bx + 5, by + 7, bw, bh, 14); ctx.fill();
    ctx.fillStyle = '#d8ac6b';
    roundedRectPath(ctx, bx, by, bw, bh, 14); ctx.fill();
    ctx.strokeStyle = '#5b3a1c';
    ctx.lineWidth = 4;
    roundedRectPath(ctx, bx, by, bw, bh, 14); ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#4a2c15';
    ctx.font = 'bold 30px "Trebuchet MS", sans-serif';
    ctx.fillText('Раскоп остановлен!', W / 2, by + 44);
    ctx.font = 'bold 19px "Trebuchet MS", sans-serif';
    ctx.fillText(`Дистанция: ${Math.floor(score)} м   ·   HI: ${hi} м`, W / 2, by + 80);
    ctx.font = '15px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#6b4727';
    ctx.fillText(`Забегов: ${runs} · Звание: ${rankFor(hi)}`, W / 2, by + 106);

    // Кнопка «Бежать снова» (нажатие по ней обрабатывается общим тапом/кликом)
    const pulse = 1 + Math.sin(gameTime / 220) * 0.02;
    ctx.save();
    ctx.translate(W / 2, by + 158);
    ctx.scale(pulse, pulse);
    ctx.fillStyle = '#4e8150';
    roundedRectPath(ctx, -110, -22, 220, 44, 10); ctx.fill();
    ctx.strokeStyle = '#2d502f'; ctx.lineWidth = 3;
    roundedRectPath(ctx, -110, -22, 220, 44, 10); ctx.stroke();
    ctx.fillStyle = '#fff6df';
    ctx.font = 'bold 19px "Trebuchet MS", sans-serif';
    ctx.fillText('Бежать снова', 0, 7);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  function render() {
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    ctx.clearRect(0, 0, W, LOGICAL_H);

    const look = currentLook();
    drawBackground(look);
    drawGround(look);

    if (state === 'start') {
      drawStartScreen();
    } else {
      ctx.save();
      if (shake > 0) ctx.translate(rand(-shake, shake) * 0.5, rand(-shake, shake) * 0.4);
      drawArtifacts();
      drawObstacles();
      drawHero();
      drawParticles();
      ctx.restore();
      drawHUD(look);
      if (state === 'over') drawGameOver();
    }
  }

  /* ------------------------------------------------------------------
     5. ГЛАВНЫЙ ЦИКЛ
     ------------------------------------------------------------------ */

  let lastTime = performance.now();
  let accumulator = 0;
  const STEP = 1000 / 60;

  function loop(now) {
    const delta = Math.min(now - lastTime, 100);
    lastTime = now;
    accumulator += delta;
    // Фиксированный шаг делает физику одинаковой на мониторах с любой частотой обновления
    while (accumulator >= STEP) { update(); accumulator -= STEP; }
    render();
    requestAnimationFrame(loop);
  }

  resizeCanvas();
  syncUI(); // стартовая заставка: кнопка «Старт» поверх Canvas, игровые кнопки скрыты

  // Обычный ресайз и поворот смартфона: пересчитываем виртуальную ширину и масштаб,
  // чтобы пропорции героя и препятствий не искажались в альбомном режиме.
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => {
    resizeCanvas();
    // Некоторые мобильные браузеры меняют размеры асинхронно — уточняем на следующем кадре
    requestAnimationFrame(resizeCanvas);
    setTimeout(resizeCanvas, 250);
  });

  loadFaces();
  requestAnimationFrame(loop);
})();
