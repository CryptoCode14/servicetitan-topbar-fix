// ==UserScript==
// @name         ServiceTitan Top Bar - Bring Back Global Navigation
// @namespace    grandvalley.servicetitan.topbar
// @version      1.2.0
// @description  Restores ServiceTitan's old top-bar layout (Global Navigation): the module nav moves from the left sidebar to a horizontal bar under the top header, with hover dropdown submenus. CSS-first - ServiceTitan's own links and click handlers are never moved or replaced, so navigation stays exactly as fast as stock. Alt+T toggles it on/off, Alt+R shows a diagnostic panel.
// @author       Gus for Westin / Grand Valley Garage Doors
// @match        https://go.servicetitan.com/*
// @downloadURL  https://raw.githubusercontent.com/CryptoCode14/servicetitan-topbar-fix/main/servicetitan-topbar.user.js
// @updateURL    https://raw.githubusercontent.com/CryptoCode14/servicetitan-topbar-fix/main/servicetitan-topbar.user.js
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

/*
  HOW IT WORKS (and why it is safe):
  - The script NEVER moves, clones, or replaces any ServiceTitan DOM node.
    Moving nodes a React app owns is the classic way to crash it
    (reconciliation desync). Instead the script only TAGS the existing
    elements with gv-tb-* classes and injects CSS that re-lays the tagged
    sidebar out as a horizontal bar. Every link, badge, chevron handler,
    and hover behavior underneath is still ServiceTitan's own.
  - Nothing is anchored on ServiceTitan's generated class names (they are
    hashed and change with releases). Discovery uses only stable hooks:
    link hrefs, visible module names, aria labels ("Expand X submenu"),
    the "Collapse Menu" button text, and on-screen position/size.
  - Submenus: in the sidebar they are inline accordions. As a top bar we
    need dropdowns, so on hover/focus the script clicks the module's own
    chevron once (ServiceTitan renders its submenu), and CSS positions
    that submenu as a dropdown under the bar. On mouse-leave it clicks
    the chevron again to put things back. Clicks are ServiceTitan's own
    toggle - the script never builds or edits menu content.
  - Performance: after the one-time tagging there is NO polling loop and
    NO whole-document observer. A small observer watches only the nav
    subtree (childList) so a ServiceTitan re-render that swaps the nav
    node gets re-tagged, plus a 2.5s existence check that does a couple
    of class lookups. CSS does all layout work, so clicks and route
    changes run at stock speed.
  - Escape hatches: Alt+T (or the Tampermonkey menu command) turns the
    whole thing off instantly and ServiceTitan returns to its stock
    sidebar, byte for byte. The choice is remembered per browser.
  - Alt+R opens a diagnostics panel describing exactly what the script
    found (strategy, item/submenu counts, layout mode) - screenshot it
    and send it to Gus if anything ever looks wrong after an ST update.
*/

(function () {
  'use strict';

  /* ============================ CONFIG ============================ */
  const CONFIG = {
    barHeight: 52,          // px height of the restored top nav bar
    expandWhenCollapsed: true, // if ST starts with the collapsed icon rail, expand it once so the bar has labels (restored on toggle-off)
    debugOutline: false,    // true = colored outlines around every tagged element (for screenshots)
  };

  const MODULES = [
    'Dashboard', 'Calls', 'Schedule', 'Dispatch', 'Accounting',
    'Purchasing', 'Follow Up', 'Reports', 'Marketing', 'Pricebook', 'Tasks',
  ];
  // Exact root hrefs -> module name, used ONLY for icon-only anchors (no
  // visible label). Prefix matching is deliberately NOT used: submenu
  // links live under the module root (e.g. /new/accounting/invoices) and
  // a prefix match would misread them as the module itself - that bug
  // broke item detection for any module whose submenu was already open.
  const HREF_ROOTS = [
    ['#/new/dashboards', 'Dashboard'], ['#/Calls', 'Calls'], ['#/Calendar', 'Schedule'],
    ['#/DispatchBoard', 'Dispatch'], ['#/new/accounting', 'Accounting'],
    ['#/new/reports', 'Reports'], ['#/new/pricebook', 'Pricebook'], ['#/TaskManagement', 'Tasks'],
  ];

  const LS_KEY = 'gv-topbar-enabled';
  const diag = {
    version: '1.2.0', strategy: null, mode: null, items: 0, submenus: 0,
    headerPx: null, autoExpanded: false, runs: 0, warnings: [], samples: [], visibleItems: null,
    startedAt: new Date().toISOString(),
  };
  window.__gvTopbarDiag = diag;

  const log = (...a) => { try { console.log('[GV TopBar]', ...a); } catch (e) {} };
  const txt = (el) => ((el && el.textContent) || '').trim().replace(/\s+/g, ' ');
  // v1.1 lesson (live failure, Westin's screenshot 2026-10-22): v1.0 read
  // ONLY textContent and demanded an exact match after stripping a
  // TRAILING badge count. Real ServiceTitan labels defeat that three
  // ways: the badge count can come FIRST ("2 Calls"), an icon glyph can
  // precede the name, and some controls are icon-only with the name in
  // aria-label instead of text. So: read aria-label first, and normalize
  // by dropping every non-word character and every pure-number token
  // before comparing. "2 <glyph> Calls" and "Calls 1" both -> "Calls".
  const labelOf = (el) => ((el && (el.getAttribute('aria-label') || el.textContent)) || '').trim().replace(/\s+/g, ' ');
  function normalizeLabel(s) {
    return (s || '')
      .replace(/[^A-Za-z0-9& ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !/^\d+$/.test(t))
      .join(' ')
      .trim();
  }
  // elements that can carry a module entry: real links first, but also
  // buttons / ARIA links in case a build renders rows without anchors
  const CLICKABLE = 'a[href], button, [role="link"], [role="menuitem"]';

  function moduleNameOf(a) {
    if (!a) return null;
    for (const src of [a.getAttribute && a.getAttribute('aria-label'), a.textContent]) {
      const n = normalizeLabel(src || '');
      if (n && MODULES.includes(n)) return n;
    }
    if (a.tagName === 'A') {
      const href = a.getAttribute('href') || '';
      const hash = href.slice(href.indexOf('#'));
      for (const [root, name] of HREF_ROOTS) {
        if (hash === root) return name;
      }
    }
    return null;
  }

  /* ============================== CSS ============================== */
  const CSS = `
  /* ---- shell: turn the row layout into a column (bar on top, page below) ---- */
  html.gv-tb-on .gv-tb-shell-flex {
    flex-direction: column !important;
    align-items: stretch !important;
  }
  html.gv-tb-on .gv-tb-shell-grid {
    grid-template-columns: 1fr !important;
    grid-template-rows: ${CONFIG.barHeight}px minmax(0, 1fr) !important;
  }
  html.gv-tb-on .gv-tb-navwrap {
    width: 100% !important; max-width: none !important; min-width: 0 !important;
    height: ${CONFIG.barHeight}px !important; max-height: ${CONFIG.barHeight}px !important;
    flex: 0 0 ${CONFIG.barHeight}px !important;
    order: -1 !important;
    overflow: visible !important;
    z-index: 900;
  }
  /* fixed fallback (shell flex/grid not found): pin the bar under the header */
  html.gv-tb-on.gv-tb-fixedmode .gv-tb-nav {
    position: fixed !important;
    top: var(--gv-tb-top, 50px) !important;
    left: 0 !important; right: 0 !important;
    height: ${CONFIG.barHeight}px !important;
    z-index: 900 !important;
  }
  html.gv-tb-on.gv-tb-fixedmode .gv-tb-content {
    margin-top: ${CONFIG.barHeight}px !important;
  }

  /* ---- the nav itself: a horizontal bar ---- */
  html.gv-tb-on .gv-tb-nav {
    width: 100% !important; max-width: none !important; min-width: 0 !important;
    height: ${CONFIG.barHeight}px !important; max-height: ${CONFIG.barHeight}px !important;
    display: flex !important; flex-direction: row !important; align-items: center !important;
    overflow: visible !important;
    padding: 0 !important; margin: 0 !important;
  }
  html.gv-tb-on .gv-tb-nav > * {
    height: ${CONFIG.barHeight}px !important;
    display: flex !important; flex-direction: row !important; align-items: center !important;
    min-width: 0 !important;
  }
  html.gv-tb-on .gv-tb-list {
    display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important;
    align-items: stretch !important;
    height: ${CONFIG.barHeight}px !important;
    overflow-x: auto !important; overflow-y: hidden !important;
    scrollbar-width: none !important;
    margin: 0 !important; padding: 0 6px !important;
    flex: 1 1 auto !important; min-width: 0 !important;
    list-style: none !important;
  }
  html.gv-tb-on .gv-tb-list::-webkit-scrollbar { display: none !important; }

  /* ---- one module in the bar ---- */
  html.gv-tb-on .gv-tb-item {
    position: relative !important;
    display: flex !important; flex-direction: row !important; align-items: center !important;
    flex: 0 0 auto !important;
    height: ${CONFIG.barHeight}px !important;
    width: auto !important; min-width: 0 !important;
    padding: 0 8px !important; margin: 0 !important;
    overflow: visible !important;
  }
  html.gv-tb-on .gv-tb-link {
    display: flex !important; align-items: center !important; gap: 6px !important;
    white-space: nowrap !important;
    width: auto !important; height: auto !important;
    padding: 6px 4px !important;
  }
  html.gv-tb-on .gv-tb-item.gv-tb-active {
    box-shadow: inset 0 -3px 0 0 var(--gv-tb-accent, #4da3ff) !important;
  }
  html.gv-tb-on .gv-tb-chevron {
    position: static !important;
    flex: 0 0 auto !important;
    margin: 0 0 0 1px !important;
  }
  /* the collapse/expand rail control makes no sense in a top bar */
  html.gv-tb-on .gv-tb-collapse-row { display: none !important; }

  /* ---- submenus become dropdowns ----
     position:fixed (coordinates set inline by JS on open) is deliberate:
     the bar's list scrolls horizontally, and an absolutely-positioned
     dropdown inside it gets CLIPPED by the list's overflow box - it
     measures right and displays, but paints nothing (found in visual
     testing, loop 2). Fixed positioning escapes ancestor overflow. */
  html.gv-tb-on .gv-tb-submenu {
    position: fixed !important;
    display: none !important;
    flex-direction: column !important; align-items: stretch !important;
    min-width: 250px !important; max-width: 350px !important; width: max-content !important;
    overflow-y: auto !important; overflow-x: hidden !important;
    height: auto !important; max-height: min(72vh, 580px) !important;
    background: var(--gv-tb-navbg, #14263f) !important;
    color: var(--gv-tb-fg, #fff) !important;
    box-shadow: 0 10px 28px rgba(0,0,0,.35) !important;
    border-radius: 0 0 8px 8px !important;
    padding: 6px 0 !important; margin: 0 !important;
    z-index: 950 !important;
  }
  /* shown only via the JS-managed .gv-tb-open class, never pure :hover -
     JS must position the fixed dropdown in the same frame it appears */
  html.gv-tb-on .gv-tb-item.gv-tb-open > .gv-tb-submenu {
    display: flex !important;
  }
  html.gv-tb-on .gv-tb-submenu > *, html.gv-tb-on .gv-tb-submenu li, html.gv-tb-on .gv-tb-submenu ul {
    width: auto !important; max-width: none !important;
  }
  html.gv-tb-on .gv-tb-sub-link {
    display: flex !important; white-space: nowrap !important;
    padding: 6px 16px !important; width: auto !important;
  }

  /* ---- visibility insurance (only when the audit trips it) ----
     If ServiceTitan paints the links in a way that disappears inside the
     bar (dark-on-dark color, visibility/opacity state, font-size:0
     icon-mode with 1em-sized SVG icons), the audit adds gv-tb-fixviz
     and these rules force the links readable. Off by default. */
  html.gv-tb-on.gv-tb-fixviz .gv-tb-link {
    color: #eef4fb !important;
    font-size: 14px !important;
    visibility: visible !important;
    opacity: 1 !important;
  }
  html.gv-tb-on.gv-tb-fixviz .gv-tb-link * {
    visibility: visible !important;
    opacity: 1 !important;
  }
  html.gv-tb-on.gv-tb-fixviz .gv-tb-link svg {
    width: 20px !important; height: 20px !important;
  }

  /* ---- diagnostics + debug ---- */
  html.gv-tb-debug .gv-tb-nav { outline: 3px solid #e91e63 !important; }
  html.gv-tb-debug .gv-tb-item { outline: 2px solid #ff9800 !important; }
  html.gv-tb-debug .gv-tb-submenu { outline: 2px solid #4caf50 !important; }
  html.gv-tb-debug .gv-tb-content { outline: 3px solid #2196f3 !important; }
  #gv-tb-diag {
    position: fixed; top: 64px; right: 12px; z-index: 2147483000;
    width: 360px; max-width: 92vw; max-height: 80vh; overflow: auto;
    background: #101826; color: #e8eef7; border: 1px solid #3b5878; border-radius: 10px;
    font: 12px/1.55 ui-monospace, Menlo, Consolas, monospace; padding: 12px 14px;
    box-shadow: 0 14px 40px rgba(0,0,0,.5); white-space: pre-wrap; word-break: break-word;
  }
  #gv-tb-diag b { color: #8fc1ff; }
  #gv-tb-diag .gv-tb-diag-x { float: right; cursor: pointer; color: #ffb3b3; font-weight: 700; }
  `;

  /* ========================= STATE / TOGGLE ========================= */
  function isEnabled() {
    try { return localStorage.getItem(LS_KEY) !== 'off'; } catch (e) { return true; }
  }
  function setEnabled(on) {
    try { localStorage.setItem(LS_KEY, on ? 'on' : 'off'); } catch (e) {}
    applyEnabled(on);
  }
  let tagged = null; // {nav, items:[], shell, content, navWrap, wasCollapsed, weExpanded}
  function applyEnabled(on) {
    const html = document.documentElement;
    html.classList.toggle('gv-tb-on', on);
    html.classList.toggle('gv-tb-fixedmode', on && diag.mode === 'fixed');
    if (!on && tagged && tagged.weExpanded) {
      // restore the collapsed rail we expanded at load
      const btn = tagged.nav && tagged.nav.querySelector('.gv-tb-collapse');
      if (btn && /^Collapse Menu$/i.test(normalizeLabel(labelOf(btn)))) btn.click();
      tagged.weExpanded = false;
    }
    if (on) ensureTagged();
  }

  /* ============================ DISCOVERY ============================ */
  function collectSamples() {
    // self-diagnosis for the Alt+R panel: if discovery ever fails on a
    // future ST build, one screenshot shows exactly what the page offers
    const out = [];
    const anchors = document.querySelectorAll('a[href]');
    out.push('anchors on page: ' + anchors.length + ', clickables: ' + document.querySelectorAll(CLICKABLE).length);
    let shadow = 0;
    document.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) shadow++; });
    out.push('shadow-DOM hosts: ' + shadow);
    const left = Array.from(anchors).filter((a) => { const r = a.getBoundingClientRect(); return r.left < 420 && r.width > 0; }).slice(0, 8);
    left.forEach((a) => {
      out.push('a: aria="' + (a.getAttribute('aria-label') || '') + '" text="' + txt(a).slice(0, 40) + '" href="' + (a.getAttribute('href') || '').slice(0, 40) + '"');
    });
    diag.samples = out;
  }

  function findNavRoot() {
    const clickables = Array.from(document.querySelectorAll(CLICKABLE));
    const moduleAnchors = clickables.filter((a) => moduleNameOf(a));
    if (moduleAnchors.length < 4) { collectSamples(); return null; }
    let best = null;
    const seen = new Set();
    for (const a of moduleAnchors.slice(0, 8)) {
      let el = a;
      for (let i = 0; i < 11 && el && el !== document.body; i++) {
        el = el.parentElement;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const mods = new Set();
        el.querySelectorAll(CLICKABLE).forEach((x) => { const n = moduleNameOf(x); if (n) mods.add(n); });
        if (mods.size < 5) continue;
        const hasCollapse = Array.from(el.querySelectorAll('button'))
          .some((b) => /^(Collapse|Expand) Menu$/i.test(normalizeLabel(labelOf(b))));
        const r = el.getBoundingClientRect();
        let score = mods.size * 2 + (hasCollapse ? 5 : 0);
        if (r.left <= 48 && r.width > 0) score += 2;
        if (r.width >= 40 && r.width <= 340) score += 3;
        if (r.height >= window.innerHeight * 0.5) score += 2;
        if (r.width > window.innerWidth * 0.55) score -= 8;
        if (score >= 15 && (!best || score > best.score || (score === best.score && r.width < best.r.width))) {
          best = { el, score, r };
          diag.strategy = 'anchor-climb(score=' + score + ', modules=' + mods.size + (hasCollapse ? ', collapse-btn' : '') + ')';
        }
      }
    }
    if (!best) collectSamples();
    return best ? best.el : null;
  }

  function findHeader() {
    const search = document.querySelector('input[placeholder*="Search" i], input[aria-label*="Search" i]');
    let el = search || document.querySelector('a[href="/#/"], a[href="#/"]');
    if (!el) return null;
    for (let i = 0; i < 8 && el && el !== document.body; i++) {
      const r = el.getBoundingClientRect();
      if (r.width >= window.innerWidth * 0.9 && r.height >= 34 && r.height <= 90 && r.top <= 4) return el;
      el = el.parentElement;
    }
    return null;
  }

  function itemContainerOf(a, nav, myName) {
    let el = a;
    while (el.parentElement && el.parentElement !== nav) {
      const parent = el.parentElement;
      // Stop climbing only if the parent holds a DIFFERENT module's
      // anchor. Same-name anchors are fine: some submenus repeat the
      // module's own landing link (Calls submenu contains a "Calls"
      // link) and that link belongs to THIS item, not a sibling.
      const foreign = Array.from(parent.querySelectorAll(CLICKABLE))
        .some((x) => { const n = moduleNameOf(x); return n && n !== myName && !el.contains(x); });
      if (foreign) break;
      el = parent;
    }
    return el;
  }

  function tagSubmenu(item, moduleAnchor) {
    if (!item) return null;
    let sub = item.querySelector(':scope .gv-tb-submenu');
    if (sub) return sub;
    // outermost descendant container that holds links other than the module link
    const candidates = Array.from(item.querySelectorAll('*')).filter((e) => {
      if (e === moduleAnchor || e.contains(moduleAnchor)) return false;
      const links = Array.from(e.querySelectorAll('a[href], [role="link"]')).filter((x) => x !== moduleAnchor);
      return links.length >= 1;
    });
    if (!candidates.length) return null;
    candidates.sort((x, y) => depth(x) - depth(y));
    sub = candidates[0];
    sub.classList.add('gv-tb-submenu');
    sub.querySelectorAll('a[href], [role="link"]').forEach((x) => x.classList.add('gv-tb-sub-link'));
    return sub;
  }
  function depth(el) { let d = 0; while (el.parentElement) { d++; el = el.parentElement; } return d; }

  function tagNav(nav) {
    nav.classList.add('gv-tb-nav');
    // colors sampled from ST's own nav so dropdowns match
    try {
      const cs = getComputedStyle(nav);
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') {
        document.documentElement.style.setProperty('--gv-tb-navbg', cs.backgroundColor);
      }
      const link = nav.querySelector('a[href]');
      if (link) {
        const lc = getComputedStyle(link).color;
        if (lc) document.documentElement.style.setProperty('--gv-tb-fg', lc);
      }
    } catch (e) {}

    const items = [];
    const seenNames = new Set();
    nav.querySelectorAll(CLICKABLE).forEach((a) => {
      const name = moduleNameOf(a);
      if (!name || seenNames.has(name)) return;
      // only top-level module entries: skip anything already inside a submenu
      seenNames.add(name);
      const item = itemContainerOf(a, nav, name);
      item.classList.add('gv-tb-item');
      a.classList.add('gv-tb-link');
      a.dataset.gvModule = name;
      let chevron = null;
      item.querySelectorAll('button').forEach((b) => {
        const label = normalizeLabel(labelOf(b));
        if (/^(Expand|Collapse)\s+.+\s+submenu$/i.test(label)) chevron = b;
      });
      if (!chevron) {
        const btns = Array.from(item.querySelectorAll('button')).filter((b) => !b.closest('.gv-tb-submenu'));
        if (btns.length === 1) chevron = btns[0];
      }
      if (chevron) chevron.classList.add('gv-tb-chevron');
      const sub = tagSubmenu(item, a);
      items.push({ name, item, link: a, chevron, sub });
    });

    // the list = shared parent of the items
    const listParents = new Set(items.map((i) => i.item.parentElement).filter(Boolean));
    listParents.forEach((p) => p.classList.add('gv-tb-list'));

    // collapse/expand control (may be icon-only: name lives in aria-label)
    let collapseBtn = null;
    nav.querySelectorAll('button').forEach((b) => {
      if (/^(Collapse|Expand) Menu$/i.test(normalizeLabel(labelOf(b)))) collapseBtn = b;
    });
    if (collapseBtn) {
      collapseBtn.classList.add('gv-tb-collapse');
      // v1.2 fix (live bug: bar rendered but EMPTY): the old climb could
      // tag a container that holds BOTH the footer and the whole module
      // list, and the CSS then hid that container - every item gone.
      // Now the climb stops before any ancestor that contains an item:
      // only ever hide the largest ITEM-FREE wrapper around the button.
      let row = collapseBtn;
      for (let i = 0; i < 4; i++) {
        const p = row.parentElement;
        if (!p || p === nav) break;
        if (p.querySelector('.gv-tb-item')) break;
        row = p;
      }
      row.classList.add('gv-tb-collapse-row');
    }

    // shell + content discovery
    let shell = null, content = null, navWrap = null, mode = 'fixed';
    let el = nav;
    for (let i = 0; i < 8 && el && el.parentElement; i++) {
      const p = el.parentElement;
      const others = Array.from(p.children).filter((k) => k !== el);
      const cand = others.find((k) => {
        const r = k.getBoundingClientRect();
        return r.width > window.innerWidth * 0.4 && r.height > window.innerHeight * 0.4;
      });
      if (cand) {
        shell = p; content = cand; navWrap = el;
        const disp = getComputedStyle(shell).display;
        mode = disp === 'flex' ? 'flow' : (disp === 'grid' ? 'grid' : 'fixed');
        break;
      }
      el = p;
    }
    if (shell) {
      if (mode === 'flow') shell.classList.add('gv-tb-shell-flex');
      if (mode === 'grid') shell.classList.add('gv-tb-shell-grid');
      if (navWrap) navWrap.classList.add('gv-tb-navwrap');
      if (content) content.classList.add('gv-tb-content');
      if (mode === 'fixed') diag.warnings.push('shell found but display=' + getComputedStyle(shell).display + ' - using fixed bar fallback');
    } else {
      diag.warnings.push('content container not found - fixed bar fallback, page top may need the offset checked');
    }
    diag.mode = shell ? mode : 'fixed';
    document.documentElement.classList.toggle('gv-tb-fixedmode', diag.mode === 'fixed');

    const header = findHeader();
    if (header) {
      diag.headerPx = Math.round(header.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--gv-tb-top', diag.headerPx + 'px');
    }

    diag.items = items.length;
    diag.submenus = items.filter((i) => i.sub).length;
    return { nav, items, shell, content, navWrap, wasCollapsed: false, weExpanded: false };
  }

  /* ====================== SUBMENU OPEN / CLOSE ====================== */
  function chevronSaysOpen(chevron) {
    return chevron && /^Collapse/i.test(normalizeLabel(labelOf(chevron)));
  }
  function positionSubmenu(rec) {
    if (!rec.sub) return;
    const ir = rec.item.getBoundingClientRect();
    rec.sub.style.top = Math.round(ir.bottom) + 'px';
    rec.sub.style.left = Math.round(ir.left) + 'px';
    // clamp inside the viewport once it has a real width
    requestAnimationFrame(() => {
      if (!rec.sub || !document.contains(rec.sub)) return;
      const w = rec.sub.offsetWidth;
      const maxLeft = Math.max(4, window.innerWidth - w - 8);
      const cur = parseFloat(rec.sub.style.left) || 0;
      if (cur > maxLeft) rec.sub.style.left = maxLeft + 'px';
      if (cur < 4) rec.sub.style.left = '4px';
    });
  }
  function openItem(rec) {
    refreshItem(rec);
    if (rec.sub) { rec.item.classList.add('gv-tb-open'); positionSubmenu(rec); return; }
    if (rec.chevron && !chevronSaysOpen(rec.chevron)) {
      rec.chevron.click();
      rec.item.dataset.gvWeOpened = '1';
      setTimeout(() => { refreshItem(rec); rec.item.classList.add('gv-tb-open'); positionSubmenu(rec); }, 30);
    }
  }
  function closeItem(rec) {
    rec.item.classList.remove('gv-tb-open');
    if (rec.item.dataset.gvWeOpened === '1' && rec.chevron && chevronSaysOpen(rec.chevron)) {
      rec.chevron.click();
    }
    delete rec.item.dataset.gvWeOpened;
  }
  function refreshItem(rec) {
    // a submenu node ServiceTitan unmounted on close leaves rec.sub
    // pointing at a detached element - drop it and re-tag what exists now
    if (rec.sub && !document.contains(rec.sub)) rec.sub = null;
    if (!rec.sub) rec.sub = tagSubmenu(rec.item, rec.link);
  }
  function recOf(el) {
    if (!tagged) return null;
    const item = el && el.closest ? el.closest('.gv-tb-item') : null;
    return item ? tagged.items.find((i) => i.item === item) : null;
  }

  /* ====================== VISIBILITY AUDIT ====================== */
  function lumOf(rgb) {
    const m = (rgb || '').match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    const f = (v) => { v = parseFloat(v) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
  }
  function contrast(a, b) {
    const x = lumOf(a), y = lumOf(b);
    if (x === null || y === null) return 99;
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  let auditDone = false;
  function auditVisibility() {
    if (!tagged || !tagged.items.length) return;
    const navR = tagged.nav.getBoundingClientRect();
    let vis = 0;
    tagged.items.forEach((rec) => {
      const r = rec.link.getBoundingClientRect();
      const cs = getComputedStyle(rec.link);
      const inside = r.width > 8 && r.height > 4 && r.top >= navR.top - 4 && r.top <= navR.bottom + 40;
      if (inside && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05) vis++;
    });
    diag.visibleItems = vis;
    let lowContrast = false;
    try {
      lowContrast = contrast(getComputedStyle(tagged.items[0].link).color, getComputedStyle(tagged.nav).backgroundColor) < 1.8;
    } catch (e) {}
    if ((vis < tagged.items.length || lowContrast) && !document.documentElement.classList.contains('gv-tb-fixviz')) {
      document.documentElement.classList.add('gv-tb-fixviz');
      diag.warnings.push('visibility audit: ' + vis + '/' + tagged.items.length + ' links visible' + (lowContrast ? ', low contrast' : '') + ' - insurance styles applied, re-checking');
      setTimeout(auditVisibility, 400);
    }
  }

  /* ============================ WIRING ============================ */
  let navObserver = null;
  let ensureQueued = false;
  function ensureTagged() {
    if (ensureQueued) return;
    ensureQueued = true;
    requestAnimationFrame(() => {
      ensureQueued = false;
      try { ensureTaggedNow(); } catch (e) { log('ensure error', e); }
    });
  }
  function ensureTaggedNow() {
    if (!document.body) return;
    if (tagged && document.contains(tagged.nav) && tagged.nav.classList.contains('gv-tb-nav')) {
      // cheap upkeep: submenus that appeared since tagging
      tagged.items.forEach((rec) => { if (!rec.sub) refreshItem(rec); });
      diag.submenus = tagged.items.filter((i) => i.sub).length;
      return;
    }
    const nav = findNavRoot();
    if (!nav) return;
    diag.runs++;
    tagged = tagNav(nav);
    log('tagged nav via', diag.strategy, '| mode:', diag.mode, '| items:', diag.items, '| submenus:', diag.submenus);
    // collapsed rail? expand once so the bar has real labels
    const navW = nav.getBoundingClientRect().width;
    if (CONFIG.expandWhenCollapsed && navW > 0 && navW <= 90) {
      const btn = nav.querySelector('.gv-tb-collapse');
      if (btn && /^Expand Menu$/i.test(normalizeLabel(labelOf(btn)))) {
        tagged.wasCollapsed = true; tagged.weExpanded = true; diag.autoExpanded = true;
        btn.click();
        setTimeout(() => { tagged = null; ensureTagged(); }, 350);
        return;
      }
    }
    wireNav(nav);
    applyEnabled(isEnabled());
    syncActive();
    if (!auditDone) { auditDone = true; setTimeout(auditVisibility, 900); }
  }
  function wireNav(nav) {
    if (nav.dataset.gvWired === '1') return;
    nav.dataset.gvWired = '1';
    nav.addEventListener('mouseover', (e) => {
      const rec = recOf(e.target);
      if (!rec) return;
      if (rec.item.contains(e.relatedTarget)) return;
      openItem(rec);
    });
    nav.addEventListener('mouseout', (e) => {
      const rec = recOf(e.target);
      if (!rec) return;
      if (rec.item.contains(e.relatedTarget)) return;
      closeItem(rec);
    });
    nav.addEventListener('focusin', (e) => { const rec = recOf(e.target); if (rec) openItem(rec); });
    nav.addEventListener('click', (e) => {
      const rec = recOf(e.target);
      if (!rec || !rec.chevron) return;
      if (e.target === rec.chevron || rec.chevron.contains(e.target)) {
        setTimeout(() => {
          refreshItem(rec);
          rec.item.classList.toggle('gv-tb-open', chevronSaysOpen(rec.chevron));
        }, 30);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && tagged) tagged.items.forEach(closeItem);
    });
    // a fixed dropdown no longer tracks its item - close on list scroll
    nav.addEventListener('scroll', () => { if (tagged) tagged.items.forEach((r) => { if (r.item.classList.contains('gv-tb-open')) closeItem(r); }); }, true);
    if (navObserver) navObserver.disconnect();
    if (nav.parentElement) {
      navObserver = new MutationObserver(() => ensureTagged());
      navObserver.observe(nav.parentElement, { childList: true });
    }
  }
  const HASH_BY_NAME = {
    Dashboard: '#/new/dashboards', Calls: '#/Calls', Schedule: '#/Calendar',
    Dispatch: '#/DispatchBoard', Accounting: '#/new/accounting',
    Pricebook: '#/new/pricebook', Tasks: '#/TaskManagement',
  };
  function syncActive() {
    if (!tagged) return;
    const h = (location.hash || '').replace(/^\/?/, '');
    let best = null;
    tagged.items.forEach((rec) => {
      const href = rec.link.getAttribute('href') || '';
      const hh = href.includes('#') ? href.slice(href.indexOf('#')) : (HASH_BY_NAME[rec.name] || '');
      if (hh && (h === hh || h.startsWith(hh + '/')) && (!best || hh.length > best.len)) {
        best = { rec, len: hh.length };
      }
    });
    tagged.items.forEach((rec) => rec.item.classList.toggle('gv-tb-active', best && best.rec === rec));
  }

  /* ========================== DIAGNOSTICS ========================== */
  function showDiag() {
    const old = document.getElementById('gv-tb-diag');
    if (old) { old.remove(); return; }
    const lines = [
      '<b>GV Top Bar diagnostics</b> <span class="gv-tb-diag-x" id="gv-tb-diag-x">✕ close</span>',
      'version: ' + diag.version + '   enabled: ' + isEnabled(),
      'strategy: ' + (diag.strategy || 'nav not found yet'),
      'mode: ' + (diag.mode || '-') + '   header: ' + (diag.headerPx || '?') + 'px',
      'module items tagged: ' + diag.items + ' / ' + MODULES.length,
      'module links visible in bar: ' + (diag.visibleItems === null ? 'not audited yet' : diag.visibleItems),
      'submenus tagged: ' + diag.submenus,
      'auto-expanded collapsed rail: ' + diag.autoExpanded,
      'tag runs: ' + diag.runs,
      'items: ' + (tagged ? tagged.items.map((i) => i.name + (i.sub ? '▸' : '')).join(', ') : '-'),
      diag.warnings.length ? 'warnings:\n- ' + diag.warnings.join('\n- ') : 'warnings: none',
      diag.samples.length ? 'page samples:\n' + diag.samples.join('\n') : '',
      'Alt+T = toggle top bar, Alt+R = this panel',
    ];
    const div = document.createElement('div');
    div.id = 'gv-tb-diag';
    div.innerHTML = lines.join('\n');
    document.body.appendChild(div);
    div.querySelector('#gv-tb-diag-x').addEventListener('click', () => div.remove());
  }

  /* ============================= BOOT ============================= */
  const style = document.createElement('style');
  style.id = 'gv-tb-style';
  style.textContent = CSS;
  let styleInjected = false;
  function injectStyle() {
    // at document-start even documentElement can briefly not exist yet
    if (styleInjected || !document.documentElement) return;
    (document.head || document.documentElement).appendChild(style);
    styleInjected = true;
    if (CONFIG.debugOutline) document.documentElement.classList.add('gv-tb-debug');
  }
  injectStyle();

  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 't' || e.key === 'T')) { e.preventDefault(); setEnabled(!document.documentElement.classList.contains('gv-tb-on')); }
    if (e.altKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); showDiag(); }
  });
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Toggle ServiceTitan Top Bar (Alt+T)', () => setEnabled(!document.documentElement.classList.contains('gv-tb-on')));
      GM_registerMenuCommand('Top Bar diagnostics (Alt+R)', showDiag);
    }
  } catch (e) {}

  window.addEventListener('hashchange', () => { syncActive(); ensureTagged(); });
  window.addEventListener('resize', () => {
    const header = findHeader();
    if (header) document.documentElement.style.setProperty('--gv-tb-top', Math.round(header.getBoundingClientRect().height) + 'px');
  });

  // wait for the SPA shell, then stop watching the whole document
  const bootObserver = new MutationObserver(() => ensureTagged());
  function boot() {
    injectStyle();
    ensureTagged();
    if (tagged) { bootObserver.disconnect(); return; }
    bootObserver.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { bootObserver.disconnect(); }, 20000);
    // existence check for later re-renders (cheap: two class lookups)
    setInterval(() => {
      if (!tagged || !document.contains(tagged.nav) || !tagged.nav.classList.contains('gv-tb-nav')) {
        tagged = null; ensureTagged();
      }
    }, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
