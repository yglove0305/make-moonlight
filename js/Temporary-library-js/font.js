/*!
 * FontKitJS - A minimal dependency, feature-rich font management and rendering helper.
 * Supports:
 *  - Dynamic font loading via CSS FontFace
 *  - Fallback chains and language-specific font selection
 *  - Variable font axis control (wght, wdth, slnt, ital, opsz)
 *  - OpenType feature flags (liga, kern, cvxx, ssxx, etc.) via CSS font-variation-settings and font-feature-settings
 *  - Async events, timeout handling, and robust error reporting
 *  - Canvas text measurement and baseline metrics approximation
 *  - Text shaping hints (basic) and grapheme splitting for safe operations
 *  - Font groups, named presets, and context-driven selection
 *  - Per-element binding with live updates and graceful degradation
 *
 * Limitations:
 *  - No complex script shaping (use HarfBuzz in native or browser WASM for full shaping)
 *  - Metrics approximations for baseline/ascender/descender use heuristic methods
 *  - Browser support relies on CSS FontFace and modern CSS properties
 *
 * Usage example:
 *  const fm = new FontManager();
 *  await fm.loadFont({
 *    name: 'Inter',
 *    src: [
 *      { url: '/fonts/Inter.var.woff2', format: 'woff2' }
 *    ],
 *    descriptors: { style: 'normal', weight: '100 900', stretch: '75% 125%' },
 *    axes: { wght: 500, wdth: 100, ital: 0, opsz: 14 },
 *    features: { liga: 1, kern: 1, ss01: 1 }
 *  });
 *  fm.applyToElement(document.querySelector('#title'), { family: 'Inter', size: 24, lineHeight: 1.3 });
 */

(function (global) {
  'use strict';

  /**
   * Utilities
   */
  const isString = (v) => typeof v === 'string';
  const isNumber = (v) => typeof v === 'number' && !Number.isNaN(v);
  const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  const toPercent = (v) => (isNumber(v) ? `${v}%` : isString(v) ? v : '100%');
  const toPx = (v) => (isNumber(v) ? `${v}px` : isString(v) ? v : '16px');
  const toUnitless = (v) => (isNumber(v) ? v : parseFloat(String(v)));
  const noop = () => {};

  // Basic grapheme split fallback (not perfect; for full use Intl.Segmenter if available)
  const splitGraphemes = (str) => {
    if (global.Intl && Intl.Segmenter) {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(seg.segment(str), (s) => s.segment);
    }
    // naive fallback: splits by code points with surrogate pair handling
    const out = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.codePointAt(i);
      const ch = String.fromCodePoint(c);
      out.push(ch);
      if (c > 0xffff) i++;
    }
    return out;
  };

  const cssEscape = (s) => {
    // Minimal CSS identifier escape for font names
    // Replace quotes and wrap in quotes if whitespace present
    const needsQuotes = /\s|["']/g.test(s);
    const safe = s.replace(/["']/g, '');
    return needsQuotes ? `"${safe}"` : safe;
  };

  const axisToString = (axes) => {
    if (!axes) return '';
    const parts = [];
    for (const [k, v] of Object.entries(axes)) {
      if (v == null) continue;
      // Axis values: slnt may be negative, ital 0/1, opsz unitless
      parts.push(`"${k}" ${isNumber(v) ? v : parseFloat(String(v))}`);
    }
    return parts.join(', ');
  };

  const featuresToString = (features) => {
    if (!features) return '';
    const parts = [];
    for (const [k, v] of Object.entries(features)) {
      if (v == null) continue;
      const flag = v ? 'on' : 'off';
      // For numeric cvXX, ssXX allow values:
      if (isNumber(v)) {
        parts.push(`"${k}" ${v}`);
      } else {
        parts.push(`"${k}" ${flag}`);
      }
    }
    return parts.join(', ');
  };

  // FontFace support check
  const supportsFontFace = !!global.FontFace;

  // Generate CSS for a font family with features and axes
  const buildFontStyleString = ({ family, weight, style, stretch, axes, features }) => {
    const lines = [];
    const varSettings = axisToString(axes);
    const featSettings = featuresToString(features);

    lines.push(`font-family: ${cssEscape(family)};`);
    if (style) lines.push(`font-style: ${style};`);
    if (weight) lines.push(`font-weight: ${weight};`);
    if (stretch) lines.push(`font-stretch: ${isNumber(stretch) ? `${stretch}%` : stretch};`);

    if (varSettings) lines.push(`font-variation-settings: ${varSettings};`);
    if (featSettings) lines.push(`font-feature-settings: ${featSettings};`);

    return lines.join(' ');
  };

  // Build @font-face css text for injection fallback
  const buildFontFaceCSS = (name, srcList, descriptors) => {
    const src = srcList
      .map((s) => {
        const fmt = s.format ? ` format("${s.format}")` : '';
        return `url("${s.url}")${fmt}`;
      })
      .join(', ');
    const d = descriptors || {};
    const props = [];
    if (d.style) props.push(`font-style: ${d.style};`);
    if (d.weight) props.push(`font-weight: ${d.weight};`);
    if (d.stretch) props.push(`font-stretch: ${d.stretch};`);
    if (d.display) props.push(`font-display: ${d.display};`);
    if (d.unicodeRange) props.push(`unicode-range: ${d.unicodeRange};`);

    return `@font-face { font-family: ${cssEscape(name)}; src: ${src}; ${props.join(' ')} }`;
  };

  /**
   * FontDescriptor type:
   * {
   *   name: string
   *   src: [{ url: string, format?: 'woff2'|'woff'|'truetype'|'opentype'|'embedded-opentype'|'svg' }]
   *   descriptors?: { style?: string, weight?: string|number, stretch?: string|number, display?: 'auto'|'block'|'swap'|'fallback'|'optional', unicodeRange?: string }
   *   axes?: { wght?: number, wdth?: number, slnt?: number, ital?: number, opsz?: number, ... }
   *   features?: { liga?: 0|1, kern?:0|1, ss01?:0|1, cv01?: number, ... }
   *   fallback?: string[] // e.g. ['Apple SD Gothic Neo', 'Segoe UI', 'Noto Sans KR', 'sans-serif']
   *   languages?: string[] // tags like ['ko', 'en', 'ja']
   * }
   */

  class EventEmitter {
    constructor() {
      this.listeners = new Map();
    }
    on(type, fn) {
      const arr = this.listeners.get(type) || [];
      arr.push(fn);
      this.listeners.set(type, arr);
      return () => this.off(type, fn);
    }
    off(type, fn) {
      const arr = this.listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
    emit(type, payload) {
      const arr = this.listeners.get(type);
      if (!arr || arr.length === 0) return;
      for (const fn of arr.slice()) {
        try {
          fn(payload);
        } catch (e) {
          // Swallow listener errors
          console.error('[FontKitJS] Listener error', e);
        }
      }
    }
  }

  class FontRegistry {
    constructor() {
      this.map = new Map(); // name -> descriptor
    }
    has(name) {
      return this.map.has(name);
    }
    get(name) {
      return this.map.get(name);
    }
    set(name, desc) {
      this.map.set(name, desc);
    }
    all() {
      return Array.from(this.map.values());
    }
  }

  class StyleInjector {
    constructor() {
      this.styleEl = null;
      this.rules = new Set();
    }
    ensureNode() {
      if (this.styleEl) return;
      const el = document.createElement('style');
      el.type = 'text/css';
      el.setAttribute('data-fontkitjs', 'true');
      document.head.appendChild(el);
      this.styleEl = el;
    }
    inject(cssText) {
      this.ensureNode();
      if (this.rules.has(cssText)) return;
      this.styleEl.appendChild(document.createTextNode(cssText));
      this.rules.add(cssText);
    }
  }

  class FontLoader {
    constructor({ timeout = 10000 } = {}) {
      this.timeout = timeout;
      this.injector = new StyleInjector();
    }

    async load(desc) {
      if (!supportsFontFace) {
        // Fallback: inject @font-face and hope the browser loads it
        const css = buildFontFaceCSS(desc.name, desc.src, desc.descriptors);
        this.injector.inject(css);
        return { status: 'injected', font: null };
      }

      // Build source string for FontFace constructor
      const srcString = desc.src
        .map((s) => {
          const fmt = s.format ? ` format("${s.format}")` : '';
          return `url("${s.url}")${fmt}`;
        })
        .join(', ');

      const { style = 'normal', weight = 'normal', stretch = 'normal', display, unicodeRange } =
        desc.descriptors || {};

      const fontFace = new FontFace(desc.name, srcString, {
        style,
        weight,
        stretch,
        display,
        unicodeRange,
      });

      const timer = this.timeout ? setTimeout(() => fontFace.cancel && fontFace.cancel(), this.timeout) : null;

      try {
        const loaded = await fontFace.load();
        if (timer) clearTimeout(timer);
        document.fonts.add(loaded);
        return { status: 'loaded', font: loaded };
      } catch (e) {
        if (timer) clearTimeout(timer);
        // Inject @font-face as a last resort
        const css = buildFontFaceCSS(desc.name, desc.src, desc.descriptors);
        this.injector.inject(css);
        return { status: 'failed', error: e, font: null };
      }
    }

    async waitFor(family, testText = 'abcdefghijklmnopqrstuvwxyz가나다라마바사아자차카타파하1234567890', fontStyle = {}) {
      // Measure-based load detection: compare width changes when font is applied.
      const probe = document.createElement('span');
      probe.textContent = testText;
      const style = Object.assign(
        {
          position: 'absolute',
          left: '-9999px',
          top: '-9999px',
          fontSize: '32px',
          lineHeight: 'normal',
          fontFamily: 'monospace',
          visibility: 'hidden',
        },
        fontStyle
      );
      for (const [k, v] of Object.entries(style)) {
        probe.style[k] = v;
      }
      document.body.appendChild(probe);
      const baseWidth = probe.getBoundingClientRect().width;

      probe.style.fontFamily = `${cssEscape(family)}, monospace`;

      const start = performance.now();
      const timeoutAt = start + this.timeout;

      return new Promise((resolve) => {
        const tick = () => {
          const w = probe.getBoundingClientRect().width;
          const delta = Math.abs(w - baseWidth);
          if (delta > 0.5) {
            probe.remove();
            resolve(true);
            return;
          }
          if (performance.now() > timeoutAt) {
            probe.remove();
            resolve(false);
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
      });
    }
  }

  class FontMetrics {
    constructor() {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');
      this.canvas.width = 1024;
      this.canvas.height = 256;
    }

    setStyle(style) {
      const { family, size = 16, weight, stretch, style: fontStyle, axes, features } = style;
      const parts = [];
      // CSS font shorthand is finicky; we’ll set properties individually on canvas
      const familyStr = cssEscape(family);
      this.ctx.font = `${fontStyle || 'normal'} ${isString(weight) || isNumber(weight) ? weight : 'normal'} ${toPx(
        size
      )} ${familyStr}`;
      // Canvas currently does not support font-variation-settings directly; we approximate by CSS application when measuring via DOM.
      // For baseline metrics, we’ll use pixel inspection technique.
    }

    measureText(text, style) {
      this.setStyle(style);
      const m = this.ctx.measureText(text || '');
      return {
        width: m.width,
        actualBoundingBoxAscent: m.actualBoundingBoxAscent || 0,
        actualBoundingBoxDescent: m.actualBoundingBoxDescent || 0,
        fontBoundingBoxAscent: m.fontBoundingBoxAscent || 0,
        fontBoundingBoxDescent: m.fontBoundingBoxDescent || 0,
        emHeightAscent: m.emHeightAscent || 0,
        emHeightDescent: m.emHeightDescent || 0,
        emHeight: (m.emHeightAscent || 0) + (m.emHeightDescent || 0),
      };
    }

    estimateLineHeight(style) {
      const size = toUnitless(style.size || 16);
      const lh = style.lineHeight;
      if (lh == null) return size * 1.25; // heuristic default
      if (isNumber(lh)) return size * lh;
      if (isString(lh) && lh.endsWith('px')) return parseFloat(lh);
      if (isString(lh) && lh.endsWith('%')) return size * (parseFloat(lh) / 100);
      return size * parseFloat(String(lh));
    }

    // Pixel-based baseline approximation by drawing text to canvas and scanning
    baseline(text, style) {
      this.setStyle(style);
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#000';
      const x = 20;
      const y = 150;
      ctx.fillText(text || 'Hg', x, y);

      const img = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
      // Scan rows for non-empty pixels around y to find descent line
      const width = this.canvas.width;
      const height = this.canvas.height;

      let ascentRow = y;
      let descentRow = y;

      // Search upwards for ascent
      for (let row = y; row >= 0; row--) {
        const offset = row * width * 4;
        let hasInk = false;
        for (let col = 0; col < width; col++) {
          const a = img[offset + col * 4 + 3];
          if (a > 0) {
            hasInk = true;
            break;
          }
        }
        if (hasInk) ascentRow = row;
        else break;
      }

      // Search downwards for descent
      for (let row = y; row < height; row++) {
        const offset = row * width * 4;
        let hasInk = false;
        for (let col = 0; col < width; col++) {
          const a = img[offset + col * 4 + 3];
          if (a > 0) {
            hasInk = true;
            break;
          }
        }
        if (hasInk) descentRow = row;
        else break;
      }

      return {
        baselineY: y,
        ascent: y - ascentRow,
        descent: descentRow - y,
        total: (y - ascentRow) + (descentRow - y),
      };
    }
  }

  class FontManager extends EventEmitter {
    constructor(options = {}) {
      super();
      const { timeout = 10000, defaultLanguage, defaultFallback = ['system-ui', 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', 'sans-serif'] } = options;
      this.loader = new FontLoader({ timeout });
      this.registry = new FontRegistry();
      this.metrics = new FontMetrics();
      this.defaultLanguage = defaultLanguage || detectLanguage();
      this.defaultFallback = Array.isArray(defaultFallback) ? defaultFallback.slice() : ['sans-serif'];
      this.presets = new Map(); // name -> style preset
    }

    registerPreset(name, style) {
      this.presets.set(name, style);
      this.emit('preset', { name, style });
    }

    getPreset(name) {
      return this.presets.get(name);
    }

    async loadFont(desc) {
      if (!desc || !desc.name || !Array.isArray(desc.src) || desc.src.length === 0) {
        throw new Error('Invalid font descriptor: missing name/src');
      }
      // Normalize descriptors
      const normalized = Object.assign({}, desc);
      normalized.descriptors = Object.assign({ display: 'swap' }, desc.descriptors || {});
      normalized.fallback = Array.isArray(desc.fallback) ? desc.fallback.slice() : this.defaultFallback.slice();
      normalized.languages = Array.isArray(desc.languages) ? desc.languages.slice() : [];

      // Load
      const result = await this.loader.load(normalized);
      this.registry.set(normalized.name, normalized);
      this.emit('load', { name: normalized.name, result });

      // Optional wait-for
      const ok = await this.loader.waitFor(normalized.name);
      this.emit('ready', { name: normalized.name, ok });

      return { name: normalized.name, ok, result };
    }

    ensureFonts(fonts) {
      return Promise.all(fonts.map((f) => this.loadFont(f)));
    }

    getFont(name) {
      return this.registry.get(name);
    }

    listFonts() {
      return this.registry.all();
    }

    /**
     * Compose font-family string with fallback chain. If languages provided, prefer language-specific fonts first.
     */
    composeFamily(primary, fallback, languages) {
      const parts = [];
      const add = (name) => {
        if (!name) return;
        parts.push(cssEscape(name));
      };

      // Language-specific ordering: if registry has fonts tagged with desired language, elevate them
      const langSet = new Set((languages && languages.length ? languages : [this.defaultLanguage]).filter(Boolean));
      const langMatches = [];
      for (const f of this.registry.all()) {
        if (!f.languages || f.languages.length === 0) continue;
        for (const l of f.languages) {
          if (langSet.has(l)) {
            langMatches.push(f.name);
            break;
          }
        }
      }

      add(primary);
      for (const lm of langMatches) {
        if (lm !== primary) add(lm);
      }
      for (const fb of fallback || this.defaultFallback) add(fb);

      return parts.join(', ');
    }

    /**
     * Apply style to a DOM element, respecting variable axes and features.
     */
    applyToElement(el, style) {
      if (!el || !el.style) return;

      const {
        family,
        size = 16,
        weight = 'normal',
        stretch = 'normal',
        style: fontStyle = 'normal',
        axes,
        features,
        fallback,
        languages,
        lineHeight,
        letterSpacing,
        color,
      } = style;

      const familyStr = this.composeFamily(family, fallback, languages);

      el.style.fontFamily = familyStr;
      el.style.fontSize = toPx(size);
      el.style.fontWeight = isString(weight) || isNumber(weight) ? String(weight) : 'normal';
      el.style.fontStretch = isNumber(stretch) ? `${stretch}%` : String(stretch);
      el.style.fontStyle = fontStyle;
      if (axes && Object.keys(axes).length) {
        el.style.fontVariationSettings = axisToString(axes);
      } else {
        el.style.fontVariationSettings = '';
      }
      if (features && Object.keys(features).length) {
        el.style.fontFeatureSettings = featuresToString(features);
      } else {
        el.style.fontFeatureSettings = '';
      }
      if (lineHeight != null) el.style.lineHeight = isNumber(lineHeight) ? String(lineHeight) : String(lineHeight);
      if (letterSpacing != null) el.style.letterSpacing = isNumber(letterSpacing) ? `${letterSpacing}px` : String(letterSpacing);
      if (color) el.style.color = color;
    }

    /**
     * Generate CSS class for a font style and inject into document head.
     */
    createClass(className, style) {
      const family = this.composeFamily(style.family, style.fallback, style.languages);
      const css = [
        `.${className} {`,
        `  font-family: ${family};`,
        `  font-size: ${toPx(style.size || 16)};`,
        `  font-weight: ${style.weight != null ? style.weight : 'normal'};`,
        `  font-style: ${style.style || 'normal'};`,
        `  font-stretch: ${isNumber(style.stretch) ? `${style.stretch}%` : style.stretch || 'normal'};`,
      ];
      if (style.axes && Object.keys(style.axes).length) {
        css.push(`  font-variation-settings: ${axisToString(style.axes)};`);
      }
      if (style.features && Object.keys(style.features).length) {
        css.push(`  font-feature-settings: ${featuresToString(style.features)};`);
      }
      if (style.lineHeight != null) {
        css.push(`  line-height: ${isNumber(style.lineHeight) ? style.lineHeight : style.lineHeight};`);
      }
      if (style.letterSpacing != null) {
        css.push(`  letter-spacing: ${isNumber(style.letterSpacing) ? `${style.letterSpacing}px` : style.letterSpacing};`);
      }
      if (style.color) {
        css.push(`  color: ${style.color};`);
      }
      css.push('}');

      const injector = this.loader.injector;
      injector.inject(css.join('\n'));
      this.emit('class', { className, style });
    }

    measure(text, style) {
      return this.metrics.measureText(text, style);
    }

    baseline(text, style) {
      return this.metrics.baseline(text, style);
    }

    estimateLineHeight(style) {
      return this.metrics.estimateLineHeight(style);
    }

    /**
     * Text rendering helpers
     */
    renderText(el, text, style) {
      el.textContent = text;
      this.applyToElement(el, style);
      return this.measure(text, style);
    }

    /**
     * Variable font axis utilities
     */
    setAxis(el, axisName, value) {
      const current = parseAxis(el.style.fontVariationSettings);
      current[axisName] = value;
      el.style.fontVariationSettings = axisToString(current);
    }

    getAxis(el, axisName) {
      const current = parseAxis(el.style.fontVariationSettings);
      return current[axisName];
    }

    setFeature(el, featureName, value) {
      const current = parseFeatures(el.style.fontFeatureSettings);
      current[featureName] = value;
      el.style.fontFeatureSettings = featuresToString(current);
    }

    getFeature(el, featureName) {
      const current = parseFeatures(el.style.fontFeatureSettings);
      return current[featureName];
    }

    /**
     * Animate variable axes (e.g., weight or optical size)
     */
    animateAxis(el, axisName, from, to, { duration = 800, easing = easeInOut, onUpdate = noop, onComplete = noop } = {}) {
      const start = performance.now();
      const tick = (now) => {
        const t = clamp((now - start) / duration, 0, 1);
        const val = from + (to - from) * easing(t);
        this.setAxis(el, axisName, val);
        onUpdate(val, t);
        if (t < 1) requestAnimationFrame(tick);
        else onComplete(val);
      };
      requestAnimationFrame(tick);
    }

    /**
     * Bind a font style to an element with live updates
     */
    bindElement(el, style) {
      const state = { style: Object.assign({}, style) };
      this.applyToElement(el, state.style);
      const api = {
        update(patch) {
          Object.assign(state.style, patch);
          // Re-compute family if fallback/languages changed
          this.apply();
        },
        apply: () => {
          this.applyToElement(el, state.style);
        },
        measure: () => this.measure(el.textContent || '', state.style),
        baseline: () => this.baseline(el.textContent || '', state.style),
        get style() {
          return Object.assign({}, state.style);
        },
      };
      return api;
    }

    /**
     * Select a font by context (script, weight range, variable support)
     */
    select({ languages = [this.defaultLanguage], variable = true, weightRange, prefer }) {
      const matches = [];
      for (const f of this.registry.all()) {
        const hasLang = !f.languages || f.languages.length === 0 || f.languages.some((l) => languages.includes(l));
        const hasVar = variable ? supportsVariableWeight(f) : true;
        const weightOk = weightRange ? supportsWeightRange(f, weightRange) : true;
        const preferred = prefer ? f.name.toLowerCase().includes(prefer.toLowerCase()) : true;
        if (hasLang && hasVar && weightOk && preferred) matches.push(f);
      }
      // Basic ranking: prefer variable, then language match, then name preference
      matches.sort((a, b) => {
        const avar = supportsVariableWeight(a) ? 1 : 0;
        const bvar = supportsVariableWeight(b) ? 1 : 0;
        if (avar !== bvar) return bvar - avar;
        const alang = scoreLang(a.languages, languages);
        const blang = scoreLang(b.languages, languages);
        if (alang !== blang) return blang - alang;
        if (prefer) {
          const ap = a.name.toLowerCase().includes(prefer.toLowerCase()) ? 1 : 0;
          const bp = b.name.toLowerCase().includes(prefer.toLowerCase()) ? 1 : 0;
          if (ap !== bp) return bp - ap;
        }
        return a.name.localeCompare(b.name);
      });
      return matches;
    }
  }

  // Helpers for parsing existing CSS settings on elements
  function parseAxis(s) {
    const out = {};
    if (!s) return out;
    // Expected format: "wght" 500, "wdth" 100
    const re = /"([A-Za-z0-9]{3,4})"\s+(-?\d+(\.\d+)?)/g;
    let m;
    while ((m = re.exec(s))) {
      out[m[1]] = parseFloat(m[2]);
    }
    return out;
  }

  function parseFeatures(s) {
    const out = {};
    if (!s) return out;
    // Formats: "liga" on/off, "cv01" 2, "kern" on
    const reNum = /"([A-Za-z0-9]{3,4})"\s+(-?\d+)/g;
    const reFlag = /"([A-Za-z0-9]{3,4})"\s+(on|off)/g;
    let m;
    while ((m = reNum.exec(s))) {
      out[m[1]] = parseInt(m[2], 10);
    }
    while ((m = reFlag.exec(s))) {
      out[m[1]] = m[2] === 'on' ? 1 : 0;
    }
    return out;
  }

  function supportsVariableWeight(f) {
    const d = f.descriptors || {};
    const w = d.weight;
    if (isString(w) && /\d+\s+\d+/.test(w)) return true; // e.g., "100 900"
    return false;
  }

  function supportsWeightRange(f, [min, max]) {
    const d = f.descriptors || {};
    const w = d.weight;
    if (isString(w) && /\d+\s+\d+/.test(w)) {
      const [a, b] = w.split(/\s+/).map((x) => parseInt(x, 10));
      return a <= min && b >= max;
    }
    if (isNumber(w)) return w >= min && w <= max;
    return true;
  }

  function scoreLang(fontLangs, desired) {
    if (!fontLangs || fontLangs.length === 0) return 0;
    let score = 0;
    for (const d of desired) {
      if (fontLangs.includes(d)) score++;
    }
    return score;
  }

  function detectLanguage() {
    const nav = global.navigator;
    const langs = (nav && (nav.languages || [nav.language])) || [];
    const primary = (langs[0] || 'en').toLowerCase();
    // Map to simple codes
    if (primary.startsWith('ko')) return 'ko';
    if (primary.startsWith('ja')) return 'ja';
    if (primary.startsWith('zh')) return 'zh';
    if (primary.startsWith('en')) return 'en';
    return primary.split('-')[0];
  }

  // Easing function for axis animation
  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  /**
   * Example: Preconfigure some presets helpful for Korean text.
   */
  function createKoreanPresets(fontManager) {
    fontManager.registerPreset('body-kr', {
      family: 'Noto Sans KR',
      size: 16,
      lineHeight: 1.6,
      weight: 400,
      stretch: 'normal',
      style: 'normal',
      features: { liga: 1, kern: 1 },
      fallback: ['Apple SD Gothic Neo', 'Segoe UI', 'system-ui', 'sans-serif'],
      languages: ['ko'],
    });

    fontManager.registerPreset('headline-kr', {
      family: 'Pretendard',
      size: 28,
      lineHeight: 1.3,
      weight: 700,
      style: 'normal',
      axes: { wght: 700, wdth: 100, opsz: 28 },
      features: { liga: 1, kern: 1 },
      fallback: ['Noto Sans KR', 'Apple SD Gothic Neo', 'system-ui', 'sans-serif'],
      languages: ['ko'],
    });

    fontManager.registerPreset('mono', {
      family: 'JetBrains Mono',
      size: 14,
      lineHeight: 1.5,
      weight: 400,
      style: 'normal',
      features: { liga: 1, kern: 1, ss01: 1 },
      fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      languages: ['en', 'ko'],
    });
  }

  // Expose global
  const api = {
    FontManager,
    splitGraphemes,
    createKoreanPresets,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.FontKitJS = api;
  }

})(typeof window !== 'undefined' ? window : globalThis);


/* ---------------------------
   Example usage (remove in production)
----------------------------- */

(async function exampleUsage() {
  if (typeof document === 'undefined') return;

  const { FontManager, createKoreanPresets } = window.FontKitJS;
  const fm = new FontManager({ timeout: 15000, defaultLanguage: 'ko' });

  // Listen to events
  fm.on('load', ({ name, result }) => {
    console.log(`[FontKitJS] Loaded font ${name} with status: ${result.status}`);
  });
  fm.on('ready', ({ name, ok }) => {
    console.log(`[FontKitJS] Font ready ${name}: ${ok}`);
  });
  fm.on('class', ({ className }) => {
    console.log(`[FontKitJS] CSS class injected: .${className}`);
  });

  // Register presets
  createKoreanPresets(fm);

  // Load fonts (you must host these URLs or adjust)
  try {
    await fm.ensureFonts([
      {
        name: 'Pretendard',
        src: [
          { url: '/fonts/PretendardVariable.woff2', format: 'woff2' },
        ],
        descriptors: { style: 'normal', weight: '100 900', display: 'swap' },
        axes: { wght: 400, wdth: 100, opsz: 14 },
        features: { liga: 1, kern: 1 },
        fallback: ['Noto Sans KR', 'Apple SD Gothic Neo', 'system-ui', 'sans-serif'],
        languages: ['ko'],
      },
      {
        name: 'Noto Sans KR',
        src: [
          { url: '/fonts/NotoSansKR-Regular.woff2', format: 'woff2' },
        ],
        descriptors: { style: 'normal', weight: 400, display: 'swap' },
        features: { liga: 1, kern: 1 },
        fallback: ['Apple SD Gothic Neo', 'system-ui', 'sans-serif'],
        languages: ['ko'],
      },
      {
        name: 'JetBrains Mono',
        src: [
          { url: '/fonts/JetBrainsMono-Variable.woff2', format: 'woff2' },
        ],
        descriptors: { style: 'normal', weight: '100 800', display: 'swap' },
        axes: { wght: 400, wdth: 100, ital: 0 },
        features: { liga: 1, kern: 1, ss01: 1 },
        fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        languages: ['en', 'ko'],
      },
    ]);
  } catch (e) {
    console.warn('[FontKitJS] Font load error', e);
  }

  // Apply to elements
  const header = document.getElementById('header');
  const body = document.getElementById('body');
  const code = document.getElementById('code');

  if (header) {
    fm.applyToElement(header, fm.getPreset('headline-kr') || {
      family: 'Pretendard',
      size: 28,
      lineHeight: 1.3,
      weight: 700,
      axes: { wght: 700, wdth: 100, opsz: 28 },
      features: { liga: 1, kern: 1 },
      fallback: ['Noto Sans KR', 'system-ui', 'sans-serif'],
      languages: ['ko'],
    });
  }

  if (body) {
    fm.applyToElement(body, fm.getPreset('body-kr') || {
      family: 'Noto Sans KR',
      size: 16,
      lineHeight: 1.6,
      weight: 400,
      features: { liga: 1, kern: 1 },
      fallback: ['Apple SD Gothic Neo', 'system-ui', 'sans-serif'],
      languages: ['ko'],
    });
  }

  if (code) {
    const binding = fm.bindElement(code, fm.getPreset('mono') || {
      family: 'JetBrains Mono',
      size: 14,
      lineHeight: 1.5,
      weight: 400,
      features: { liga: 1, kern: 1, ss01: 1 },
      fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      languages: ['en', 'ko'],
    });

    // Animate weight axis
    fm.animateAxis(code, 'wght', 300, 700, {
      duration: 1200,
      onUpdate: (val) => {
        // Optional live measurement
        const m = fm.measure(code.textContent || '', binding.style);
        // console.log('axis wght:', val.toFixed(0), 'width:', m.width.toFixed(2));
      },
    });
  }

  // Create and inject a class
  fm.createClass('title-font', {
    family: 'Pretendard',
    size: 32,
    weight: 800,
    style: 'normal',
    axes: { wght: 800, wdth: 100, opsz: 32 },
    features: { liga: 1, kern: 1 },
    fallback: ['Noto Sans KR', 'system-ui', 'sans-serif'],
    languages: ['ko'],
    lineHeight: 1.2,
    letterSpacing: 0.2,
    color: '#111',
  });

})();
