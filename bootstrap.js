/* global Zotero, Services, Components */
"use strict";

// Pure geometry keeps the document scrollable to its last page while mounting
// only the rows near the viewport, including for very long PDFs.
var ContactSheetLayout = {
  size(value) { return Math.max(100, Math.min(400, Number(value) || 200)); },
  calculate({ count, size, width, height, scrollTop }) {
    size = this.size(size);
    let cellWidth = size + 32;
    let rowHeight = Math.ceil(size * Math.SQRT2) + 58;
    let columns = Math.max(1, Math.floor(Math.max(0, width - 24) / cellWidth));
    let rows = Math.ceil(count / columns);
    let firstRow = Math.max(0, Math.floor(Math.max(0, scrollTop - 16) / rowHeight) - 1);
    let lastRow = Math.min(rows, Math.ceil((scrollTop + height) / rowHeight) + 1);
    return {
      columns, cellWidth, rowHeight,
      totalHeight: rows * rowHeight + 32,
      start: Math.min(count, firstRow * columns),
      end: Math.min(count, Math.max(firstRow, lastRow) * columns),
      left: Math.max(12, (width - columns * cellWidth) / 2)
    };
  }
};

var PageThumbnails = {
  id: "pdf-page-thumbnails@zotero-visual-plugins.local",
  preference: "extensions.zotero.pdfPageThumbnails.autoOpen",
  sizePreference: "extensions.zotero.pdfPageThumbnails.size",
  buttonID: "zvp-page-thumbnails-toggle",
  menuID: "zvp-page-thumbnails-auto-open",
  active: false,
  readers: new Map(),
  windows: new Map(),

  async start() {
    if (this.active) return;
    this.active = true;
    await Zotero.initializationPromise;
    if (!this.active) return;
    this.toolbarHandler = event => {
      if (!this.active || event.reader.type !== "pdf") return;
      try {
        let record = this.ensureReader(event.reader, event.doc);
        // Zotero requires synchronous insertion during renderToolbar.
        event.append(record.button);
        this.initializeReader(record);
      }
      catch (error) { Zotero.logError(error); }
    };
    Zotero.Reader.registerEventListener("renderToolbar", this.toolbarHandler, this.id);
    for (let window of Zotero.getMainWindows()) this.addWindow(window);
    for (let reader of Zotero.Reader._readers) {
      if (reader.type === "pdf") this.addExistingReader(reader).catch(error => Zotero.logError(error));
    }
  },

  async addExistingReader(reader) {
    await reader._initPromise;
    if (!this.active) return;
    let doc = reader._iframeWindow.document;
    if (!doc?.defaultView || doc.defaultView.closed) return;
    let container = doc.querySelector(".toolbar .end .custom-sections");
    if (!container) return;
    let record = this.ensureReader(reader, doc);
    if (!record.button.isConnected) {
      let section = doc.createElement("div");
      section.className = "section";
      section.append(record.button);
      container.append(section);
    }
    this.initializeReader(record);
  },

  autoOpen() { return Services.prefs.getBoolPref(this.preference, true); },

  ensureReader(reader, doc) {
    let existing = this.readers.get(reader);
    if (existing && existing.hostDoc === doc) return existing;
    if (existing) this.removeReader(existing);
    let el = (tag, className, text) => {
      let node = doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    let button = el("button", "toolbar-button");
    button.id = this.buttonID;
    button.type = "button";
    button.setAttribute("aria-controls", "zvp-contact-sheet");
    let svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("aria-hidden", "true");
    for (let [x, y] of [[3, 2], [11, 2], [3, 11], [11, 11]]) {
      let rect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
      for (let [name, value] of Object.entries({ x, y, width: 6, height: 7, rx: 0.7, fill: "none", stroke: "currentColor", "stroke-width": 1.25 })) rect.setAttribute(name, value);
      svg.append(rect);
    }
    button.append(svg);

    let overlay = el("section", "zvp-contact-sheet");
    overlay.id = "zvp-contact-sheet";
    overlay.hidden = true;
    overlay.setAttribute("role", "region");
    overlay.setAttribute("aria-label", "PDF Contact Sheet");
    let header = el("div", "zvp-contact-header");
    let status = el("span", "zvp-contact-status", "Loading pages…");
    status.setAttribute("role", "status");
    status.setAttribute("title", "Select a page to read");
    let zoom = el("label", "zvp-contact-zoom", "Size");
    let slider = el("input");
    slider.id = "zvp-contact-size";
    slider.type = "range";
    slider.min = "100";
    slider.max = "400";
    slider.step = "any";
    slider.setAttribute("aria-label", "Thumbnail size");
    let sizeLabel = el("output");
    let close = el("button", "zvp-contact-close");
    close.type = "button";
    close.setAttribute("aria-label", "Close contact sheet");
    close.setAttribute("title", "Close contact sheet (Escape)");
    let closeIcon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    closeIcon.setAttribute("viewBox", "0 0 16 16");
    closeIcon.setAttribute("aria-hidden", "true");
    closeIcon.setAttribute("focusable", "false");
    let closePath = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    for (let [name, value] of Object.entries({ d: "M4 4l8 8m0-8-8 8", fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round" })) closePath.setAttribute(name, value);
    closeIcon.append(closePath);
    close.append(closeIcon);
    zoom.append(slider, sizeLabel);
    header.append(status, zoom, close);
    let scroll = el("div", "zvp-contact-scroll");
    scroll.id = "zvp-contact-scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute("aria-label", "All PDF pages");
    let grid = el("div", "zvp-contact-grid");
    grid.id = "zvp-contact-grid";
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", "PDF pages");
    scroll.append(grid);
    overlay.append(header, scroll);
    let style = el("style");
    style.id = "zvp-contact-style";
    style.textContent = `
      html,body{margin:0;height:100%;color-scheme:light dark}
      #zvp-contact-sheet{position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;background:var(--material-background,#f0f0f2);color:var(--fill-primary,#252528);font:13px -apple-system,BlinkMacSystemFont,sans-serif}
      #zvp-contact-sheet[hidden]{display:none!important}
      .zvp-contact-header{display:flex;align-items:center;gap:10px;flex:0 0 32px;height:32px;min-height:32px;padding:0 12px;border-bottom:1px solid var(--color-panedivider,#0002);background:var(--material-toolbar,#fafafa);box-sizing:border-box}
      .zvp-contact-status{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:500;line-height:18px;color:var(--fill-secondary,#666)}
      .zvp-contact-zoom{display:flex;align-items:center;flex:none;gap:6px;font-size:11px;line-height:18px;white-space:nowrap}
      .zvp-contact-zoom input{width:90px;height:18px;margin:0;accent-color:#3277cd}
      .zvp-contact-zoom output{min-width:38px;text-align:right;font-variant-numeric:tabular-nums}
      .zvp-contact-close{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;box-sizing:border-box;border-radius:5px;border:1px solid var(--fill-quinary,#0003);background:var(--material-button,#fff);color:inherit;cursor:pointer}
      .zvp-contact-close svg{display:block;width:16px;height:16px;pointer-events:none}
      .zvp-contact-close:hover{background:var(--material-hover,#f0f2f5)}
      .zvp-contact-close:focus-visible,.zvp-contact-zoom input:focus-visible{outline:2px solid #3277cd;outline-offset:1px}
      .zvp-contact-scroll{overflow:auto;min-height:0;flex:1;overscroll-behavior:contain;position:relative;outline:none}
      .zvp-contact-grid{position:relative;width:100%;min-height:100%}
      .zvp-contact-page{position:absolute;margin:0;padding:12px 12px 6px;display:flex;flex-direction:column;align-items:center;gap:9px;box-sizing:border-box;border:2px solid transparent;border-radius:8px;color:inherit;background:transparent;cursor:pointer;font:inherit}
      .zvp-contact-page:hover{background:#8882}
      .zvp-contact-page:focus-visible,.zvp-contact-page[aria-current=true]{outline:none;border-color:#3277cd;background:#3277cd13}
      .zvp-contact-image{width:100%;display:flex;align-items:center;justify-content:center;position:relative;pointer-events:none}
      .zvp-contact-image img{display:block;max-width:100%;max-height:100%;object-fit:contain;box-shadow:0 2px 9px #0003;background:white}
      .zvp-contact-placeholder{display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:#fff9;color:#555;border:1px solid #8883;font-size:12px}
      .zvp-contact-page-label{font-variant-numeric:tabular-nums;line-height:18px}
      @media(max-width:420px){.zvp-contact-header{gap:8px;padding:0 8px}.zvp-contact-zoom{font-size:0;gap:4px}.zvp-contact-zoom input{width:70px}.zvp-contact-zoom output{font-size:11px}}
      @media(prefers-color-scheme:dark){#zvp-contact-sheet{background:var(--material-background,#242426);color:var(--fill-primary,#ececef)}.zvp-contact-header{background:var(--material-toolbar,#2c2c2e);border-bottom-color:#ffffff1a}.zvp-contact-status{color:var(--fill-secondary,#b7b7bd)}.zvp-contact-close{background:var(--material-button,#3a3a3c);border-color:#ffffff24}.zvp-contact-close:hover{background:var(--material-hover,#464649)}}
    `;
    // A separate browsing context isolates contact-sheet keystrokes from the
    // native reader's window-capture annotation delete and PDF zoom shortcuts.
    let frame = doc.createElement("iframe");
    frame.id = "zvp-contact-frame";
    frame.setAttribute("title", "PDF Contact Sheet");
    frame.style.cssText = "position:fixed;left:0;top:41px;width:100%;height:calc(100% - 41px);border:0;z-index:100";
    frame.hidden = true;
    let record = {
      reader, doc: null, hostDoc: doc, frame, button, overlay, grid, scroll, status, slider, sizeLabel, style,
      size: ContactSheetLayout.size(Services.prefs.getIntPref(this.sizePreference, 200)),
      initialized: false, disposed: false, visible: false, ready: false, count: 0,
      selected: 0, cells: new Map(), cache: new Map(), failed: new Set(), queue: [], tasks: new Set(),
      generation: 0, listeners: [], frameRequest: null, zoomTimer: null, zooming: false, zoomAnchor: null
    };
    let listen = (node, type, handler) => { node.addEventListener(type, handler); record.listeners.push([node, type, handler]); };
    listen(button, "click", () => this.setVisible(record, !record.visible));
    listen(close, "click", () => this.setVisible(record, false));
    listen(scroll, "scroll", () => this.scheduleLayout(record));
    listen(slider, "input", () => this.resize(record, slider.value));
    listen(overlay, "keydown", event => this.handleKey(record, event));
    listen(doc.defaultView, "unload", () => this.removeReader(record));
    record.frameReady = new Promise(resolve => {
      listen(frame, "load", () => {
        if (record.disposed) { resolve(); return; }
        // Inserting a new iframe starts its initial about:blank navigation.
        // Populate after load, rather than writing into a soon-replaced document.
        record.doc = frame.contentDocument;
        record.doc.head.append(style);
        record.doc.body.append(overlay);
        record.resizeObserver?.disconnect();
        record.resizeObserver = new record.doc.defaultView.ResizeObserver(() => this.scheduleLayout(record));
        record.resizeObserver.observe(scroll);
        resolve();
      });
    });
    frame.src = "about:blank";
    doc.body.append(frame);
    this.readers.set(reader, record);
    slider.value = String(record.size);
    sizeLabel.textContent = record.size + " px";
    this.updateButton(record);
    return record;
  },

  initializeReader(record) {
    if (record.initialized) return;
    record.initialized = true;
    Promise.all([record.reader._initPromise, record.frameReady]).then(async () => {
      if (!this.active || record.disposed) return;
      if (this.autoOpen()) this.setVisible(record, true);
      let view = record.reader._internalReader._primaryView;
      await view.initializedPromise;
      if (!this.active || record.disposed) return;
      record.pdfView = view;
      record.pdfWindow = view._iframeWindow;
      record.pdf = record.pdfWindow.PDFViewerApplication.pdfDocument;
      record.count = record.pdf.numPages;
      record.ready = true;
      record.overlay.setAttribute("data-page-count", String(record.count));
      record.status.textContent = `${record.count} ${record.count === 1 ? "page" : "pages"}`;
      this.layout(record);
    }).catch(error => {
      if (!record.disposed) {
        record.status.textContent = "Could not load pages";
        record.status.setAttribute("title", "Return to PDF and reopen Contact Sheet.");
      }
      Zotero.logError(error);
    });
  },

  setVisible(record, visible) {
    if (record.disposed) return;
    record.visible = visible;
    record.frame.hidden = !visible;
    record.overlay.hidden = !visible;
    this.updateButton(record);
    if (visible) {
      // No sidebar methods are called: closing the overlay reveals exactly the
      // annotation/sidebar layout that was already open underneath it.
      record.selected = record.reader._internalReader?._state.primaryViewStats?.pageIndex || 0;
      if (record.ready) {
        let currentPDF = record.pdfWindow.PDFViewerApplication.pdfDocument;
        if (currentPDF !== record.pdf) {
          this.cancelRendering(record);
          record.pdf = currentPDF;
          record.count = currentPDF.numPages;
          record.cache.clear();
          record.failed.clear();
          for (let cell of record.cells.values()) { cell.node.remove(); }
          record.cells.clear();
          record.overlay.setAttribute("data-page-count", String(record.count));
          record.status.textContent = `${record.count} ${record.count === 1 ? "page" : "pages"}`;
        }
      }
      this.layout(record);
      record.scroll.focus();
    }
    else {
      this.cancelRendering(record);
      record.reader.focus();
    }
  },

  updateButton(record) {
    let label = record.visible ? "Return to PDF" : "Show PDF Contact Sheet";
    record.button.setAttribute("aria-label", label);
    record.button.setAttribute("title", label);
    record.button.setAttribute("aria-pressed", String(record.visible));
    record.button.classList.toggle("active", record.visible);
  },

  scheduleLayout(record) {
    if (record.frameRequest || record.disposed || !record.visible || !record.doc) return;
    record.frameRequest = record.doc.defaultView.requestAnimationFrame(() => {
      record.frameRequest = null;
      this.layout(record);
    });
  },

  resize(record, value) {
    let size = ContactSheetLayout.size(value);
    let old = record.layout;
    let anchor = old ? Math.floor(record.scroll.scrollTop / old.rowHeight) * old.columns : 0;
    record.size = size;
    record.sizeLabel.textContent = Math.round(size) + " px";
    record.slider.value = String(size);
    // The live slider and layout stay fractional. Only the persisted integer
    // preference and the concise visible label round to a whole pixel.
    Services.prefs.setIntPref(this.sizePreference, Math.round(size));
    this.cancelRendering(record);
    record.zoomAnchor = anchor;
    record.zooming = true;
    // Geometry follows every animation frame, while sharper raster generation
    // waits until the slider pauses. Existing images remain visible throughout.
    record.zoomTimer = setTimeout(() => {
      record.zoomTimer = null;
      record.zooming = false;
      this.scheduleLayout(record);
    }, 120);
    this.scheduleLayout(record);
  },

  layout(record) {
    if (!record.visible || !record.ready || record.disposed) return;
    let geometry = ContactSheetLayout.calculate({ count: record.count, size: record.size, width: record.scroll.clientWidth, height: record.scroll.clientHeight, scrollTop: record.scroll.scrollTop });
    if (record.zoomAnchor !== null && record.zoomAnchor !== undefined) {
      record.scroll.scrollTop = Math.floor(record.zoomAnchor / geometry.columns) * geometry.rowHeight;
      record.zoomAnchor = null;
      geometry = ContactSheetLayout.calculate({ count: record.count, size: record.size, width: record.scroll.clientWidth, height: record.scroll.clientHeight, scrollTop: record.scroll.scrollTop });
    }
    record.layout = geometry;
    record.grid.style.height = geometry.totalHeight + "px";
    record.grid.setAttribute("data-total-pages", String(record.count));
    record.grid.setAttribute("data-columns", String(geometry.columns));
    let dpr = Math.max(1, Math.min(2, record.doc.defaultView.devicePixelRatio || 1));
    let pixels = Math.ceil(record.size * dpr);
    let wanted = new Set();
    record.queue = [];
    for (let i = geometry.start; i < geometry.end; i++) {
      let key = `${i}:${pixels}`;
      wanted.add(key);
      let cell = record.cells.get(i);
      if (!cell) {
        let node = record.doc.createElement("button");
        node.type = "button";
        node.className = "zvp-contact-page";
        node.setAttribute("data-page-index", String(i));
        let image = record.doc.createElement("div");
        image.className = "zvp-contact-image";
        let label = record.doc.createElement("span");
        label.className = "zvp-contact-page-label";
        let pageLabel = record.reader._internalReader._state.pageLabels?.[i] || String(i + 1);
        label.textContent = pageLabel;
        node.setAttribute("aria-label", `Read page ${pageLabel}`);
        node.append(image, label);
        node.addEventListener("click", () => this.openPage(record, i));
        record.grid.append(node);
        cell = { node, image, key: null, displayedKey: null, pendingImageKey: null };
        record.cells.set(i, cell);
      }
      let x = geometry.left + (i % geometry.columns) * geometry.cellWidth;
      let y = 16 + Math.floor(i / geometry.columns) * geometry.rowHeight;
      let layoutStyle = `left:${x}px;top:${y}px;width:${geometry.cellWidth - 8}px;height:${geometry.rowHeight - 10}px`;
      if (cell.layoutStyle !== layoutStyle) {
        cell.node.style.cssText = layoutStyle;
        cell.image.style.height = Math.ceil(record.size * Math.SQRT2) + "px";
        cell.layoutStyle = layoutStyle;
      }
      cell.node.setAttribute("aria-current", String(i === record.selected));
      cell.node.tabIndex = i === record.selected ? 0 : -1;
      if (cell.key !== key) {
        cell.key = key;
        cell.pendingImageKey = null;
        // Never clear an already rendered page on zoom. Its previous raster is
        // scaled by CSS until a newly decoded replacement is ready.
        if (!cell.image.firstElementChild) {
          let placeholder = record.doc.createElement("span");
          placeholder.className = "zvp-contact-placeholder";
          placeholder.textContent = "Loading…";
          cell.image.append(placeholder);
        }
      }
      if (record.cache.has(key)) this.putImage(record, cell, key, record.cache.get(key));
      else {
        let fallback = this.cachedPreview(record, i, pixels);
        if (fallback && !cell.displayedKey) this.putImage(record, cell, key, fallback.image, fallback.key);
        if (record.failed.has(key)) {
          if (!cell.displayedKey) cell.image.textContent = "Preview unavailable";
        }
        else if (![...record.tasks].some(task => !task.cancelled && task.generation === record.generation && task.key === key)) record.queue.push({ index: i, pixels, key });
      }
    }
    for (let [index, cell] of record.cells) {
      if (index < geometry.start || index >= geometry.end) { cell.node.remove(); record.cells.delete(index); }
    }
    for (let task of record.tasks) {
      if (!wanted.has(task.key)) { task.cancelled = true; task.renderTask?.cancel(); }
    }
    this.pump(record);
  },

  cachedPreview(record, index, pixels) {
    let candidate = null;
    for (let [key, image] of record.cache) {
      let [page, width] = key.split(":").map(Number);
      if (page !== index) continue;
      // Prefer a preview at least as sharp as requested, then the nearest size.
      let distance = width >= pixels ? width - pixels : pixels - width + 10000;
      if (!candidate || distance < candidate.distance) candidate = { key, image, distance };
    }
    return candidate;
  },

  putImage(record, cell, key, image, imageKey = key) {
    if (cell.key !== key || cell.displayedKey === imageKey || cell.pendingImageKey === imageKey) return;
    cell.pendingImageKey = imageKey;
    let img = record.doc.createElement("img");
    img.alt = "";
    img.draggable = false;
    img.src = image;
    img.decode().then(() => {
      if (record.disposed || cell.key !== key || cell.pendingImageKey !== imageKey) return;
      cell.image.replaceChildren(img);
      cell.displayedKey = imageKey;
      cell.pendingImageKey = null;
      if (record.cache.has(imageKey)) { record.cache.delete(imageKey); record.cache.set(imageKey, image); }
    }).catch(() => {
      if (cell.pendingImageKey === imageKey) cell.pendingImageKey = null;
      if (!cell.displayedKey && cell.key === key) cell.image.textContent = "Preview unavailable";
    });
  },

  pump(record) {
    if (record.disposed || !record.visible || record.zooming) return;
    while (record.tasks.size < 2 && record.queue.length) {
      let job = record.queue.shift();
      let task = { ...job, generation: record.generation, cancelled: false };
      record.tasks.add(task);
      this.renderPage(record, task).then(image => {
        if (!image || record.disposed || task.cancelled || task.generation !== record.generation) return;
        record.cache.set(task.key, image);
        // Data URLs are strings; keep at most ~24 MiB of UTF-16 payload per
        // reader in addition to the entry limit (important for scanned PDFs).
        let bytes = [...record.cache.values()].reduce((sum, value) => sum + value.length * 2, 0);
        while (record.cache.size > 48 || bytes > 24 * 1024 * 1024) {
          let oldest = record.cache.keys().next().value;
          bytes -= record.cache.get(oldest).length * 2;
          record.cache.delete(oldest);
        }
        let cell = record.cells.get(task.index);
        if (cell) this.putImage(record, cell, task.key, image);
      }).catch(error => {
        if (!task.cancelled && !record.disposed) {
          record.failed.add(task.key);
          let cell = record.cells.get(task.index);
          if (cell?.key === task.key && !cell.displayedKey) cell.image.textContent = "Preview unavailable";
          Zotero.logError(error);
        }
      }).finally(() => { record.tasks.delete(task); this.pump(record); });
    }
  },

  async renderPage(record, task) {
    // getPage crosses an asynchronous content boundary; waive its result so
    // Gecko exposes PDFPageProxy prototype methods such as getViewport/render.
    let page = Components.utils.waiveXrays(await record.pdf.getPage(task.index + 1));
    if (task.cancelled || record.disposed) return null;
    let win = record.pdfWindow;
    let clone = value => Components.utils.cloneInto(value, win, { wrapReflectors: true });
    let base = page.getViewport(clone({ scale: 1 }));
    let scale = Math.min(task.pixels / base.width, task.pixels * Math.SQRT2 / base.height);
    let viewport = page.getViewport(clone({ scale }));
    // Canvas and its context live in PDF.js's realm. They are entirely separate
    // from the native reader canvases and are released immediately after use.
    let canvas = win.document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    try {
      let context = canvas.getContext("2d");
      Components.utils.waiveXrays(context).skipBlender = true;
      task.renderTask = page.render(clone({ canvasContext: context, viewport, background: "rgb(255,255,255)" }));
      await task.renderTask.promise;
      if (task.cancelled || record.disposed) return null;
      // This sheet previews the PDF's page content. Live Zotero annotation
      // overlays remain in the normal reader and its native thumbnail sidebar.
      return canvas.toDataURL("image/png");
    }
    finally { canvas.width = 0; canvas.height = 0; }
  },

  cancelRendering(record) {
    record.generation++;
    record.queue = [];
    for (let task of record.tasks) { task.cancelled = true; task.renderTask?.cancel(); }
    if (record.frameRequest) { record.doc.defaultView.cancelAnimationFrame(record.frameRequest); record.frameRequest = null; }
    if (record.zoomTimer) { clearTimeout(record.zoomTimer); record.zoomTimer = null; }
    record.zooming = false;
  },

  openPage(record, index) {
    record.selected = index;
    this.setVisible(record, false);
    record.reader.navigate({ pageIndex: index });
  },

  handleKey(record, event) {
    if (event.key === "Escape") { event.preventDefault(); this.setVisible(record, false); return; }
    if (event.key === "Tab") {
      let focusable = [...record.overlay.querySelectorAll("button,input,[tabindex]")].filter(node => node.tabIndex >= 0 && !node.disabled);
      let index = focusable.indexOf(record.doc.activeElement);
      let next = (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
      if (focusable.length) { event.preventDefault(); focusable[next].focus(); }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && ["+", "=", "-", "0"].includes(event.key)) {
      event.preventDefault();
      this.resize(record, event.key === "0" ? 200 : record.size + (event.key === "-" ? -20 : 20));
      return;
    }
    if (!record.ready || !record.count || !record.layout) return;
    if (event.target === record.slider || event.target.closest(".zvp-contact-close")) return;
    let next = record.selected;
    if (event.key === "ArrowRight") next++;
    else if (event.key === "ArrowLeft") next--;
    else if (event.key === "ArrowDown") next += record.layout?.columns || 1;
    else if (event.key === "ArrowUp") next -= record.layout?.columns || 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = record.count - 1;
    else if (event.key === "Enter" && event.target === record.scroll) { event.preventDefault(); this.openPage(record, record.selected); return; }
    else return;
    event.preventDefault();
    record.selected = Math.max(0, Math.min(record.count - 1, next));
    let rowTop = Math.floor(record.selected / record.layout.columns) * record.layout.rowHeight;
    if (rowTop < record.scroll.scrollTop || rowTop + record.layout.rowHeight > record.scroll.scrollTop + record.scroll.clientHeight) record.scroll.scrollTop = rowTop;
    this.layout(record);
    record.cells.get(record.selected)?.node.focus();
  },

  addWindow(window) {
    if (!this.active || this.windows.has(window)) return;
    let popup = window.document.getElementById("menu_ToolsPopup");
    if (!popup) return;
    let menu = window.document.createXULElement("menuitem");
    menu.id = this.menuID;
    menu.setAttribute("type", "checkbox");
    menu.setAttribute("label", "Open PDFs in Contact Sheet");
    menu.setAttribute("checked", String(this.autoOpen()));
    let command = () => { Services.prefs.setBoolPref(this.preference, !this.autoOpen()); this.refreshMenus(); };
    let showing = () => this.refreshMenus();
    menu.addEventListener("command", command);
    popup.addEventListener("popupshowing", showing);
    popup.append(menu);
    this.windows.set(window, { menu, popup, command, showing });
  },

  refreshMenus() { for (let { menu } of this.windows.values()) menu.setAttribute("checked", String(this.autoOpen())); },

  removeWindow(window) {
    let record = this.windows.get(window);
    if (!record) return;
    record.menu.removeEventListener("command", record.command);
    record.popup.removeEventListener("popupshowing", record.showing);
    record.menu.remove();
    this.windows.delete(window);
  },

  removeReader(record) {
    if (record.disposed) return;
    record.disposed = true;
    this.cancelRendering(record);
    record.resizeObserver?.disconnect();
    for (let [node, type, handler] of record.listeners) node.removeEventListener(type, handler);
    let parent = record.button.parentElement;
    if (parent?.classList.contains("section") && parent.childElementCount === 1) parent.remove();
    else record.button.remove();
    record.overlay.remove();
    record.style.remove();
    record.frame.remove();
    record.cache.clear();
    record.failed.clear();
    record.cells.clear();
    this.readers.delete(record.reader);
  },

  stop() {
    this.active = false;
    // The public singular unregister function has an inverted filter in 9.0.6.
    Zotero.Reader._unregisterEventListenerByPluginID(this.id);
    for (let record of [...this.readers.values()]) this.removeReader(record);
    for (let window of [...this.windows.keys()]) this.removeWindow(window);
    this.toolbarHandler = null;
  }
};
function install() {}
function uninstall() {}
async function startup() { await PageThumbnails.start(); }
function shutdown() { PageThumbnails.stop(); }
function onMainWindowLoad({ window }) { PageThumbnails.addWindow(window); }
function onMainWindowUnload({ window }) { PageThumbnails.removeWindow(window); }
