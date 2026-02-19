/*
 * VirtualGridTable
 * Public API:
 * - setLoading(boolean)
 * - setData(arrayOfObjects | { columns, rows })
 * - setSearch(string)
 * - setSearchColumn(index | -1)
 * - clearSearch()
 * - setFilter(fn)
 * - clearFilter()
 * - setColumnFilter(index, filterSpec)
 * - clearColumnFilters()
 * - sortBy(index, "asc" | "desc" | null)
 * - clearSort()
 * - setChunkMode({ columns, totalRows, chunkSize, onChunkRequest?, fetchChunk? })
 * - setChunkRows(startIndex, rows, totalRows?)
 * - setChunkRowCount(totalRows)
 * - clearChunkCache()
 * - getOffsets()
 * - destroy()
 */
class VirtualGridTable {
  static DEFAULT_OPTIONS = {
    width: "100%",
    height: "100%",
    rowHeight: 28,
    visibleCols: 6,
    overscan: 2,
    mode: "local",
    chunkSize: 250,
    totalRows: 0,
    onChunkRequest: null,
    fetchChunk: null,
    demo_mode: false,
    demo_rows: 10000,
  };

  constructor(containerId, options = {}) {
    const host = document.getElementById(containerId);
    if (!host) {
      throw new Error("VirtualGridTable: container not found: " + containerId);
    }

    this._host = host;
    this._opts = this._normalizeOptions(options);

    this._columns = [];
    this._rows = [];
    this._view = null;
    this._viewCount = 0;
    this._mode = this._opts.mode === "chunked" ? "chunked" : "local";
    this._chunkRows = new Map();
    this._chunkPending = new Set();
    this._chunkSize = this._clamp(Math.floor(Number(this._opts.chunkSize) || 250), 25, 5000);
    this._chunkTotalRows = Math.max(0, Number(this._opts.totalRows) | 0);
    this._onChunkRequest = typeof this._opts.onChunkRequest === "function" ? this._opts.onChunkRequest : null;
    this._fetchChunk = typeof this._opts.fetchChunk === "function" ? this._opts.fetchChunk : null;
    this._chunkSeq = 0;
    this._nextChunkReason = null;

    this._filter = null;
    this._searchQuery = "";
    this._searchColumn = -1;
    this._sort = null;
    this._columnFilters = new Map();
    this._filterMenuCol = -1;

    this._searchCache = [];
    this._searchColCache = [];

    this._scrollPx = 0;
    this._rowStart = 0;
    this._subPx = 0;

    this._scrollXPx = 0;
    this._colWidths = [];
    this._minColWidth = 72;

    this._bodyH = 0;
    this._bodyW = 0;
    this._renderRows = 0;
    this._headerResize = null;

    this._loading = false;
    this._selectionRange = null;
    this._activePointerGesture = null;
    this._longPressMs = 320;
    this._touchMoveThreshold = 9;

    this._build();
    this._measure();
    this._rebuildBodyPool();
    this._recomputeView();
    this._renderAll();
  }

  setLoading(isLoading) {
    this._loading = Boolean(isLoading);
    this._renderOverlay();
  }

  setData(data) {
    const { columns, rows } = this._normalizeData(data);
    this._mode = "local";
    this._columns = columns;
    this._rows = rows.map((row) => this._toRowArray(row));
    this._chunkRows.clear();
    this._chunkPending.clear();
    this._chunkTotalRows = rows.length;
    this._ensureColWidths(true);
    this._columnFilters.clear();
    this._closeFilterMenu();

    this._resetPipelineState();
    this._recomputeView();
    this._rebuildBodyPool();
    this._clampScroll();
    this._renderAll();
  }

  setSearch(query) {
    this._searchQuery = String(query ?? "").trim().toLowerCase();
    this._onQueryStateChanged("search");
  }

  setSearchColumn(absColIndexOrAll) {
    this._searchColumn = absColIndexOrAll == null ? -1 : absColIndexOrAll | 0;
    this._onQueryStateChanged("search-column");
  }

  clearSearch() {
    this.setSearch("");
  }

  setFilter(filterFn) {
    this._filter = typeof filterFn === "function" ? filterFn : null;
    this._onQueryStateChanged("filter");
  }

  clearFilter() {
    this.setFilter(null);
  }

  sortBy(colIndex, dir) {
    if (dir == null) {
      this._sort = null;
    } else {
      this._sort = {
        colIndex: colIndex | 0,
        dir: dir === "desc" ? -1 : 1,
      };
    }

    this._onQueryStateChanged("sort");
  }

  clearSort() {
    this._sort = null;
    this._onQueryStateChanged("sort");
  }

  setColumnFilter(colIndex, filterSpec) {
    const abs = colIndex | 0;
    if (abs < 0 || abs >= this._columns.length) return;

    const next = this._normalizeColumnFilter(filterSpec);
    if (!next) {
      this._columnFilters.delete(abs);
    } else {
      this._columnFilters.set(abs, next);
    }

    this._closeFilterMenu();
    this._onQueryStateChanged("column-filter");
  }

  clearColumnFilters() {
    if (this._columnFilters.size === 0) return;
    this._columnFilters.clear();
    this._closeFilterMenu();
    this._onQueryStateChanged("column-filter");
  }

  setChunkMode(config = {}) {
    const next = config && typeof config === "object" ? config : {};
    if (typeof next.chunkSize === "number" && Number.isFinite(next.chunkSize)) {
      this._chunkSize = this._clamp(Math.floor(next.chunkSize), 25, 5000);
    }
    if (typeof next.onChunkRequest === "function") this._onChunkRequest = next.onChunkRequest;
    if (typeof next.fetchChunk === "function") this._fetchChunk = next.fetchChunk;

    if (Array.isArray(next.columns)) {
      this._columns = this._normalizeData({ columns: next.columns, rows: [] }).columns;
      this._ensureColWidths(true);
    }

    this._mode = "chunked";
    this._rows = [];
    this._chunkRows.clear();
    this._chunkPending.clear();
    this._columnFilters.clear();
    this._closeFilterMenu();
    this.setChunkRowCount(next.totalRows ?? 0, false);
    this._resetPipelineState();
    this._rebuildBodyPool();
    this._recomputeView();
    this._nextChunkReason = "init";
    this._renderAll();
  }

  setChunkRows(startIndex, rows, totalRows) {
    if (this._mode !== "chunked") return;
    const start = Math.max(0, startIndex | 0);
    const incoming = Array.isArray(rows) ? rows : [];
    if (Number.isFinite(totalRows)) this.setChunkRowCount(totalRows, false);
    const cap = this._chunkTotalRows > 0 ? this._chunkTotalRows : Number.MAX_SAFE_INTEGER;

    for (let i = 0; i < incoming.length; i += 1) {
      const viewIndex = start + i;
      if (viewIndex >= cap) break;
      this._chunkRows.set(viewIndex, this._toRowArray(incoming[i]));
    }

    this._clearPendingWindowsForRange(start, start + incoming.length);

    this._recomputeView();
    this._renderAll();
  }

  setChunkRowCount(totalRows, rerender = true) {
    this._chunkTotalRows = Math.max(0, totalRows | 0);
    for (const index of Array.from(this._chunkRows.keys())) {
      if (index >= this._chunkTotalRows) this._chunkRows.delete(index);
    }
    for (const key of Array.from(this._chunkPending)) {
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const start = parseInt(parts[0], 10) | 0;
      if (start >= this._chunkTotalRows) this._chunkPending.delete(key);
    }
    if (this._mode !== "chunked") return;
    this._recomputeView();
    this._clampScroll();
    if (rerender) this._renderAll();
  }

  clearChunkCache() {
    this._chunkRows.clear();
    this._chunkPending.clear();
    if (this._mode === "chunked") {
      this._nextChunkReason = "cache-cleared";
      this._renderAll();
    }
  }

  getOffsets() {
    const range = this._visibleColumnRange();
    return {
      rowPx: this._scrollPx,
      rowStart: this._rowStart,
      colPx: this._scrollXPx,
      colStart: Math.max(0, range.from - 1),
    };
  }

  destroy() {
    this._ro?.disconnect();
    this._cancelActivePointerGesture();
    this._closeFilterMenu();
    if (this._boundWindowPointerDown) {
      window.removeEventListener("pointerdown", this._boundWindowPointerDown, true);
      this._boundWindowPointerDown = null;
    }
    if (this._boundWindowResize) {
      window.removeEventListener("resize", this._boundWindowResize);
      this._boundWindowResize = null;
    }
    this._root?.remove();
  }

  _normalizeOptions(options) {
    return {
      ...VirtualGridTable.DEFAULT_OPTIONS,
      ...options,
    };
  }

  _normalizeData(data) {
    if (Array.isArray(data)) {
      if (data.length === 0) {
        return { columns: [], rows: [] };
      }

      const keys = Object.keys(data[0]);
      return {
        columns: keys.map((key) => ({ key, label: key })),
        rows: data.map((row) => keys.map((key) => row[key])),
      };
    }

    if (data && typeof data === "object" && Array.isArray(data.rows)) {
      return {
        columns: (data.columns ?? []).map((col) => {
          if (typeof col === "string") return { key: col, label: col };
          if (col && typeof col === "object") {
            return { key: col.key ?? col.label, label: col.label ?? col.key };
          }
          return { key: String(col), label: String(col) };
        }),
        rows: data.rows,
      };
    }

    throw new Error("VirtualGridTable.setData: invalid input");
  }

  _resetPipelineState() {
    this._searchCache = new Array(this._rows.length).fill(null);
    this._searchColCache = new Array(this._rows.length).fill(null);

    this._scrollXPx = 0;
    this._scrollPx = 0;
    this._sort = null;
    this._clearSelection(false);
  }

  _build() {
    const root = document.createElement("div");
    root.className = "vgt";
    root.style.width = this._toCssSize(this._opts.width);
    root.style.height = this._toCssSize(this._opts.height);
    root.style.setProperty("--vgt-row-h", this._opts.rowHeight + "px");
    root.tabIndex = 0;
    this._root = root;

    const top = document.createElement("div");
    top.className = "vgt__top";
    
    const toolbar = document.createElement("div");
    toolbar.className = "vgt__toolbar";

    const head = document.createElement("div");
    head.className = "vgt__head";
    this._head = head;

    const headBumper = document.createElement("button");
    headBumper.className = "vgt__headBumper";
    headBumper.type = "button";
    headBumper.title = "Select all";
    headBumper.setAttribute("aria-label", "Select all cells");
    this._headBumper = headBumper;

    const headInner = document.createElement("div");
    headInner.className = "vgt__headInner";
    this._headInner = headInner;
    head.append(headBumper, headInner);

    const mid = document.createElement("div");
    mid.className = "vgt__mid";
    this._mid = mid;

    const rowsHost = document.createElement("div");
    rowsHost.className = "vgt__rows";
    this._rowsHost = rowsHost;

    const rowBumpers = document.createElement("div");
    rowBumpers.className = "vgt__rowBumpers";
    this._rowBumpers = rowBumpers;

    const rowBumpersInner = document.createElement("div");
    rowBumpersInner.className = "vgt__rowBumpersInner";
    this._rowBumpersInner = rowBumpersInner;
    rowBumpers.append(rowBumpersInner);

    const rowsInner = document.createElement("div");
    rowsInner.className = "vgt__rowsInner";
    this._rowsInner = rowsInner;
    rowsHost.append(rowsInner);

    const scroll = document.createElement("div");
    scroll.className = "vgt__scroll";

    const sUp = this._createButton("vgt__sbtn", "\u2191", () => this._scrollBy(-this._bodyH * 0.9), "Scroll up");
    const sDown = this._createButton("vgt__sbtn", "\u2193", () => this._scrollBy(this._bodyH * 0.9), "Scroll down");
    this._sUp = sUp;
    this._sDown = sDown;

    const track = document.createElement("div");
    track.className = "vgt__track";
    this._track = track;

    const thumb = document.createElement("div");
    thumb.className = "vgt__thumb";
    this._thumb = thumb;
    track.append(thumb);
    scroll.append(sUp, track, sDown);

    const hscroll = document.createElement("div");
    hscroll.className = "vgt__hscroll";

    const htrack = document.createElement("div");
    htrack.className = "vgt__htrack";
    this._hTrack = htrack;

    const hthumb = document.createElement("div");
    hthumb.className = "vgt__hthumb";
    this._hThumb = hthumb;
    htrack.append(hthumb);
    hscroll.append(htrack);

    const corner = document.createElement("div");
    corner.className = "vgt__corner";

    const overlay = document.createElement("div");
    overlay.className = "vgt__overlay";
    overlay.dataset.show = "1";
    overlay.textContent = "No data to display";
    this._overlay = overlay;

    mid.append(rowBumpers, rowsHost, scroll, hscroll, corner, overlay);

    const footer = document.createElement("div");
    footer.className = "vgt__footer";
    const footerSpacer = document.createElement("div");
    footerSpacer.className = "vgt__footerSpacer";

    const searchWrap = document.createElement("div");
    searchWrap.className = "vgt__searchWrap";

    const searchSel = document.createElement("select");
    searchSel.className = "vgt__searchSelect";
    searchSel.addEventListener("change", () => {
      this.setSearchColumn(parseInt(searchSel.value, 10));
    });
    this._searchSel = searchSel;

    const searchInp = document.createElement("input");
    searchInp.className = "vgt__searchInput";
    searchInp.type = "search";
    searchInp.placeholder = "Search...";
    searchInp.autocomplete = "off";
    searchInp.spellcheck = false;
    searchInp.addEventListener("input", () => this.setSearch(searchInp.value));
    this._searchInp = searchInp;

    const clearBtn = this._createButton("vgt__pill", "Clear", () => {
      this._searchInp.value = "";
      this._searchSel.value = "-1";
      this._searchColumn = -1;
      this.setSearch("");
    });

    searchWrap.append(searchSel, searchInp, clearBtn);

    const pager = document.createElement("div");
    pager.className = "vgt__pager";

    const pUp = this._createButton("vgt__pill vgt__navBtn", "\u2191", () => this._scrollBy(-this._bodyH), "Page up");
    const pDown = this._createButton("vgt__pill vgt__navBtn", "\u2193", () => this._scrollBy(this._bodyH), "Page down");
    const pLeft = this._createButton("vgt__pill vgt__navBtn", "\u2190", () => this._scrollXBy(-this._bodyW * 0.9), "Scroll left");
    const pRight = this._createButton("vgt__pill vgt__navBtn", "\u2192", () => this._scrollXBy(this._bodyW * 0.9), "Scroll right");
    this._pLeft = pLeft;
    this._pRight = pRight;
    this._pUp = pUp;
    this._pDown = pDown;
    pager.append(pLeft, pUp, pDown, pRight);

    const status = document.createElement("div");
    status.className = "vgt__status";
    this._status = status;

    const filterMenu = document.createElement("div");
    filterMenu.className = "vgt__filterMenu";
    filterMenu.dataset.open = "0";
    this._filterMenu = filterMenu;

    const filterTitle = document.createElement("div");
    filterTitle.className = "vgt__filterTitle";
    filterMenu.append(filterTitle);
    this._filterTitle = filterTitle;

    const filterOp = document.createElement("select");
    filterOp.className = "vgt__filterOp";
    const filterOps = ["like", "=", ">", "<", ">=", "<=", "not", "between"];
    for (let i = 0; i < filterOps.length; i += 1) {
      const option = document.createElement("option");
      option.value = filterOps[i];
      option.textContent = filterOps[i];
      filterOp.append(option);
    }
    filterOp.addEventListener("change", () => this._syncFilterMenuInputs());
    filterMenu.append(filterOp);
    this._filterOp = filterOp;

    const filterValueA = document.createElement("input");
    filterValueA.className = "vgt__filterInput";
    filterValueA.type = "text";
    filterValueA.placeholder = "Value";
    filterValueA.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this._applyFilterMenu();
      }
    });
    filterMenu.append(filterValueA);
    this._filterValueA = filterValueA;

    const filterValueB = document.createElement("input");
    filterValueB.className = "vgt__filterInput";
    filterValueB.type = "text";
    filterValueB.placeholder = "And";
    filterValueB.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this._applyFilterMenu();
      }
    });
    filterMenu.append(filterValueB);
    this._filterValueB = filterValueB;

    const filterActions = document.createElement("div");
    filterActions.className = "vgt__filterActions";
    const applyFilterBtn = this._createButton("vgt__pill vgt__filterApply", "Apply", () => this._applyFilterMenu());
    const clearFilterBtn = this._createButton("vgt__pill vgt__filterClear", "Clear", () => {
      if (this._filterMenuCol >= 0) this.setColumnFilter(this._filterMenuCol, null);
    });
    filterActions.append(applyFilterBtn, clearFilterBtn);
    filterMenu.append(filterActions);

    toolbar.append(searchWrap);
    top.append(toolbar, head);
    footer.append(footerSpacer, pager, status);
    root.append(top, mid, footer, filterMenu);

    this._host.innerHTML = "";
    this._host.append(root);

    this._bindEvents();
    this._syncFilterMenuInputs();
    this._renderSearchOptions();
  }

  _bindEvents() {
    this._mid.addEventListener(
      "wheel",
      (event) => {
        const horizontalIntent = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
        event.preventDefault();

        if (horizontalIntent) {
          const dx = event.shiftKey ? event.deltaY : event.deltaX;
          this._scrollXBy(dx);
          return;
        }

        this._scrollBy(event.deltaY);
      },
      { passive: false }
    );

    this._root.addEventListener("keydown", (event) => {
      const k = event.key;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && k.toLowerCase() === "c") {
        if (this._hasSelection() && !this._isEditableTarget(event.target)) {
          event.preventDefault();
          this._copySelectionToClipboard();
        }
        return;
      }
      if (k === "PageDown") {
        event.preventDefault();
        this._scrollBy(this._bodyH);
      } else if (k === "PageUp") {
        event.preventDefault();
        this._scrollBy(-this._bodyH);
      } else if (k === "Home") {
        event.preventDefault();
        this._setScrollPx(0);
      } else if (k === "End") {
        event.preventDefault();
        this._setScrollPx(this._maxScrollPx());
      } else if (k === "ArrowDown") {
        event.preventDefault();
        this._scrollBy(this._opts.rowHeight);
      } else if (k === "ArrowUp") {
        event.preventDefault();
        this._scrollBy(-this._opts.rowHeight);
      } else if (k === "ArrowRight") {
        event.preventDefault();
        this._scrollXBy(56);
      } else if (k === "ArrowLeft") {
        event.preventDefault();
        this._scrollXBy(-56);
      } else if (k === "Escape") {
        if (this._hasSelection()) {
          event.preventDefault();
          this._clearSelection();
        }
        if (this._filterMenuCol >= 0) {
          event.preventDefault();
          this._closeFilterMenu();
        }
      }
    });

    this._thumb.addEventListener("pointerdown", (event) => this._thumbDragStart(event));
    this._track.addEventListener("pointerdown", (event) => {
      if (event.target === this._thumb) return;
      const rect = this._track.getBoundingClientRect();
      const ratio = this._ratioFromTrackY(event.clientY - rect.top);
      this._setScrollPx(ratio * this._maxScrollPx());
    });

    this._hThumb.addEventListener("pointerdown", (event) => this._hThumbDragStart(event));
    this._hTrack.addEventListener("pointerdown", (event) => {
      if (event.target === this._hThumb) return;
      const rect = this._hTrack.getBoundingClientRect();
      const ratio = this._ratioFromHTrackX(event.clientX - rect.left);
      this._setScrollXPx(ratio * this._maxScrollXPx());
    });
    this._headBumper.addEventListener("click", (event) => {
      event.preventDefault();
      this._selectAllCells();
    });
    this._rowsHost.addEventListener("pointerdown", (event) => this._rowsPointerStart(event));
    this._rowBumpers.addEventListener("pointerdown", (event) => this._rowBumperPointerStart(event));
    this._root.addEventListener("copy", (event) => this._onCopy(event));
    this._boundWindowPointerDown = (event) => this._windowPointerDown(event);
    window.addEventListener("pointerdown", this._boundWindowPointerDown, true);
    this._boundWindowResize = () => this._closeFilterMenu();
    window.addEventListener("resize", this._boundWindowResize, { passive: true });

    this._ro = new ResizeObserver(() => {
      this._measure();
      this._rebuildBodyPool();
      this._clampScroll();
      this._renderAll();
    });
    this._ro.observe(this._mid);
  }

  _measure() {
    const rowsRect = this._rowsHost.getBoundingClientRect();
    this._bodyH = Math.max(0, rowsRect.height);
    this._bodyW = Math.max(0, rowsRect.width);
    this._ensureColWidths();
  }

  _rebuildBodyPool() {
    const visibleRows = Math.max(1, Math.ceil(this._bodyH / this._opts.rowHeight));
    const poolRows = visibleRows + this._opts.overscan * 2;
    const colCount = Math.max(1, this._columns.length);

    if (
      poolRows === this._renderRows &&
      this._rowEls?.length &&
      this._rowEls[0]?.cellEls.length === colCount
    ) {
      return;
    }

    this._renderRows = poolRows;
    this._rowEls = [];
    this._rowsInner.innerHTML = "";
    this._rowBumpersInner.innerHTML = "";

    for (let rowIndex = 0; rowIndex < poolRows; rowIndex += 1) {
      const rowEl = document.createElement("div");
      rowEl.className = "vgt__row";
      rowEl.dataset.pool = String(rowIndex);
      rowEl.dataset.viewRow = "-1";

      const bumperEl = document.createElement("button");
      bumperEl.className = "vgt__rowBumper";
      bumperEl.type = "button";
      bumperEl.dataset.pool = String(rowIndex);
      bumperEl.dataset.viewRow = "-1";
      bumperEl.setAttribute("aria-label", "Select row");

      const cellEls = [];
      for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
        const cell = document.createElement("div");
        cell.className = "vgt__cell";
        cell.dataset.colIndex = String(colIndex);
        cell.textContent = "";
        rowEl.append(cell);
        cellEls.push(cell);
      }

      this._rowsInner.append(rowEl);
      this._rowBumpersInner.append(bumperEl);
      this._rowEls.push({ rowEl, cellEls, bumperEl, baseIndex: -1 });
    }
  }

  _recomputeView() {
    if (this._mode === "chunked") {
      this._view = null;
      if (this._chunkTotalRows > 0) {
        this._viewCount = Math.max(0, this._chunkTotalRows | 0);
      } else if (this._chunkRows.size > 0) {
        let maxIndex = -1;
        for (const index of this._chunkRows.keys()) {
          if (index > maxIndex) maxIndex = index;
        }
        this._viewCount = maxIndex + 1;
      } else {
        this._viewCount = 0;
      }
      return;
    }

    const total = this._rows.length;
    this._view = null;
    this._viewCount = total;

    const hasFilter = Boolean(this._filter);
    const hasSearch = this._searchQuery.length > 0;
    const hasSort = Boolean(this._sort);
    const hasColumnFilters = this._columnFilters.size > 0;
    if (!hasFilter && !hasSearch && !hasSort && !hasColumnFilters) return;

    let idx = new Array(total);
    for (let i = 0; i < total; i += 1) idx[i] = i;

    if (hasFilter) {
      idx = idx.filter((rowIndex) => Boolean(this._filter(this._rows[rowIndex], rowIndex)));
    }

    if (hasColumnFilters) {
      idx = idx.filter((rowIndex) => this._rowPassesColumnFilters(this._rows[rowIndex]));
    }

    if (hasSearch) {
      const query = this._searchQuery;
      const searchColumn = this._searchColumn | 0;
      if (searchColumn < 0) {
        idx = idx.filter((rowIndex) => this._rowSearchStr(rowIndex).includes(query));
      } else {
        idx = idx.filter((rowIndex) => this._rowSearchColStr(rowIndex, searchColumn).includes(query));
      }
    }

    if (hasSort) {
      const { colIndex, dir } = this._sort;
      idx.sort((aIndex, bIndex) => {
        const a = this._rows[aIndex]?.[colIndex];
        const b = this._rows[bIndex]?.[colIndex];
        const cmp = this._cmp(a, b);
        if (cmp !== 0) return cmp * dir;
        return aIndex - bIndex;
      });
    }

    this._view = idx;
    this._viewCount = idx.length;
  }

  _onQueryStateChanged(reason) {
    this._clearSelection(false);
    if (this._mode === "chunked") {
      this._scrollPx = 0;
      this._rowStart = 0;
      this._subPx = 0;
      this._clearChunkAndRequest(reason);
      return;
    }

    this._recomputeView();
    this._clampScroll();
    this._renderAll();
  }

  _clearChunkAndRequest(reason) {
    this._chunkRows.clear();
    this._chunkPending.clear();
    this._clearSelection(false);
    this._nextChunkReason = reason ?? "query-change";
    this._recomputeView();
    this._renderAll();
  }

  _rowPassesColumnFilters(row) {
    const source = Array.isArray(row) ? row : [];
    for (const [colIndex, filterSpec] of this._columnFilters.entries()) {
      if (!this._matchesColumnFilter(source[colIndex], filterSpec)) return false;
    }
    return true;
  }

  _normalizeColumnFilter(filterSpec) {
    if (!filterSpec || typeof filterSpec !== "object") return null;
    const op = String(filterSpec.op ?? "").toLowerCase();
    const allowed = new Set(["like", "=", ">", "<", ">=", "<=", "not", "between"]);
    if (!allowed.has(op)) return null;

    const value = filterSpec.value == null ? "" : String(filterSpec.value).trim();
    const valueTo = filterSpec.valueTo == null ? "" : String(filterSpec.valueTo).trim();
    if (op === "between" && (!value || !valueTo)) return null;
    if (op !== "between" && !value) return null;

    return { op, value, valueTo };
  }

  _matchesColumnFilter(cellValue, spec) {
    const leftRaw = cellValue == null ? "" : String(cellValue).trim();
    const left = leftRaw.toLowerCase();
    const right = spec.value.toLowerCase();
    const rightB = spec.valueTo.toLowerCase();

    if (spec.op === "like") return left.includes(right);
    if (spec.op === "=") return left === right;
    if (spec.op === "not") return left !== right;

    const leftNum = Number(leftRaw);
    const rightNum = Number(spec.value);
    const rightNumB = Number(spec.valueTo);
    const numeric = Number.isFinite(leftNum) && Number.isFinite(rightNum);
    const cmpA = numeric ? leftNum - rightNum : this._cmp(left, right);
    if (spec.op === ">") return cmpA > 0;
    if (spec.op === "<") return cmpA < 0;
    if (spec.op === ">=") return cmpA >= 0;
    if (spec.op === "<=") return cmpA <= 0;
    if (spec.op === "between") {
      if (numeric && Number.isFinite(rightNumB)) {
        const low = Math.min(rightNum, rightNumB);
        const high = Math.max(rightNum, rightNumB);
        return leftNum >= low && leftNum <= high;
      }
      const lo = right <= rightB ? right : rightB;
      const hi = right <= rightB ? rightB : right;
      return left >= lo && left <= hi;
    }

    return true;
  }

  _rowSearchStr(baseIndex) {
    let cached = this._searchCache[baseIndex];
    if (cached != null) return cached;

    const row = this._rows[baseIndex] || [];
    let out = "";
    for (let i = 0; i < row.length; i += 1) {
      const value = row[i];
      if (value == null) continue;
      out += String(value).toLowerCase() + "\u0001";
    }

    this._searchCache[baseIndex] = out;
    return out;
  }

  _rowSearchColStr(baseIndex, absColIndex) {
    let rowCache = this._searchColCache[baseIndex];
    if (rowCache == null) {
      rowCache = new Array(this._columns.length).fill(null);
      this._searchColCache[baseIndex] = rowCache;
    }

    let cached = rowCache[absColIndex];
    if (cached != null) return cached;

    const value = this._rows[baseIndex]?.[absColIndex];
    cached = value == null ? "" : String(value).toLowerCase();
    rowCache[absColIndex] = cached;
    return cached;
  }

  _cmp(a, b) {
    const an = typeof a === "number" ? a : a != null && a !== "" ? Number(a) : NaN;
    const bn = typeof b === "number" ? b : b != null && b !== "" ? Number(b) : NaN;

    const aNum = Number.isFinite(an);
    const bNum = Number.isFinite(bn);
    if (aNum && bNum) return an < bn ? -1 : an > bn ? 1 : 0;

    const sa = a == null ? "" : String(a);
    const sb = b == null ? "" : String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  _viewIndexToBase(viewIndex) {
    if (viewIndex < 0 || viewIndex >= this._viewCount) return -1;
    return this._view ? this._view[viewIndex] : viewIndex;
  }

  _ensureColWidths(reset = false) {
    const colCount = this._columns.length;
    if (colCount === 0) {
      this._colWidths = [];
      return;
    }

    const defaultWidth = Math.max(this._minColWidth, Math.floor(this._bodyW / Math.max(1, this._opts.visibleCols)));
    if (reset || this._colWidths.length !== colCount) {
      const next = new Array(colCount);
      for (let i = 0; i < colCount; i += 1) {
        const incoming = this._columns[i]?.width;
        const prior = !reset ? this._colWidths[i] : null;
        const width = Number.isFinite(incoming) ? incoming : Number.isFinite(prior) ? prior : defaultWidth;
        next[i] = this._clamp(Math.floor(width), this._minColWidth, 1200);
      }
      this._colWidths = next;
    }
  }

  _columnTemplate() {
    if (this._colWidths.length === 0) return `${this._minColWidth}px`;
    return this._colWidths.map((width) => `${width}px`).join(" ");
  }

  _totalContentWidth() {
    let width = 0;
    for (let i = 0; i < this._colWidths.length; i += 1) width += this._colWidths[i];
    return width;
  }

  _visibleColumnRange() {
    if (this._columns.length === 0) return { from: 0, to: 0 };

    let x = 0;
    let from = 0;
    while (from < this._colWidths.length && x + this._colWidths[from] <= this._scrollXPx) {
      x += this._colWidths[from];
      from += 1;
    }

    let to = from;
    let visibleX = x;
    const right = this._scrollXPx + this._bodyW;
    while (to < this._colWidths.length && visibleX < right) {
      visibleX += this._colWidths[to];
      to += 1;
    }

    return { from: from + 1, to };
  }

  _renderAll() {
    this._renderHeader();
    this._renderBody();
    this._renderScrollbar();
    this._renderHScrollbar();
    this._renderOverlay();
    this._renderStatus();
    this._renderNavDisabled();
    this._renderSearchOptions();
  }

  _renderHeader() {
    this._ensureColWidths();
    const colCount = Math.max(1, this._columns.length);

    if (!this._hcells || this._hcells.length !== colCount) {
      this._headInner.innerHTML = "";
      this._hcells = [];

      for (let slot = 0; slot < colCount; slot += 1) {
        const hc = document.createElement("div");
        hc.className = "vgt__hcell";
        hc.dataset.slot = String(slot);
        hc.addEventListener("click", (event) => {
          if (event.target instanceof Element && event.target.closest(".vgt__resizeHandle")) return;
          if (event.target instanceof Element && event.target.closest(".vgt__filterBtn")) return;
          const abs = parseInt(hc.dataset.abs || "-1", 10) | 0;
          if (abs >= 0) this._toggleSort(abs);
        });

        this._headInner.append(hc);
        this._hcells.push(hc);
      }
    }

    this._headInner.style.gridTemplateColumns = this._columnTemplate();
    this._headInner.style.width = this._totalContentWidth() + "px";
    this._headInner.style.transform = `translateX(${-this._scrollXPx}px)`;

    for (let slot = 0; slot < colCount; slot += 1) {
      const abs = slot;
      const col = this._columns[abs];
      const headerCell = this._hcells[slot];
      headerCell.dataset.abs = String(abs);
      headerCell.innerHTML = "";

      if (!col) {
        headerCell.style.pointerEvents = "none";
        headerCell.style.opacity = "0.35";
        continue;
      }

      headerCell.style.pointerEvents = "auto";
      headerCell.style.opacity = "1";

      const label = col.label ?? col.key ?? "";
      const labelEl = document.createElement("span");
      labelEl.className = "vgt__hlabel";
      labelEl.textContent = label;
      headerCell.append(labelEl);

      const controls = document.createElement("span");
      controls.className = "vgt__hcontrols";

      if (this._sort && this._sort.colIndex === abs) {
        const sortEl = document.createElement("span");
        sortEl.className = "vgt__sort";
        sortEl.textContent = this._sort.dir === 1 ? "\u2191" : "\u2193";
        controls.append(sortEl);
      }

      const filterBtn = document.createElement("button");
      filterBtn.className = "vgt__filterBtn";
      filterBtn.type = "button";
      filterBtn.textContent = "\u25BE";
      filterBtn.title = "Column filter";
      filterBtn.dataset.active = this._columnFilters.has(abs) ? "1" : "0";
      filterBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._toggleFilterMenu(abs, filterBtn);
      });
      controls.append(filterBtn);
      headerCell.append(controls);

      const handle = document.createElement("div");
      handle.className = "vgt__resizeHandle";
      handle.addEventListener("pointerdown", (event) => this._startHeaderResize(event, abs));
      headerCell.append(handle);
    }

    this._syncHeadBumperState();
  }

  _renderSearchOptions() {
    if (!this._searchSel) return;

    this._searchSel.innerHTML = "";
    const all = document.createElement("option");
    all.value = "-1";
    all.textContent = "All columns";
    this._searchSel.append(all);

    for (let i = 0; i < this._columns.length; i += 1) {
      const col = this._columns[i];
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = col && (col.label ?? col.key) ? String(col.label ?? col.key) : "Col " + (i + 1);
      this._searchSel.append(option);
    }

    this._searchSel.value = String(this._searchColumn ?? -1);
  }

  _toggleFilterMenu(absCol, anchorEl) {
    if (this._filterMenuCol === absCol && this._filterMenu?.dataset.open === "1") {
      this._closeFilterMenu();
      return;
    }
    this._openFilterMenu(absCol, anchorEl);
  }

  _openFilterMenu(absCol, anchorEl) {
    const col = this._columns[absCol];
    if (!col || !this._filterMenu || !this._filterOp || !this._filterValueA || !this._filterValueB) return;

    this._filterMenuCol = absCol;
    const existing = this._columnFilters.get(absCol);
    this._filterTitle.textContent = "Filter: " + String(col.label ?? col.key ?? "Column " + (absCol + 1));
    this._filterOp.value = existing?.op ?? "like";
    this._filterValueA.value = existing?.value ?? "";
    this._filterValueB.value = existing?.valueTo ?? "";
    this._syncFilterMenuInputs();

    this._filterMenu.dataset.open = "1";
    this._filterMenu.style.visibility = "hidden";

    const rootRect = this._root.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const menuRect = this._filterMenu.getBoundingClientRect();
    let left = anchorRect.left - rootRect.left;
    let top = anchorRect.bottom - rootRect.top + 4;
    left = this._clamp(left, 6, Math.max(6, rootRect.width - menuRect.width - 6));
    top = this._clamp(top, 6, Math.max(6, rootRect.height - menuRect.height - 6));

    this._filterMenu.style.left = left + "px";
    this._filterMenu.style.top = top + "px";
    this._filterMenu.style.visibility = "visible";
    this._filterValueA.focus();
    this._filterValueA.select();
  }

  _closeFilterMenu() {
    if (!this._filterMenu) return;
    this._filterMenuCol = -1;
    this._filterMenu.dataset.open = "0";
    this._filterMenu.style.left = "";
    this._filterMenu.style.top = "";
    this._filterMenu.style.visibility = "";
  }

  _syncFilterMenuInputs() {
    if (!this._filterOp || !this._filterValueB) return;
    const isBetween = this._filterOp.value === "between";
    this._filterValueB.style.display = isBetween ? "block" : "none";
    this._filterValueB.disabled = !isBetween;
  }

  _applyFilterMenu() {
    if (this._filterMenuCol < 0 || !this._filterOp || !this._filterValueA || !this._filterValueB) return;
    this.setColumnFilter(this._filterMenuCol, {
      op: this._filterOp.value,
      value: this._filterValueA.value,
      valueTo: this._filterOp.value === "between" ? this._filterValueB.value : "",
    });
  }

  _windowPointerDown(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (this._filterMenuCol >= 0) {
      if (!target.closest(".vgt__filterMenu") && !target.closest(".vgt__filterBtn")) {
        this._closeFilterMenu();
      }
    }
    if (this._hasSelection() && !target.closest(".vgt__cell") && !target.closest(".vgt__rowBumper")) {
      this._clearSelection();
    }
  }

  _renderBody() {
    this._ensureColWidths();
    const rowHeight = this._opts.rowHeight;
    const slots = Math.max(1, this._columns.length);
    const template = this._columnTemplate();
    const contentW = this._totalContentWidth();

    if (this._maxScrollPx() <= 0) this._scrollPx = 0;
    if (this._maxScrollXPx() <= 0) this._scrollXPx = 0;

    const rawStart = Math.floor(this._scrollPx / rowHeight);
    const subPx = this._scrollPx - rawStart * rowHeight;

    const start = Math.max(0, rawStart - this._opts.overscan);

    this._rowStart = rawStart;
    this._subPx = subPx;

    const appliedRowOverscan = rawStart - start;

    this._rowsInner.style.transform =
      "translate(" +
      -this._scrollXPx +
      "px, " +
      (-subPx - appliedRowOverscan * rowHeight) +
      "px)";
    this._rowBumpersInner.style.transform = "translateY(" + (-subPx - appliedRowOverscan * rowHeight) + "px)";
    this._rowsInner.style.width = contentW + "px";

    for (let i = 0; i < this._rowEls.length; i += 1) {
      const viewIndex = start + i;
      const baseIndex = this._viewIndexToBase(viewIndex);
      const slot = this._rowEls[i];

      slot.rowEl.style.gridTemplateColumns = template;
      slot.rowEl.style.width = contentW + "px";

      if (baseIndex < 0) {
        slot.rowEl.style.visibility = "hidden";
        slot.bumperEl.style.visibility = "hidden";
        slot.baseIndex = -1;
        slot.rowEl.dataset.baseIndex = "-1";
        slot.rowEl.dataset.viewRow = "-1";
        slot.bumperEl.dataset.viewRow = "-1";
        slot.bumperEl.dataset.selected = "0";
        continue;
      }

      slot.rowEl.style.visibility = "visible";
      slot.bumperEl.style.visibility = "visible";
      slot.baseIndex = baseIndex;
      slot.rowEl.dataset.baseIndex = String(baseIndex);
      slot.rowEl.dataset.viewRow = String(viewIndex);
      slot.bumperEl.dataset.viewRow = String(viewIndex);
      slot.bumperEl.dataset.selected = this._isRowFullySelected(viewIndex) ? "1" : "0";

      const row = this._mode === "chunked" ? this._chunkRows.get(baseIndex) : this._rows[baseIndex] || [];
      const isChunkLoading = this._mode === "chunked" && !row;
      slot.rowEl.dataset.loading = isChunkLoading ? "1" : "0";
      for (let c = 0; c < slots; c += 1) {
        const value = row ? row[c] : c === 0 ? "Loading..." : "";
        const cellEl = slot.cellEls[c];
        cellEl.textContent = value == null ? "" : String(value);
        cellEl.classList.toggle("vgt__cell--selected", this._isCellSelected(viewIndex, c));
      }
    }

    if (this._mode === "chunked") {
      const reason = this._nextChunkReason ?? "viewport";
      this._nextChunkReason = null;
      this._ensureChunkForViewport(reason);
    }
  }

  _renderScrollbar() {
    const trackH = this._track.getBoundingClientRect().height;
    const contentH = this._viewCount * this._opts.rowHeight;
    const viewH = this._bodyH;

    if (contentH <= 0 || viewH <= 0 || contentH <= viewH) {
      this._thumb.style.height = Math.max(18, trackH) + "px";
      this._thumb.style.transform = "translateY(0px)";
      this._thumbDisabled = true;
      return;
    }

    this._thumbDisabled = false;

    const thumbH = Math.max(18, Math.floor(trackH * (viewH / contentH)));
    const maxTop = Math.max(0, trackH - thumbH);
    const ratio = this._maxScrollPx() > 0 ? this._scrollPx / this._maxScrollPx() : 0;
    const top = Math.floor(maxTop * this._clamp01(ratio));

    this._thumb.style.height = thumbH + "px";
    this._thumb.style.transform = "translateY(" + top + "px)";
  }

  _renderHScrollbar() {
    const trackW = this._hTrack.getBoundingClientRect().width;
    const contentW = this._totalContentWidth();
    const viewW = this._bodyW;

    if (contentW <= 0 || viewW <= 0 || contentW <= viewW) {
      this._hThumb.style.width = Math.max(24, trackW) + "px";
      this._hThumb.style.transform = "translateX(0px)";
      this._hThumbDisabled = true;
      return;
    }

    this._hThumbDisabled = false;

    const thumbW = Math.max(24, Math.floor(trackW * (viewW / contentW)));
    const maxLeft = Math.max(0, trackW - thumbW);
    const ratio = this._maxScrollXPx() > 0 ? this._scrollXPx / this._maxScrollXPx() : 0;
    const left = Math.floor(maxLeft * this._clamp01(ratio));

    this._hThumb.style.width = thumbW + "px";
    this._hThumb.style.transform = "translateX(" + left + "px)";
  }

  _renderOverlay() {
    if (this._loading) {
      this._overlay.textContent = "Loading...";
      this._overlay.dataset.show = "1";
      return;
    }

    if (this._viewCount <= 0) {
      this._overlay.textContent = "No data to display";
      this._overlay.dataset.show = "1";
      return;
    }

    this._overlay.dataset.show = "0";
  }

  _renderStatus() {
    const totalRows = this._mode === "chunked" ? this._chunkTotalRows : this._rows.length;
    const shownRows = this._viewCount;
    const start = this._rowStart + 1;
    const end = Math.min(shownRows, this._rowStart + Math.ceil(this._bodyH / this._opts.rowHeight));

    const totalCols = this._columns.length;
    const range = this._visibleColumnRange();

    let status = shownRows === 0 ? "0 rows" : `${start}-${end} of ${shownRows} rows`;
    if (shownRows !== totalRows) status += ` (filtered from ${totalRows})`;
    if (this._mode === "chunked" && this._chunkPending.size > 0) status += ` | loading ${this._chunkPending.size} chunk(s)`;
    if (totalCols > 0) status += ` | cols ${range.from}-${range.to} of ${totalCols}`;
    this._status.textContent = status;
  }

  _renderNavDisabled() {
    const canVScroll = this._maxScrollPx() > 0;
    const canHScroll = this._maxScrollXPx() > 0;
    this._sUp.disabled = !canVScroll;
    this._sDown.disabled = !canVScroll;
    this._pUp.disabled = !canVScroll;
    this._pDown.disabled = !canVScroll;
    this._pLeft.disabled = !canHScroll;
    this._pRight.disabled = !canHScroll;
  }

  _toggleSort(absColIndex) {
    if (!this._sort || this._sort.colIndex !== absColIndex) {
      this._sort = { colIndex: absColIndex, dir: 1 };
    } else if (this._sort.dir === 1) {
      this._sort = { colIndex: absColIndex, dir: -1 };
    } else {
      this._sort = null;
    }

    this._onQueryStateChanged("sort");
  }

  _scrollBy(deltaPx) {
    this._setScrollPx(this._scrollPx + deltaPx);
  }

  _scrollXBy(deltaPx) {
    this._setScrollXPx(this._scrollXPx + deltaPx);
  }

  _setScrollPx(px) {
    this._scrollPx = this._clamp(px, 0, this._maxScrollPx());
    this._renderBody();
    this._renderScrollbar();
    this._renderStatus();
    this._renderNavDisabled();
  }

  _setScrollXPx(px) {
    this._scrollXPx = this._clamp(px, 0, this._maxScrollXPx());
    this._renderHeader();
    this._renderBody();
    this._renderHScrollbar();
    this._renderStatus();
    this._renderNavDisabled();
  }

  _clampScroll() {
    this._scrollPx = this._clamp(this._scrollPx, 0, this._maxScrollPx());
    this._scrollXPx = this._clamp(this._scrollXPx, 0, this._maxScrollXPx());
  }

  _maxScrollPx() {
    const content = this._viewCount * this._opts.rowHeight;
    return Math.max(0, Math.floor(content - this._bodyH));
  }

  _maxScrollXPx() {
    const content = this._totalContentWidth();
    return Math.max(0, Math.floor(content - this._bodyW));
  }

  _startHeaderResize(event, colIndex) {
    if (colIndex < 0 || colIndex >= this._colWidths.length) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = this._colWidths[colIndex];
    const pointerId = event.pointerId;
    this._headerResize = { colIndex, pointerId };

    const target = event.currentTarget;
    if (target instanceof Element) {
      try {
        target.setPointerCapture(pointerId);
      } catch (err) {
        void err;
      }
    }

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      const nextWidth = this._clamp(Math.floor(startWidth + (moveEvent.clientX - startX)), this._minColWidth, 1200);
      if (nextWidth === this._colWidths[colIndex]) return;
      this._colWidths[colIndex] = nextWidth;
      this._clampScroll();
      this._renderAll();
    };

    const onUp = () => {
      if (target instanceof Element) {
        try {
          target.releasePointerCapture(pointerId);
        } catch (err) {
          void err;
        }
      }
      this._headerResize = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: true });
  }

  _thumbDragStart(event) {
    if (this._thumbDisabled) return;

    event.preventDefault();
    this._thumb.setPointerCapture(event.pointerId);

    const trackRect = this._track.getBoundingClientRect();
    const thumbRect = this._thumb.getBoundingClientRect();
    const grabOffset = event.clientY - thumbRect.top;
    const maxTop = Math.max(0, trackRect.height - thumbRect.height);

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      const y = moveEvent.clientY - trackRect.top - grabOffset;
      const top = this._clamp(y, 0, maxTop);
      const ratio = maxTop > 0 ? top / maxTop : 0;
      this._setScrollPx(ratio * this._maxScrollPx());
    };

    const onUp = () => {
      try {
        this._thumb.releasePointerCapture(event.pointerId);
      } catch (err) {
        void err;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: true });
  }

  _hThumbDragStart(event) {
    if (this._hThumbDisabled) return;

    event.preventDefault();
    this._hThumb.setPointerCapture(event.pointerId);

    const trackRect = this._hTrack.getBoundingClientRect();
    const thumbRect = this._hThumb.getBoundingClientRect();
    const grabOffset = event.clientX - thumbRect.left;
    const maxLeft = Math.max(0, trackRect.width - thumbRect.width);

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      const x = moveEvent.clientX - trackRect.left - grabOffset;
      const left = this._clamp(x, 0, maxLeft);
      const ratio = maxLeft > 0 ? left / maxLeft : 0;
      this._setScrollXPx(ratio * this._maxScrollXPx());
    };

    const onUp = () => {
      try {
        this._hThumb.releasePointerCapture(event.pointerId);
      } catch (err) {
        void err;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: true });
  }

  _rowsPointerStart(event) {
    if (event.button !== 0 && event.button !== -1) return;
    const startCell = this._cellFromEvent(event);
    if (!startCell) {
      this._clearSelection();
      return;
    }
    event.preventDefault();
    this._startSelectionDrag(event, startCell);
  }

  _rowBumperPointerStart(event) {
    if (event.button !== 0 && event.button !== -1) return;
    const startRow = this._rowFromBumperEvent(event);
    if (startRow < 0) {
      this._clearSelection();
      return;
    }

    event.preventDefault();
    this._activePointerGesture = null;
    this._selectRowRange(startRow, startRow);
    this._root.focus({ preventScroll: true });
    this._rowBumpers.classList.add("vgt__rows--selecting");
    const priorTouchAction = this._rowBumpers.style.touchAction;
    this._rowBumpers.style.touchAction = "none";
    try {
      this._rowBumpers.setPointerCapture(event.pointerId);
    } catch (err) {
      void err;
    }

    const state = {
      active: true,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      vScroll: 0,
      rafId: 0,
    };

    const edgeThreshold = 30;
    const maxEdgeScrollPerFrame = 22;

    const updateFromPointer = (shouldScheduleRaf) => {
      const rect = this._rowBumpers.getBoundingClientRect();
      const topEdge = rect.top + edgeThreshold;
      const bottomEdge = rect.bottom - edgeThreshold;
      if (state.lastClientY < topEdge) {
        const ratio = this._clamp01((topEdge - state.lastClientY) / edgeThreshold);
        state.vScroll = -ratio * maxEdgeScrollPerFrame;
      } else if (state.lastClientY > bottomEdge) {
        const ratio = this._clamp01((state.lastClientY - bottomEdge) / edgeThreshold);
        state.vScroll = ratio * maxEdgeScrollPerFrame;
      } else {
        state.vScroll = 0;
      }

      const nextRow = this._rowFromBumperClientPointClamped(state.lastClientY);
      if (nextRow >= 0) this._selectRowRange(startRow, nextRow);

      if (shouldScheduleRaf && state.rafId === 0 && state.vScroll !== 0) {
        state.rafId = window.requestAnimationFrame(onFrame);
      }
    };

    const onFrame = () => {
      state.rafId = 0;
      if (!state.active) return;
      if (state.vScroll !== 0) this._setScrollPx(this._scrollPx + state.vScroll);
      updateFromPointer(true);
    };

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      state.lastClientX = moveEvent.clientX;
      state.lastClientY = moveEvent.clientY;
      updateFromPointer(true);
    };

    const onUp = () => {
      state.active = false;
      this._rowBumpers.classList.remove("vgt__rows--selecting");
      this._rowBumpers.style.touchAction = priorTouchAction;
      if (state.rafId) window.cancelAnimationFrame(state.rafId);
      try {
        this._rowBumpers.releasePointerCapture(event.pointerId);
      } catch (err) {
        void err;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: true });
    window.addEventListener("pointercancel", onUp, { passive: true });
  }

  _isTouchDragEvent(event) {
    if (!event) return false;
    if (event.pointerType === "touch") return true;
    if (event.pointerType === "mouse") {
      return window.matchMedia ? window.matchMedia("(pointer: coarse)").matches : false;
    }
    if (event.pointerType === "pen") return true;
    return window.matchMedia ? window.matchMedia("(pointer: coarse)").matches : false;
  }

  _cancelActivePointerGesture() {
    if (!this._activePointerGesture) return;
    if (Object.prototype.hasOwnProperty.call(this._activePointerGesture, "priorTouchAction")) {
      this._rowsHost.style.touchAction = this._activePointerGesture.priorTouchAction;
    }
    if (this._activePointerGesture.timer) {
      window.clearTimeout(this._activePointerGesture.timer);
    }
    this._rowsHost.classList.remove("vgt__rows--dragging", "vgt__rows--selecting");
    this._activePointerGesture = null;
  }

  _startSelectionDrag(event, startCell) {
    this._activePointerGesture = null;
    this._setSelectionRange(startCell, startCell);
    this._root.focus({ preventScroll: true });
    this._rowsHost.classList.add("vgt__rows--selecting");
    const priorTouchAction = this._rowsHost.style.touchAction;
    this._rowsHost.style.touchAction = "none";
    try {
      this._rowsHost.setPointerCapture(event.pointerId);
    } catch (err) {
      void err;
    }

    const state = {
      active: true,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      vScrollX: 0,
      vScrollY: 0,
      rafId: 0,
    };

    const edgeThreshold = 30;
    const maxEdgeScrollPerFrame = 22;

    const updateFromPointer = (shouldScheduleRaf) => {
      const rect = this._rowsHost.getBoundingClientRect();
      const leftEdge = rect.left + edgeThreshold;
      const rightEdge = rect.right - edgeThreshold;
      const topEdge = rect.top + edgeThreshold;
      const bottomEdge = rect.bottom - edgeThreshold;

      if (state.lastClientX < leftEdge) {
        const ratio = this._clamp01((leftEdge - state.lastClientX) / edgeThreshold);
        state.vScrollX = -ratio * maxEdgeScrollPerFrame;
      } else if (state.lastClientX > rightEdge) {
        const ratio = this._clamp01((state.lastClientX - rightEdge) / edgeThreshold);
        state.vScrollX = ratio * maxEdgeScrollPerFrame;
      } else {
        state.vScrollX = 0;
      }

      if (state.lastClientY < topEdge) {
        const ratio = this._clamp01((topEdge - state.lastClientY) / edgeThreshold);
        state.vScrollY = -ratio * maxEdgeScrollPerFrame;
      } else if (state.lastClientY > bottomEdge) {
        const ratio = this._clamp01((state.lastClientY - bottomEdge) / edgeThreshold);
        state.vScrollY = ratio * maxEdgeScrollPerFrame;
      } else {
        state.vScrollY = 0;
      }

      const nextCell = this._cellFromClientPointClamped(state.lastClientX, state.lastClientY);
      if (nextCell) this._setSelectionRange(startCell, nextCell);

      if (
        shouldScheduleRaf &&
        state.rafId === 0 &&
        (state.vScrollX !== 0 || state.vScrollY !== 0)
      ) {
        state.rafId = window.requestAnimationFrame(onFrame);
      }
    };

    const onFrame = () => {
      state.rafId = 0;
      if (!state.active) return;
      if (state.vScrollX !== 0) this._setScrollXPx(this._scrollXPx + state.vScrollX);
      if (state.vScrollY !== 0) this._setScrollPx(this._scrollPx + state.vScrollY);
      updateFromPointer(true);
    };

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      state.lastClientX = moveEvent.clientX;
      state.lastClientY = moveEvent.clientY;
      updateFromPointer(true);
    };

    const onUp = () => {
      state.active = false;
      this._rowsHost.classList.remove("vgt__rows--selecting");
      this._rowsHost.style.touchAction = priorTouchAction;
      if (state.rafId) window.cancelAnimationFrame(state.rafId);
      try {
        this._rowsHost.releasePointerCapture(event.pointerId);
      } catch (err) {
        void err;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: true });
    window.addEventListener("pointercancel", onUp, { passive: true });
  }

  _startTouchGesture(event, startCell) {
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const startScrollX = this._scrollXPx;
    const startScrollY = this._scrollPx;
    const priorTouchAction = this._rowsHost.style.touchAction;

    const gesture = {
      mode: startCell ? "pending" : "scroll",
      timer: null,
      startCell,
      startX,
      startY,
      pointerId,
      priorTouchAction,
    };
    this._activePointerGesture = gesture;

    if (gesture.mode === "pending") {
      gesture.timer = window.setTimeout(() => {
        if (this._activePointerGesture !== gesture || gesture.mode !== "pending") return;
        gesture.mode = "select";
        this._rowsHost.classList.add("vgt__rows--selecting");
        this._setSelectionRange(startCell, startCell);
      }, this._longPressMs);
    } else {
      this._rowsHost.classList.add("vgt__rows--dragging");
    }

    this._rowsHost.style.touchAction = "none";
    try {
      this._rowsHost.setPointerCapture(pointerId);
    } catch (err) {
      void err;
    }

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));

      if (gesture.mode === "pending") {
        if (dist < this._touchMoveThreshold) return;
        gesture.mode = "scroll";
        if (gesture.timer) window.clearTimeout(gesture.timer);
        this._rowsHost.classList.add("vgt__rows--dragging");
      }

      if (gesture.mode === "scroll") {
        moveEvent.preventDefault();
        this._setScrollXPx(startScrollX - dx);
        this._setScrollPx(startScrollY - dy);
        return;
      }

      if (gesture.mode === "select") {
        const nextCell = this._cellFromClientPoint(moveEvent.clientX, moveEvent.clientY);
        if (!nextCell) return;
        moveEvent.preventDefault();
        this._setSelectionRange(startCell, nextCell);
      }
    };

    const onUp = () => {
      if (gesture.timer) window.clearTimeout(gesture.timer);
      if (gesture.mode === "pending" && startCell) {
        this._setSelectionRange(startCell, startCell);
      }
      this._rowsHost.style.touchAction = priorTouchAction;
      this._rowsHost.classList.remove("vgt__rows--dragging", "vgt__rows--selecting");
      this._activePointerGesture = null;
      try {
        this._rowsHost.releasePointerCapture(pointerId);
      } catch (err) {
        void err;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: true });
  }

  _cellFromEvent(event) {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return this._cellFromElement(target);
  }

  _cellFromClientPoint(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    if (!(element instanceof Element)) return null;
    return this._cellFromElement(element);
  }

  _cellFromClientPointClamped(clientX, clientY) {
    const colCount = this._columns.length | 0;
    const rowCount = this._viewCount | 0;
    if (colCount <= 0 || rowCount <= 0) return null;
    const rect = this._rowsHost.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    this._ensureColWidths();
    const clampedX = this._clamp(clientX, rect.left + 1, rect.right - 1);
    const clampedY = this._clamp(clientY, rect.top + 1, rect.bottom - 1);

    const localX = clampedX - rect.left + this._scrollXPx;
    const localY = clampedY - rect.top + this._scrollPx;
    const maxY = Math.max(0, rowCount * this._opts.rowHeight - 1);
    const row = this._clamp(Math.floor(localY / this._opts.rowHeight), 0, rowCount - 1);

    const maxX = Math.max(0, this._totalContentWidth() - 1);
    const x = this._clamp(localX, 0, maxX);
    let col = colCount - 1;
    let cursor = 0;
    for (let i = 0; i < colCount; i += 1) {
      const width = Math.max(this._minColWidth, this._colWidths[i] ?? this._minColWidth);
      if (x < cursor + width) {
        col = i;
        break;
      }
      cursor += width;
    }

    return { row: Math.min(row, Math.floor(maxY / this._opts.rowHeight)), col };
  }

  _cellFromElement(element) {
    const cellEl = element.closest(".vgt__cell");
    if (!cellEl || !this._rowsHost.contains(cellEl)) return null;
    const rowEl = cellEl.closest(".vgt__row");
    if (!rowEl) return null;
    const viewRow = Number(rowEl.dataset.viewRow);
    const colIndex = Number(cellEl.dataset.colIndex);
    if (!Number.isFinite(viewRow) || viewRow < 0 || !Number.isFinite(colIndex) || colIndex < 0) return null;
    return { row: viewRow, col: colIndex };
  }

  _rowFromBumperEvent(event) {
    const target = event.target;
    if (!(target instanceof Element)) return -1;
    return this._rowFromBumperElement(target);
  }

  _rowFromBumperClientPoint(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    if (!(element instanceof Element)) return -1;
    return this._rowFromBumperElement(element);
  }

  _rowFromBumperClientPointClamped(clientY) {
    const rowCount = this._viewCount | 0;
    if (rowCount <= 0) return -1;
    const rect = this._rowBumpers.getBoundingClientRect();
    if (rect.height <= 0) return -1;
    const clampedY = this._clamp(clientY, rect.top + 1, rect.bottom - 1);
    const localY = clampedY - rect.top + this._scrollPx;
    return this._clamp(Math.floor(localY / this._opts.rowHeight), 0, rowCount - 1);
  }

  _rowFromBumperElement(element) {
    const bumperEl = element.closest(".vgt__rowBumper");
    if (!bumperEl || !this._rowBumpers.contains(bumperEl)) return -1;
    const viewRow = Number(bumperEl.dataset.viewRow);
    if (!Number.isFinite(viewRow) || viewRow < 0) return -1;
    return viewRow;
  }

  _selectAllCells() {
    const rowCount = this._viewCount | 0;
    const colCount = this._columns.length | 0;
    if (rowCount <= 0 || colCount <= 0) return;
    this._selectionRange = {
      rowMin: 0,
      rowMax: rowCount - 1,
      colMin: 0,
      colMax: colCount - 1,
    };
    this._root.focus({ preventScroll: true });
    this._syncHeadBumperState();
    this._renderBody();
  }

  _selectRowRange(rowA, rowB) {
    const rowCount = this._viewCount | 0;
    const colCount = this._columns.length | 0;
    if (rowCount <= 0 || colCount <= 0) return;
    const minRow = this._clamp(Math.min(rowA | 0, rowB | 0), 0, rowCount - 1);
    const maxRow = this._clamp(Math.max(rowA | 0, rowB | 0), 0, rowCount - 1);
    this._selectionRange = {
      rowMin: minRow,
      rowMax: maxRow,
      colMin: 0,
      colMax: colCount - 1,
    };
    this._syncHeadBumperState();
    this._renderBody();
  }

  _setSelectionRange(anchorCell, focusCell) {
    const rowA = anchorCell.row | 0;
    const rowB = focusCell.row | 0;
    const colA = anchorCell.col | 0;
    const colB = focusCell.col | 0;
    this._selectionRange = {
      rowMin: Math.min(rowA, rowB),
      rowMax: Math.max(rowA, rowB),
      colMin: Math.min(colA, colB),
      colMax: Math.max(colA, colB),
    };
    this._syncHeadBumperState();
    this._renderBody();
  }

  _clearSelection(rerender = true) {
    if (!this._selectionRange) return;
    this._selectionRange = null;
    this._syncHeadBumperState();
    if (rerender) this._renderBody();
  }

  _hasSelection() {
    return Boolean(this._selectionRange);
  }

  _isCellSelected(viewRow, colIndex) {
    const range = this._selectionRange;
    if (!range) return false;
    return (
      viewRow >= range.rowMin &&
      viewRow <= range.rowMax &&
      colIndex >= range.colMin &&
      colIndex <= range.colMax
    );
  }

  _isRowFullySelected(viewRow) {
    const range = this._selectionRange;
    const lastCol = this._columns.length - 1;
    if (!range || lastCol < 0) return false;
    return viewRow >= range.rowMin && viewRow <= range.rowMax && range.colMin === 0 && range.colMax === lastCol;
  }

  _isAllSelected() {
    const range = this._selectionRange;
    const rowCount = this._viewCount | 0;
    const colCount = this._columns.length | 0;
    if (!range || rowCount <= 0 || colCount <= 0) return false;
    return (
      range.rowMin === 0 &&
      range.rowMax === rowCount - 1 &&
      range.colMin === 0 &&
      range.colMax === colCount - 1
    );
  }

  _syncHeadBumperState() {
    if (!this._headBumper) return;
    this._headBumper.dataset.active = this._isAllSelected() ? "1" : "0";
  }

  _isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    const tag = target.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      Boolean(target.closest("[contenteditable]"))
    );
  }

  _onCopy(event) {
    if (!this._hasSelection()) return;
    const text = this._selectionToTsv();
    if (!text) return;
    event.preventDefault();
    if (event.clipboardData) {
      event.clipboardData.setData("text/plain", text);
    }
  }

  _copySelectionToClipboard() {
    const text = this._selectionToTsv();
    if (!text) return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).catch(() => {
        this._fallbackCopyText(text);
      });
      return;
    }
    this._fallbackCopyText(text);
  }

  _fallbackCopyText(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  _selectionToTsv() {
    if (!this._selectionRange) return "";
    const { rowMin, rowMax, colMin, colMax } = this._selectionRange;
    const out = [];
    for (let viewRow = rowMin; viewRow <= rowMax; viewRow += 1) {
      const baseIndex = this._viewIndexToBase(viewRow);
      if (baseIndex < 0) continue;
      const sourceRow = this._mode === "chunked" ? this._chunkRows.get(baseIndex) : this._rows[baseIndex];
      const row = sourceRow || [];
      const rowOut = [];
      for (let col = colMin; col <= colMax; col += 1) {
        const value = row[col];
        rowOut.push(value == null ? "" : String(value));
      }
      out.push(rowOut.join("\t"));
    }
    return out.join("\n");
  }

  _ensureChunkForViewport(reason) {
    if (this._mode !== "chunked") return;
    if (this._viewCount <= 0) {
      if (this._chunkRows.size === 0) {
        this._requestChunk(0, this._chunkSize, reason ?? "bootstrap");
      }
      return;
    }

    const visibleRows = Math.max(1, Math.ceil(this._bodyH / this._opts.rowHeight));
    const windowRows = visibleRows + this._opts.overscan * 2;
    const from = this._clamp(this._rowStart - this._opts.overscan, 0, Math.max(0, this._viewCount - 1));
    const to = this._clamp(from + windowRows, 0, this._viewCount);

    const startChunk = Math.floor(from / this._chunkSize) * this._chunkSize;
    const endChunk = this._clamp(Math.ceil(Math.max(to, from + 1) / this._chunkSize) * this._chunkSize, 0, this._viewCount);

    for (let chunkStart = startChunk; chunkStart < endChunk; chunkStart += this._chunkSize) {
      const chunkEnd = Math.min(this._viewCount, chunkStart + this._chunkSize);
      this._requestChunk(chunkStart, chunkEnd, reason);
    }

    const nextChunkStart = endChunk;
    if (nextChunkStart < this._viewCount) {
      this._requestChunk(nextChunkStart, Math.min(this._viewCount, nextChunkStart + this._chunkSize), reason);
    }
  }

  _requestChunk(start, endExclusive, reason) {
    if (this._mode !== "chunked") return;
    const maxWindow = this._viewCount > 0 ? this._viewCount : Math.max(this._chunkSize, endExclusive | 0);
    const safeStart = this._clamp(start | 0, 0, maxWindow);
    const safeEnd = this._clamp(endExclusive | 0, 0, maxWindow);
    if (safeEnd <= safeStart) return;
    if (!this._windowHasMissingRows(safeStart, safeEnd)) return;

    const key = safeStart + ":" + safeEnd;
    if (this._chunkPending.has(key)) return;
    this._chunkPending.add(key);
    this._renderStatus();

    const request = {
      id: ++this._chunkSeq,
      start: safeStart,
      endExclusive: safeEnd,
      size: safeEnd - safeStart,
      reason: reason ?? "viewport",
      totalRows: this._chunkTotalRows,
      query: this._searchQuery,
      searchColumn: this._searchColumn,
      hasCustomFilter: Boolean(this._filter),
      sort: this._sort ? { colIndex: this._sort.colIndex, dir: this._sort.dir === -1 ? "desc" : "asc" } : null,
      columnFilters: this._serializeColumnFilters(),
    };

    this._host.dispatchEvent(new CustomEvent("vgt:chunk-request", { detail: request }));
    let callbackResult;
    if (this._onChunkRequest) {
      try {
        callbackResult = this._onChunkRequest(request);
      } catch (err) {
        console.error("VirtualGridTable onChunkRequest failed", err);
      }
    }

    const providerResult = this._fetchChunk ? this._fetchChunk(request) : callbackResult;
    if (providerResult == null) return;
    Promise.resolve(providerResult)
      .then((response) => {
        this._consumeChunkResponse(response, safeStart, key);
      })
      .catch((err) => {
        console.error("VirtualGridTable fetchChunk failed", err);
        this._chunkPending.delete(key);
        this._renderStatus();
      });
  }

  _consumeChunkResponse(response, defaultStart, pendingKey) {
    if (this._mode !== "chunked") return;

    if (Array.isArray(response)) {
      this.setChunkRows(defaultStart, response);
      this._chunkPending.delete(pendingKey);
      this._renderStatus();
      return;
    }

    if (response && typeof response === "object") {
      const start = Number.isFinite(response.start) ? response.start | 0 : defaultStart;
      const rows = Array.isArray(response.rows) ? response.rows : [];
      const totalRows = Number.isFinite(response.totalRows) ? response.totalRows : undefined;
      this.setChunkRows(start, rows, totalRows);
      this._chunkPending.delete(pendingKey);
      this._renderStatus();
      return;
    }

    this._chunkPending.delete(pendingKey);
    this._renderStatus();
  }

  _clearPendingWindowsForRange(start, endExclusive) {
    const lo = start | 0;
    const hi = endExclusive | 0;
    for (const key of Array.from(this._chunkPending)) {
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const chunkLo = parseInt(parts[0], 10) | 0;
      const chunkHi = parseInt(parts[1], 10) | 0;
      if (hi > chunkLo && lo < chunkHi) this._chunkPending.delete(key);
    }
  }

  _windowHasMissingRows(start, endExclusive) {
    for (let i = start; i < endExclusive; i += 1) {
      if (!this._chunkRows.has(i)) return true;
    }
    return false;
  }

  _serializeColumnFilters() {
    const out = [];
    for (const [colIndex, spec] of this._columnFilters.entries()) {
      out.push({ colIndex, op: spec.op, value: spec.value, valueTo: spec.valueTo });
    }
    return out;
  }

  _ratioFromTrackY(trackY) {
    const trackRect = this._track.getBoundingClientRect();
    const thumbRect = this._thumb.getBoundingClientRect();
    const maxTop = Math.max(1, trackRect.height - thumbRect.height);
    const top = this._clamp(trackY - thumbRect.height / 2, 0, maxTop);
    return top / maxTop;
  }

  _ratioFromHTrackX(trackX) {
    const trackRect = this._hTrack.getBoundingClientRect();
    const thumbRect = this._hThumb.getBoundingClientRect();
    const maxLeft = Math.max(1, trackRect.width - thumbRect.width);
    const left = this._clamp(trackX - thumbRect.width / 2, 0, maxLeft);
    return left / maxLeft;
  }

  _toRowArray(row) {
    if (Array.isArray(row)) return row;
    if (!row || typeof row !== "object") return [];
    const out = new Array(this._columns.length);
    for (let i = 0; i < this._columns.length; i += 1) {
      const col = this._columns[i];
      const key = col?.key ?? col?.label ?? i;
      out[i] = row[key];
    }
    return out;
  }

  _createButton(className, text, onClick, ariaLabel) {
    const btn = document.createElement("button");
    btn.className = className;
    btn.type = "button";
    btn.textContent = text;
    if (ariaLabel) btn.setAttribute("aria-label", ariaLabel);
    btn.addEventListener("click", onClick);
    return btn;
  }

  _toCssSize(value) {
    return typeof value === "number" ? value + "px" : String(value);
  }

  _clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  _clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }
}

window.VirtualGridTable = VirtualGridTable;

const grid = new VirtualGridTable("grid", {
  rowHeight: 28,
  visibleCols: 6,
  overscan: 2,
  demo_mode: true,
  demo_rows: 50000,
});

if (grid._opts.demo_mode === "chunked") {
  grid.setLoading(true);
  grid.setChunkMode({
    columns: [
      { key: "id", label: "id" },
      { key: "title", label: "title" },
      { key: "price", label: "price" },
      { key: "category", label: "category" },
      { key: "brand", label: "brand" },
      { key: "rating", label: "rating" },
      { key: "stock", label: "stock" },
    ],
    totalRows: 0,
    chunkSize: 50,
    async fetchChunk(request) {
      const limit = request.size;
      const skip = request.start;
      const url = `https://dummyjson.com/products?limit=${limit}&skip=${skip}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Chunk fetch failed (${response.status}): ${url}`);
      }

      const payload = await response.json();
      return {
        start: payload.skip ?? skip,
        totalRows: payload.total ?? 0,
        rows: (payload.products ?? []).map((item) => [
          item.id,
          item.title,
          item.price,
          item.category,
          item.brand,
          item.rating,
          item.stock,
        ]),
      };
    },
  });
  grid.setLoading(false);
} else if (grid._opts.demo_mode === true) {
  grid.setLoading(true);

  const demo = [];
  for (let i = 0; i < grid._opts.demo_rows; i += 1) {
    demo.push({
      id: i + 1,
      name: "Item " + (i + 1),
      qty: (i % 13) + 1,
      price: ((i % 97) + 1) * 1.25,
      category: ["A", "B", "C", "D"][i % 4],
      note: i % 5 === 0 ? "longer text that should ellipsize nicely" : "",
      ts: Date.now() - i * 1000,
    });
  }

  setTimeout(() => {
    grid.setData(demo);
    grid.setLoading(false);
  }, 250);
}

