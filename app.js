'use strict';
// رفيق البر — Web App لنظارة Meta Ray-Ban Display.
// الشاشات: الرئيسية، التوجه، الرادار، الأثر، الريح، الخريطة، الإضافة، المعايرة.
// كل البيانات تبقى في localStorage على النظارة، ولا تُرسل لأي خادم.
// الاستثناءان: إحداثيات مقرّبة (نحو 100 م) تُرسل لـ Open-Meteo لجلب الريح،
// وطلبات قطع الخريطة من Esri وOpenStreetMap.
(() => {
  const DEMO = new URLSearchParams(location.search).has('demo');
  const NS = DEMO ? 'barr-demo.' : 'barr.';
  const KAABA = { lat: 21.422487, lon: 39.826206 };
  const TYPES = { camp: 'المخيم', car: 'السيارة', well: 'بير', hunt: 'صيد', road: 'طريق', spot: 'نقطة' };
  const SLOTS = ['camp', 'car'];
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- التخزين ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(NS + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(NS + key, JSON.stringify(value));
        return true;
      } catch (e) {
        toast('ما قدرت أحفظ البيانات');
        return false;
      }
    },
  };

  // ---------- الحالة ----------
  const S = {
    screen: 'home',
    pos: null, // {lat, lon, acc, at}
    rawHeading: null,
    heading: null,
    headingSrc: '',
    headingAt: 0,
    courseAnchor: null,
    points: store.get('points', []),
    track: store.get('track', { rec: false, pts: [] }),
    cfg: store.get('cfg', { offset: 0, invert: false }),
    target: store.get('target', { kind: 'point', id: 'camp' }),
    wind: store.get('wind', null),
    addType: 'well',
    mapZoom: store.get('mapZoom', 15),
    mapNorthUp: false,
    mapLayer: store.get('mapLayer', 'sat'),
    oriAttached: false,
    geoWatch: null,
    confirm: null,
    windBusy: false,
  };

  // ---------- الحساب الجغرافي ----------
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const norm = (d) => ((d % 360) + 360) % 360;
  const P = (a) => ({ lat: a[0], lon: a[1] });

  function dist(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(a, b) {
    const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return norm(deg(Math.atan2(y, x)));
  }

  function offsetPoint(p, brg, meters) {
    const d = meters / R;
    const t = rad(brg);
    const la1 = rad(p.lat);
    const lo1 = rad(p.lon);
    const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(t));
    const lo2 = lo1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return { lat: deg(la2), lon: deg(lo2) };
  }

  const CARD = ['شمال', 'شمال شرق', 'شرق', 'جنوب شرق', 'جنوب', 'جنوب غرب', 'غرب', 'شمال غرب'];
  const card = (b) => CARD[Math.round(norm(b) / 45) % 8];

  function relText(rel) {
    rel = norm(rel);
    if (rel <= 20 || rel >= 340) return 'قدّامك';
    if (rel < 70) return 'قدّام يمين';
    if (rel <= 110) return 'على يمينك';
    if (rel < 160) return 'ورا يمين';
    if (rel <= 200) return 'وراك';
    if (rel < 250) return 'ورا يسار';
    if (rel <= 290) return 'على يسارك';
    return 'قدّام يسار';
  }

  function fmtDist(m) {
    if (m < 1000) return `${Math.round(m)} م`;
    if (m < 10000) return `${+(m / 1000).toFixed(1)} كم`;
    return `${Math.round(m / 1000)} كم`;
  }

  function fmtDur(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `${h} س ${m} د` : `${m} د`;
  }

  // offsetSec: فرق التوقيت لمكان القراءة، عشان أوقات الشمس تطلع بتوقيت المكان لا توقيت الجهاز
  const fmtTime = (ms, offsetSec) => (offsetSec === undefined
    ? new Date(ms).toLocaleTimeString('ar-u-nu-latn', { hour: 'numeric', minute: '2-digit' })
    : new Date(ms + offsetSec * 1000).toLocaleTimeString('ar-u-nu-latn', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }));

  // ---------- الاتجاه (البوصلة أو اتجاه المشي) ----------
  const now = () => performance.now();
  const compassFresh = () => S.headingSrc === 'بوصلة' && now() - S.headingAt < 3000;
  const headingValid = () => S.heading !== null && now() - S.headingAt < (S.headingSrc === 'بوصلة' ? 3000 : 15000);

  function smoothAngle(a, b, k) {
    const d = ((b - a + 540) % 360) - 180;
    return norm(a + d * k);
  }

  function calibrated(raw) {
    const h = S.cfg.invert ? 360 - raw : raw;
    return norm(h + S.cfg.offset);
  }

  function setHeading(h, src) {
    S.heading = S.heading === null || S.headingSrc !== src ? h : smoothAngle(S.heading, h, src === 'بوصلة' ? 0.25 : 0.6);
    S.headingSrc = src;
    S.headingAt = now();
  }

  function onOrientation(e, absoluteEvent) {
    let raw = null;
    if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
      raw = e.webkitCompassHeading;
    } else if (Number.isFinite(e.alpha) && (absoluteEvent || e.absolute === true)) {
      raw = norm(360 - e.alpha);
    }
    if (raw === null) return;
    S.rawHeading = raw;
    setHeading(calibrated(raw), 'بوصلة');
  }

  function attachOrientation() {
    if (S.oriAttached) return;
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', (e) => onOrientation(e, true));
    }
    window.addEventListener('deviceorientation', (e) => onOrientation(e, false));
    S.oriAttached = true;
  }

  // ---------- الموقع ----------
  let lastPosSave = 0;

  function onPosition(p) {
    const c = p.coords;
    const pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy || 999, at: Date.now() };
    if (!compassFresh()) {
      if (Number.isFinite(c.heading) && Number.isFinite(c.speed) && c.speed > 0.7) {
        setHeading(c.heading, 'اتجاه المشي');
      } else if (S.courseAnchor) {
        const d = dist(S.courseAnchor, pos);
        if (d > Math.max(10, pos.acc / 2)) {
          setHeading(bearing(S.courseAnchor, pos), 'اتجاه المشي');
          S.courseAnchor = pos;
        }
      }
    }
    if (!S.courseAnchor || dist(S.courseAnchor, pos) > 40) S.courseAnchor = pos;
    S.pos = pos;
    recordTrack(pos);
    if (Date.now() - lastPosSave > 30000) {
      lastPosSave = Date.now();
      store.set('lastpos', { lat: pos.lat, lon: pos.lon });
    }
  }

  function onPosError(err) {
    if (err && err.code === 1) toast('ما انسمح بالموقع — فعّله من تطبيق Meta AI');
  }

  function startGeo() {
    if (S.geoWatch !== null || DEMO) return;
    if (!navigator.geolocation) {
      toast('الموقع غير مدعوم هنا');
      return;
    }
    S.geoWatch = navigator.geolocation.watchPosition(onPosition, onPosError, { enableHighAccuracy: true });
  }

  async function enableSensors() {
    try {
      const O = window.DeviceOrientationEvent;
      const M = window.DeviceMotionEvent;
      const owner = typeof O?.requestPermission === 'function' ? O : typeof M?.requestPermission === 'function' ? M : null;
      const state = owner ? await owner.requestPermission() : 'granted';
      if (state === 'granted') attachOrientation();
      else toast('ما انسمح للبوصلة');
    } catch (e) {
      toast('البوصلة غير متاحة');
    }
    startGeo();
    store.set('enabled', true);
  }

  const lastKnown = () => S.pos || store.get('lastpos', null);

  // ---------- الأثر ----------
  let trackSaveTimer = null;
  function saveTrackSoon() {
    if (trackSaveTimer) return;
    trackSaveTimer = setTimeout(() => {
      trackSaveTimer = null;
      store.set('track', S.track);
    }, 3000);
  }

  function recordTrack(pos) {
    if (!S.track.rec || pos.acc > 60) return;
    const pts = S.track.pts;
    const last = pts[pts.length - 1];
    if (!last || dist(P(last), pos) >= 12) {
      pts.push([+pos.lat.toFixed(6), +pos.lon.toFixed(6), Math.round(pos.at / 1000)]);
      if (pts.length > 4000) pts.splice(0, pts.length - 4000);
      saveTrackSoon();
    }
  }

  function trackLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += dist(P(pts[i - 1]), P(pts[i]));
    return len;
  }

  // هدف الرجوع: نقطة على الأثر قبل أقرب نقطة لك بنحو 40 م باتجاه البداية
  function backtrackTarget() {
    const pts = S.track.pts;
    if (!S.pos || pts.length < 2) return null;
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = dist(S.pos, P(pts[i]));
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    let j = bi;
    let ahead = 0;
    while (j > 0 && ahead < 40) {
      ahead += dist(P(pts[j]), P(pts[j - 1]));
      j--;
    }
    let rem = 0;
    for (let k = j; k > 0; k--) rem += dist(P(pts[k]), P(pts[k - 1]));
    return { lat: pts[j][0], lon: pts[j][1], name: 'الرجوع على الأثر', remaining: rem + dist(S.pos, P(pts[j])) };
  }

  // ---------- الأهداف والنقاط ----------
  const pointById = (id) => S.points.find((p) => p.id === id);

  function targetInfo() {
    const t = S.target;
    if (t.kind === 'qibla') return { ...KAABA, name: 'القبلة' };
    if (t.kind === 'track') return backtrackTarget();
    const p = pointById(t.id);
    return p ? { lat: p.lat, lon: p.lon, name: p.name } : null;
  }

  function targetName() {
    const t = S.target;
    if (t.kind === 'qibla') return 'القبلة';
    if (t.kind === 'track') return 'الرجوع على الأثر';
    return pointById(t.id)?.name || TYPES[t.id] || 'نقطة';
  }

  function setTarget(t) {
    S.target = t;
    store.set('target', t);
  }

  function savePointHere(type, name) {
    if (!S.pos) {
      toast('ما عندي موقع للحين — انتظر شوي');
      return false;
    }
    const base = { type, lat: +S.pos.lat.toFixed(6), lon: +S.pos.lon.toFixed(6), at: Date.now() };
    if (SLOTS.includes(type)) {
      S.points = S.points.filter((p) => p.id !== type);
      S.points.push({ ...base, id: type, name: TYPES[type] });
    } else {
      const n = S.points.filter((p) => p.type === type).length + 1;
      S.points.push({ ...base, id: `p${Date.now()}`, name: name || `${TYPES[type]} ${n}` });
    }
    store.set('points', S.points);
    return true;
  }

  // ---------- الريح والشمس (Open-Meteo) ----------
  async function fetchWind(force) {
    const p = lastKnown();
    if (!p) {
      toast('أحتاج موقعك أول');
      return;
    }
    if (!force && S.wind && Date.now() - S.wind.at < 20 * 60000) return;
    if (S.windBusy) return;
    S.windBusy = true;
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${p.lat.toFixed(3)}&longitude=${p.lon.toFixed(3)}`
      + '&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m'
      + '&daily=sunrise,sunset&forecast_days=2&timezone=auto&wind_speed_unit=kmh';
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      const off = j.utc_offset_seconds || 0;
      const toMs = (s) => {
        const [d, t] = s.split('T');
        const [Y, Mo, D] = d.split('-').map(Number);
        const [h, mi] = t.split(':').map(Number);
        return Date.UTC(Y, Mo - 1, D, h, mi) - off * 1000;
      };
      S.wind = {
        at: Date.now(),
        speed: j.current.wind_speed_10m,
        gust: j.current.wind_gusts_10m,
        from: j.current.wind_direction_10m,
        sunsets: j.daily.sunset.map(toMs),
        sunrises: j.daily.sunrise.map(toMs),
        off,
      };
      store.set('wind', S.wind);
      if (force) toast('تحدّثت الريح');
    } catch (e) {
      toast('ما قدرت أجيب الريح — تأكد من النت');
    } finally {
      S.windBusy = false;
    }
  }

  function sunLine() {
    const w = S.wind;
    if (!w || !w.sunsets) return '';
    const t = Date.now();
    const sunset = w.sunsets.find((x) => x > t);
    const sunrise = w.sunrises.find((x) => x > t);
    if (sunset && (!sunrise || sunset < sunrise)) return `الغروب ${fmtTime(sunset, w.off)} · باقي ${fmtDur(sunset - t)}`;
    if (sunrise) return `الشروق ${fmtTime(sunrise, w.off)} · باقي ${fmtDur(sunrise - t)}`;
    return '';
  }

  function windFromText(rel) {
    rel = norm(rel);
    if (rel <= 30 || rel >= 330) return 'في وجهك';
    if (rel < 150) return 'من يمينك';
    if (rel <= 210) return 'من وراك';
    return 'من يسارك';
  }

  // ---------- قطع الخريطة ----------
  // طبقتان بلا مفتاح للاستخدام الشخصي غير التجاري. شروطهما تمنع تنزيل مناطق كاملة مسبقًا،
  // فالتطبيق يعرض القطع فقط، وعامل الخدمة يحتفظ باللي انعرض.
  const LAYERS = {
    sat: {
      label: 'قمر صناعي',
      attr: 'صور: Esri وشركاؤها',
      url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    },
    osm: {
      label: 'شوارع',
      attr: '© OpenStreetMap',
      url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    },
  };
  const lon2x = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
  const lat2y = (lat, z) => {
    const s = Math.sin(rad(lat));
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
  };
  function tileUrl(z, x, y) {
    const n = 2 ** z;
    const xx = ((x % n) + n) % n;
    return LAYERS[S.mapLayer].url(z, xx, y);
  }

  // ---------- أدوات العرض ----------
  const lastRot = {};
  function setRot(el, key, ang) {
    const prev = lastRot[key];
    let a = ang;
    if (prev !== undefined) a = prev + ((((ang - prev) % 360) + 540) % 360) - 180;
    lastRot[key] = a;
    el.style.transform = `rotate(${a}deg)`;
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function show(id, visible) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.hidden === visible) {
      if (!visible && document.activeElement === el) focusFirst();
      el.hidden = !visible;
    }
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2800);
  }

  function focusFirst() {
    const f = $('#screen').querySelector('button:not([hidden]), input');
    if (f) f.focus({ preventScroll: true });
  }

  function confirmTwice(btn, key, fn) {
    if (S.confirm && S.confirm.key === key && Date.now() - S.confirm.at < 4000) {
      btn.textContent = S.confirm.label;
      S.confirm = null;
      fn();
      return;
    }
    S.confirm = { key, at: Date.now(), label: btn.textContent };
    btn.textContent = 'متأكد؟ اضغط مرة ثانية';
    setTimeout(() => {
      if (S.confirm && S.confirm.key === key) {
        btn.textContent = S.confirm.label;
        S.confirm = null;
      }
    }, 4000);
  }

  // نقاط محلية بالمتر حول مركز، مع تدوير حسب الاتجاه
  function localXY(center, p, rotDeg) {
    const x = (p.lon - center.lon) * Math.cos(rad(center.lat)) * 111320;
    const y = (p.lat - center.lat) * 110540;
    const r = rad(rotDeg);
    return { x: x * Math.cos(r) - y * Math.sin(r), y: x * Math.sin(r) + y * Math.cos(r) };
  }

  const RANGES = [100, 250, 500, 1000, 2000, 5000, 10000, 25000, 50000, 100000];
  const pickRange = (m) => RANGES.find((r) => r >= m) || RANGES[RANGES.length - 1];

  function meMarker(withHeading) {
    return withHeading
      ? '<path d="M0,-9 L7,7 L0,3 L-7,7 Z" fill="#C8A45D"/>'
      : '<circle r="5" fill="#C8A45D"/>';
  }

  // الصفحة RTL: anchor="end" يمد النص يمين النقطة، و"start" يمده يسارها
  function svgLabel(x, y, text, leftSide) {
    const lx = leftSide ? x - 8 : x + 8;
    return `<text class="radar-label" x="${lx.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${leftSide ? 'start' : 'end'}">${esc(text)}</text>`;
  }

  function northTag(rot) {
    const r = rad(rot);
    return `<text class="radar-dim" x="${(Math.sin(r) * 104).toFixed(1)}" y="${(-Math.cos(r) * 104 + 3).toFixed(1)}" text-anchor="middle">ش</text>`;
  }

  // ---------- الشاشات ----------
  const screens = {
    home: {
      title: 'رفيق البر',
      html: () => `
        <div class="grid">
          <button data-act="go" data-to="nav">التوجّه<small id="h-nav"></small></button>
          <button data-act="go" data-to="radar">رادار النقاط<small id="h-radar"></small></button>
          <button data-act="go" data-to="track">أثر المشي<small id="h-track"></small></button>
          <button data-act="go" data-to="wind">الريح والغروب<small id="h-wind"></small></button>
          <button data-act="go" data-to="map">الخريطة<small>قمر صناعي أو شوارع</small></button>
          <button data-act="go" data-to="add" class="primary">احفظ نقطة هنا<small>بير، صيد، مخيم…</small></button>
        </div>
        <div class="row mt">
          <button data-act="enable" id="h-enable" class="primary">شغّل الموقع والبوصلة</button>
          <button data-act="go" data-to="settings">معايرة البوصلة</button>
        </div>`,
      update() {
        const t = targetInfo();
        setText('h-nav', S.pos && t ? `${targetName()} ${fmtDist(t.remaining ?? dist(S.pos, t))}` : targetName());
        setText('h-radar', `${S.points.length} نقطة`);
        setText('h-track', S.track.rec ? `يسجّل · ${fmtDist(trackLength(S.track.pts))}` : S.track.pts.length ? fmtDist(trackLength(S.track.pts)) : 'متوقف');
        setText('h-wind', S.wind ? `${card(S.wind.from)} ${Math.round(S.wind.speed)} كم/س` : 'يحتاج نت');
        show('h-enable', !(S.pos && compassFresh()));
      },
    },

    nav: {
      title: 'التوجّه',
      html: () => `
        <div class="nav">
          <div class="tname" id="n-name"></div>
          <div class="arrow"><svg id="n-arrow" viewBox="-50 -50 100 100" aria-hidden="true"><circle r="47" class="ring"/><path class="needle" d="M0,-40 L20,22 L0,10 L-20,22 Z"/></svg></div>
          <div class="big" id="n-dist">—</div>
          <div class="sub" id="n-dir"></div>
          <div class="row">
            <button data-act="tgt" data-kind="point" data-id="camp">المخيم</button>
            <button data-act="tgt" data-kind="point" data-id="car">السيارة</button>
            <button data-act="tgt" data-kind="qibla">القبلة</button>
            <button data-act="slot" id="n-slot" class="primary"></button>
            <button data-act="del" id="n-del">احذف النقطة</button>
          </div>
        </div>`,
      update() {
        const t = targetInfo();
        const isSlot = S.target.kind === 'point' && SLOTS.includes(S.target.id);
        setText('n-name', targetName());
        setText('n-slot', isSlot ? `احفظ ${TYPES[S.target.id]} هنا` : '');
        show('n-slot', isSlot);
        show('n-del', S.target.kind === 'point' && !isSlot && !!pointById(S.target.id));
        if (!S.pos) {
          setText('n-dist', '…');
          setText('n-dir', 'أنتظر الموقع من الجوال');
          return;
        }
        if (!t) {
          setText('n-dist', '—');
          setText('n-dir', S.target.kind === 'track' ? 'ما فيه أثر مسجّل' : 'ما انحفظ للحين — وقف عنده واضغط «احفظ هنا»');
          return;
        }
        const d = t.remaining ?? dist(S.pos, t);
        const b = bearing(S.pos, t);
        const hv = headingValid();
        setRot($('#n-arrow'), 'nav', hv ? b - S.heading : b);
        setText('n-dist', fmtDist(d));
        let dir = hv ? `${relText(b - S.heading)} · ${card(b)} ${Math.round(b)}°` : `${card(b)} ${Math.round(b)}° · السهم والشمال فوق`;
        if (hv && S.headingSrc !== 'بوصلة') dir += ' · الاتجاه من مشيك';
        if (S.target.kind !== 'qibla' && d < Math.max(15, S.pos.acc)) dir = 'وصلت تقريبًا';
        setText('n-dir', dir);
      },
    },

    radar: {
      title: 'رادار النقاط',
      html: () => `
        <div class="split">
          <svg id="r-svg" viewBox="-112 -112 224 224" aria-hidden="true"></svg>
          <div class="list" id="r-list"></div>
        </div>
        <div class="row"><button data-act="go" data-to="add" class="primary">أضف نقطة هنا</button></div>`,
      listKey: '',
      update() {
        const svg = $('#r-svg');
        const list = $('#r-list');
        if (!S.pos) {
          svg.innerHTML = '<text class="radar-label" text-anchor="middle">أنتظر الموقع…</text>';
          return;
        }
        const hv = headingValid();
        const h = hv ? S.heading : 0;
        const items = S.points
          .map((p) => ({ p, d: dist(S.pos, p), b: bearing(S.pos, p) }))
          .sort((a, b) => a.d - b.d);
        // المدى يغطي أقرب ثلاث نقاط، والأبعد تظهر دوائر فاضية على الحافة
        const range = pickRange(Math.max(100, ...items.slice(0, 3).map((i) => i.d)));
        let s = '<circle r="100" class="ring"/><circle r="50" class="ring"/>';
        s += `<text class="radar-dim" x="0" y="-90" text-anchor="middle">${esc(fmtDist(range))}</text>`;
        s += `<text class="radar-dim" x="0" y="-40" text-anchor="middle">${esc(fmtDist(range / 2))}</text>`;
        if (hv) s += northTag(-h);
        for (const it of items) {
          const rel = rad(it.b - h);
          const out = it.d > range;
          const r = Math.min(1, it.d / range) * 100;
          const x = Math.sin(rel) * r;
          const y = -Math.cos(rel) * r;
          const slot = SLOTS.includes(it.p.id);
          s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${out ? 'none' : slot ? '#C8A45D' : '#FFFFFF'}" stroke="${slot ? '#C8A45D' : '#FFFFFF'}" stroke-width="1.5"/>`;
          if (!out) s += svgLabel(x, y, it.p.name.slice(0, 10), x > 30);
        }
        s += meMarker(hv);
        svg.innerHTML = s;

        const top = items.slice(0, 6);
        const key = top.map((i) => i.p.id).join(',');
        if (!top.length) {
          if (this.listKey !== 'empty') {
            list.innerHTML = '<p class="dim">ما فيه نقاط. احفظ أول نقطة من «أضف نقطة هنا».</p>';
            this.listKey = 'empty';
          }
          return;
        }
        if (key !== this.listKey) {
          const focusedId = document.activeElement?.dataset?.id;
          list.innerHTML = top.map((i) => `<button data-act="tgt" data-kind="point" data-id="${esc(i.p.id)}"></button>`).join('');
          this.listKey = key;
          if (focusedId) list.querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
        }
        top.forEach((i, n) => {
          const where = hv ? relText(i.b - h) : card(i.b);
          const btn = list.children[n];
          const text = `${i.p.name} — ${fmtDist(i.d)} — ${where}`;
          if (btn && btn.textContent !== text) btn.textContent = text;
        });
      },
    },

    track: {
      title: 'أثر المشي',
      html: () => `
        <div class="split">
          <svg id="t-svg" viewBox="-112 -112 224 224" aria-hidden="true"></svg>
          <div class="stats" id="t-stats"></div>
        </div>
        <div class="row">
          <button data-act="rec" id="t-rec" class="primary"></button>
          <button data-act="backtrack">ارجع على الأثر</button>
          <button data-act="clear" id="t-clear">امسح الأثر</button>
        </div>`,
      update() {
        const pts = S.track.pts;
        if (!S.confirm) setText('t-rec', S.track.rec ? 'أوقف التسجيل' : 'ابدأ التسجيل');
        const len = trackLength(pts);
        const lines = [
          `<div class="big">${esc(fmtDist(len))}</div>`,
          `<div class="sub">${S.track.rec ? 'يسجّل الحين' : 'متوقف'}</div>`,
        ];
        if (pts.length > 1) {
          lines.push(`<div class="dim">المدة ${esc(fmtDur((pts[pts.length - 1][2] - pts[0][2]) * 1000))}</div>`);
          if (S.pos) lines.push(`<div class="dim">البداية تبعد ${esc(fmtDist(dist(S.pos, P(pts[0]))))} خط مستقيم</div>`);
        }
        lines.push('<div class="dim">خلّ التطبيق مفتوح وقت التسجيل</div>');
        const stats = $('#t-stats');
        const html = lines.join('');
        if (stats.innerHTML !== html) stats.innerHTML = html;

        const svg = $('#t-svg');
        const center = S.pos || (pts.length ? P(pts[pts.length - 1]) : null);
        if (!center) {
          svg.innerHTML = '<text class="radar-label" text-anchor="middle">ما فيه أثر للحين</text>';
          return;
        }
        const hv = headingValid();
        const rot = hv ? -S.heading : 0;
        const xy = pts.map((q) => localXY(center, P(q), rot));
        const maxR = Math.max(50, ...xy.map((v) => Math.hypot(v.x, v.y)));
        const k = 100 / maxR;
        let s = '<circle r="100" class="ring"/>';
        s += `<text class="radar-dim" x="0" y="-90" text-anchor="middle">${esc(fmtDist(maxR))}</text>`;
        if (hv) s += northTag(rot);
        if (xy.length > 1) {
          s += `<polyline class="trk" points="${xy.map((v) => `${(v.x * k).toFixed(1)},${(-v.y * k).toFixed(1)}`).join(' ')}"/>`;
          s += `<circle cx="${(xy[0].x * k).toFixed(1)}" cy="${(-xy[0].y * k).toFixed(1)}" r="6" fill="#C8A45D"/>`;
          s += svgLabel(xy[0].x * k, -xy[0].y * k, 'البداية', xy[0].x * k > 30);
        }
        s += meMarker(hv);
        svg.innerHTML = s;
      },
    },

    wind: {
      title: 'الريح والغروب',
      html: () => `
        <div class="split">
          <svg id="w-svg" viewBox="-60 -60 120 120" aria-hidden="true"><circle r="56" class="ring"/><path class="needle" d="M0,-46 L15,-12 L5,-12 L5,46 L-5,46 L-5,-12 L-15,-12 Z"/></svg>
          <div class="stats">
            <div class="big" id="w-speed">—</div>
            <div class="sub" id="w-from"></div>
            <div class="tip" id="w-tip"></div>
            <div class="sub" id="w-sun"></div>
            <div class="dim" id="w-age"></div>
          </div>
        </div>
        <div class="row"><button data-act="windref" class="primary">حدّث الريح</button></div>`,
      mount() {
        fetchWind(false);
      },
      update() {
        const w = S.wind;
        if (!w) {
          setText('w-speed', '—');
          setText('w-from', S.windBusy ? 'أجيب بيانات الريح…' : 'ما فيه بيانات — تحتاج نت');
          return;
        }
        const hv = headingValid();
        // السهم يشير لجهة هبوب الريح (عكس جهة مجيئها)
        setRot($('#w-svg'), 'wind', hv ? w.from + 180 - S.heading : w.from + 180);
        setText('w-speed', `${Math.round(w.speed)} كم/س`);
        let from = `جاية من ${card(w.from)} (${Math.round(w.from)}°) · الهبّات ${Math.round(w.gust)} كم/س`;
        if (hv) from += ` · ${windFromText(w.from - S.heading)}`;
        setText('w-from', from);
        setText('w-tip', `للمقناص: امشِ باتجاه ${card(w.from)} والريح في وجهك، عشان الصيد ما يشم ريحتك.`);
        setText('w-sun', sunLine());
        setText('w-age', `آخر تحديث قبل ${fmtDur(Date.now() - w.at)}`);
      },
    },

    map: {
      title: 'الخريطة',
      html: () => `
        <div class="map" id="m-map">
          <div id="m-rot" class="maprot"><div id="m-tiles" class="tiles-${S.mapLayer}"></div><svg id="m-over"></svg></div>
          <svg class="me-mark" viewBox="-12 -12 24 24" aria-hidden="true"><path d="M0,-10 L8,9 L0,4 L-8,9 Z"/></svg>
          <div class="attr" id="m-attr"></div>
          <div id="m-msg" class="mapmsg" hidden></div>
        </div>
        <div class="row">
          <button data-act="zin">تكبير</button>
          <button data-act="zout">تصغير</button>
          <button data-act="mnorth" id="m-north"></button>
          <button data-act="mlayer" id="m-layer"></button>
        </div>`,
      tiles: new Map(),
      mount() {
        this.tiles = new Map();
      },
      update() {
        setText('m-north', S.mapNorthUp ? 'الشمال فوق' : 'اتجاهي فوق');
        setText('m-layer', S.mapLayer === 'sat' ? 'شوارع' : 'قمر صناعي');
        setText('m-attr', LAYERS[S.mapLayer].attr);
        const box = $('#m-map');
        const center = lastKnown();
        if (!center) {
          show('m-msg', true);
          setText('m-msg', 'أنتظر الموقع…');
          return;
        }
        show('m-msg', false);
        const W = box.clientWidth;
        const H = box.clientHeight;
        const D = Math.ceil(Math.hypot(W, H));
        const rotEl = $('#m-rot');
        rotEl.style.width = `${D}px`;
        rotEl.style.height = `${D}px`;
        rotEl.style.left = `${(W - D) / 2}px`;
        rotEl.style.top = `${(H - D) / 2}px`;
        const z = S.mapZoom;
        const x0 = lon2x(center.lon, z) - D / 2;
        const y0 = lat2y(center.lat, z) - D / 2;
        const layer = $('#m-tiles');
        const want = new Set();
        for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + D) / 256); tx++) {
          for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + D) / 256); ty++) {
            const key = `${z}/${tx}/${ty}`;
            want.add(key);
            let img = this.tiles.get(key);
            if (!img) {
              img = new Image();
              img.crossOrigin = 'anonymous';
              img.alt = '';
              img.src = tileUrl(z, tx, ty);
              this.tiles.set(key, img);
              layer.appendChild(img);
            }
            img.style.transform = `translate(${(tx * 256 - x0).toFixed(1)}px,${(ty * 256 - y0).toFixed(1)}px)`;
          }
        }
        for (const [key, img] of this.tiles) {
          if (!want.has(key)) {
            img.remove();
            this.tiles.delete(key);
          }
        }
        const ang = !S.mapNorthUp && headingValid() ? -S.heading : 0;
        rotEl.style.transform = `rotate(${ang}deg)`;

        const px = (p) => ({ x: lon2x(p.lon, z) - x0, y: lat2y(p.lat, z) - y0 });
        let s = '';
        const pts = S.track.pts;
        if (pts.length > 1) {
          s += `<polyline class="trk" points="${pts.map((q) => {
            const v = px(P(q));
            return `${v.x.toFixed(1)},${v.y.toFixed(1)}`;
          }).join(' ')}"/>`;
        }
        for (const p of S.points) {
          const v = px(p);
          if (v.x < -50 || v.y < -50 || v.x > D + 50 || v.y > D + 50) continue;
          const slot = SLOTS.includes(p.id);
          s += `<circle cx="${v.x.toFixed(1)}" cy="${v.y.toFixed(1)}" r="7" fill="${slot ? '#C8A45D' : '#FFFFFF'}"/>`;
          s += `<text x="${(v.x + 10).toFixed(1)}" y="${(v.y + 5).toFixed(1)}" text-anchor="end" fill="#FFFFFF" font-size="15" transform="rotate(${-ang} ${v.x.toFixed(1)} ${v.y.toFixed(1)})">${esc(p.name.slice(0, 12))}</text>`;
        }
        const over = $('#m-over');
        over.setAttribute('viewBox', `0 0 ${D} ${D}`);
        over.innerHTML = s;
      },
    },

    add: {
      title: 'احفظ نقطة هنا',
      html: () => `
        <div class="add">
          <div class="sub" id="a-pos"></div>
          <div class="types" role="group" aria-label="نوع النقطة">
            ${Object.entries(TYPES).map(([k, v]) => `<button data-act="ptype" data-type="${k}" aria-pressed="${k === S.addType}">${v}</button>`).join('')}
          </div>
          <label for="a-name">الاسم (اختياري — اكتبه أو قله)</label>
          <input id="a-name" type="text" maxlength="30" autocomplete="off">
          <div class="row"><button data-act="save" class="primary">احفظ هنا</button></div>
        </div>`,
      update() {
        setText('a-pos', S.pos ? `موقعك الحين · الدقة ±${Math.round(S.pos.acc)} م` : 'أنتظر الموقع من الجوال…');
      },
    },

    settings: {
      title: 'معايرة البوصلة',
      html: () => `
        <div class="add">
          <p>لو السهم مو مضبوط: لف وجهك للشمال (تأكد من بوصلة الجوال) واضغط «هذا الشمال».</p>
          <div class="big" id="c-now">—</div>
          <div class="row">
            <button data-act="calnorth" class="primary">هذا الشمال</button>
            <button data-act="calinv" id="c-inv"></button>
            <button data-act="calreset">صفّر المعايرة</button>
          </div>
          <p class="dim" id="c-src"></p>
        </div>`,
      update() {
        setText('c-now', headingValid() ? `${Math.round(S.heading)}° ${card(S.heading)}` : 'ما فيه اتجاه');
        setText('c-inv', `عكس الدوران: ${S.cfg.invert ? 'نعم' : 'لا'}`);
        setText('c-src', `مصدر الاتجاه: ${S.headingSrc || 'لا شيء'} · التصحيح ${Math.round(S.cfg.offset)}°`);
      },
    },
  };

  // ---------- التنقل ----------
  function render(name) {
    S.screen = name in screens ? name : 'home';
    S.confirm = null;
    const sc = screens[S.screen];
    $('#screen').innerHTML = `<section class="scr scr-${S.screen}">${sc.html()}</section>`;
    setText('title', sc.title);
    if (sc.listKey !== undefined) sc.listKey = '';
    sc.mount?.();
    sc.update?.();
    focusFirst();
  }

  // الجهاز يسمح بخمسة قيود تاريخ فقط: الرئيسية + شاشة واحدة، والتنقل بين الشاشات يستبدل القيد
  function navigate(to) {
    const st = { screen: to };
    if (S.screen === 'home') history.pushState(st, '');
    else history.replaceState(st, '');
    render(to);
  }

  window.addEventListener('popstate', (e) => render(e.state?.screen || 'home'));

  const actions = {
    go: (b) => navigate(b.dataset.to),
    enable: () => enableSensors(),
    tgt: (b) => {
      setTarget(b.dataset.kind === 'qibla' ? { kind: 'qibla' } : { kind: 'point', id: b.dataset.id });
      if (S.screen !== 'nav') navigate('nav');
    },
    slot: () => {
      if (savePointHere(S.target.id)) toast(`انحفظ ${TYPES[S.target.id]}`);
    },
    del: (b) => confirmTwice(b, 'del', () => {
      S.points = S.points.filter((p) => p.id !== S.target.id);
      store.set('points', S.points);
      setTarget({ kind: 'point', id: 'camp' });
      toast('انحذفت النقطة');
    }),
    ptype: (b) => {
      S.addType = b.dataset.type;
      document.querySelectorAll('[data-act="ptype"]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.type === S.addType)));
    },
    save: () => {
      const name = ($('#a-name')?.value || '').trim();
      if (savePointHere(S.addType, name)) {
        toast('انحفظت النقطة');
        navigate('radar');
      }
    },
    rec: () => {
      S.track.rec = !S.track.rec;
      store.set('track', S.track);
      toast(S.track.rec ? 'بدأ تسجيل الأثر' : 'وقف التسجيل');
    },
    backtrack: () => {
      if (S.track.pts.length < 2) {
        toast('ما فيه أثر مسجّل');
        return;
      }
      setTarget({ kind: 'track' });
      navigate('nav');
    },
    clear: (b) => confirmTwice(b, 'clear', () => {
      S.track = { rec: S.track.rec, pts: [] };
      store.set('track', S.track);
      toast('انمسح الأثر');
    }),
    windref: () => fetchWind(true),
    zin: () => {
      S.mapZoom = Math.min(18, S.mapZoom + 1);
      store.set('mapZoom', S.mapZoom);
    },
    zout: () => {
      S.mapZoom = Math.max(9, S.mapZoom - 1);
      store.set('mapZoom', S.mapZoom);
    },
    mnorth: () => {
      S.mapNorthUp = !S.mapNorthUp;
    },
    mlayer: () => {
      S.mapLayer = S.mapLayer === 'sat' ? 'osm' : 'sat';
      store.set('mapLayer', S.mapLayer);
      const layer = $('#m-tiles');
      layer.innerHTML = '';
      layer.className = `tiles-${S.mapLayer}`;
      screens.map.tiles = new Map();
    },
    calnorth: () => {
      if (S.rawHeading === null || !compassFresh()) {
        toast('ما فيه قراءة بوصلة للحين');
        return;
      }
      const h = S.cfg.invert ? 360 - S.rawHeading : S.rawHeading;
      S.cfg.offset = norm(-h);
      store.set('cfg', S.cfg);
      S.heading = null;
      toast('تمت المعايرة');
    },
    calinv: () => {
      S.cfg.invert = !S.cfg.invert;
      store.set('cfg', S.cfg);
      S.heading = null;
    },
    calreset: () => {
      S.cfg = { offset: 0, invert: false };
      store.set('cfg', S.cfg);
      S.heading = null;
      toast('رجعت المعايرة للأصل');
    },
  };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b && actions[b.dataset.act]) actions[b.dataset.act](b);
  });

  // ---------- شريط الحالة ----------
  function updateStatus() {
    const parts = [];
    if (DEMO) parts.push('<span class="warn">تجربة</span>');
    if (!S.pos) parts.push('<span class="warn">لا موقع</span>');
    else if (Date.now() - S.pos.at > 30000) parts.push('<span class="warn">الموقع قديم</span>');
    else parts.push(`<span class="ok">موقع ±${Math.round(S.pos.acc)} م</span>`);
    if (compassFresh()) parts.push('<span class="ok">بوصلة</span>');
    else if (headingValid()) parts.push('<span class="warn">اتجاه من المشي</span>');
    else parts.push('<span class="warn">لا اتجاه</span>');
    if (S.track.rec) parts.push('<span class="ok">يسجّل</span>');
    parts.push(new Date().toLocaleTimeString('ar-u-nu-latn', { hour: 'numeric', minute: '2-digit' }));
    const html = parts.join(' · ');
    const el = $('#status-info');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  // ---------- وضع التجربة (?demo) ----------
  function startDemo() {
    const start = { lat: 24.9, lon: 46.4 };
    if (!store.get('points', null)) {
      const mk = (id, type, name, b, m) => ({ id, type, name, ...offsetPoint(start, b, m), at: Date.now() });
      S.points = [
        mk('camp', 'camp', 'المخيم', 210, 450),
        mk('car', 'car', 'السيارة', 195, 520),
        mk('p1', 'well', 'بير الشعيب', 40, 2300),
        mk('p2', 'hunt', 'مكان الصيد', 95, 1300),
        mk('p3', 'road', 'طريق الإسفلت', 300, 3800),
      ];
      store.set('points', S.points);
    }
    let p = { ...start };
    let h = 30;
    S.track = { rec: true, pts: [] };
    setInterval(() => {
      h = norm(h + (Math.random() - 0.45) * 14);
      p = offsetPoint(p, h, 5);
      onPosition({ coords: { latitude: p.lat, longitude: p.lon, accuracy: 6, heading: null, speed: null } });
      S.rawHeading = h;
      setHeading(calibrated(h), 'بوصلة');
    }, 1000);
  }

  // ---------- البدء ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  history.replaceState({ screen: 'home' }, '');
  render('home');
  if (DEMO) startDemo();
  else if (store.get('enabled', false)) {
    attachOrientation();
    startGeo();
  }
  setInterval(() => {
    updateStatus();
    screens[S.screen].update?.();
  }, 300);
})();
