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
 * - setCellClass(fn)
 * - setEditable(boolean)
 * - setConditionalFormat(index, formatSpec)
 * - setConditionalFormats(formatSpecs)
 * - clearConditionalFormats(index?)
 * - sortBy(index, "asc" | "desc" | null)
 * - clearSort()
 * - setChunkMode({ columns, totalRows, chunkSize, onChunkRequest?, fetchChunk? })
 * - setChunkRows(startIndex, rows, totalRows?)
    * - setChunkRowCount(totalRows)
    * - clearChunkCache()
    * - getOffsets()
     * - undo()
     * - redo()
    * - destroy()
 *
 * Local editing:
 * - options.editable enables local-cell editing in local mode only
 * - Read/Edit mode controls whether editing is currently active
 * - options.paste enables TSV paste into local cells when editable, default true
 * - options.deleteSelection enables Delete/Backspace clearing when editable, default true
 * - options.onCellsChange(changes) is called after local cell values change
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
    cellClass: null,
    editable: false,
    paste: true,
    deleteSelection: true,
    onCellsChange: null,
    demo_mode: false,
    demo_rows: 10000,
    historyLimit: 20,
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
    this._cellClass = typeof this._opts.cellClass === "function" ? this._opts.cellClass : null;
    this._onCellsChange = typeof this._opts.onCellsChange === "function" ? this._opts.onCellsChange : null;
    this._conditionalFormats = [];
    this._conditionalFormatCols = new Map();
    this._filterMenuCol = -1;

    this._searchCache = [];
    this._searchColCache = [];

    this._scrollPx = 0;
    this._rowStart = 0;
    this._subPx = 0;

    this._scrollXPx = 0;
    this._colWidths = [];
    this._minColWidth = 72;
    this._maxColWidth = 1600;
    this._maxAutoColChars = 100;
    this._autoColWidths = null;
    this._textMeasureCtx = null;

    this._bodyH = 0;
    this._bodyW = 0;
    this._renderRows = 0;
    this._headerResize = null;

    this._loading = false;
    this._selectionRange = null;
    this._activePointerGesture = null;
    this._longPressMs = 320;
    this._touchMoveThreshold = 9;
    this._mobileCopyResetTimer = 0;
    this._pointerSelecting = false;
    this._activeEdit = null;
    this._editMode = false;
    this._undoStack = [];
    this._redoStack = [];
    this._undoHistoryLimit = this._clamp(Number(this._opts.historyLimit) || 20, 1, 2000);

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

  undo() {
    return this._undo();
  }

  redo() {
    return this._redo();
  }

  setData(data) {
    this._commitActiveEdit({ rerender: false });
    const { columns, rows } = this._normalizeData(data);
    this._mode = "local";
    this._columns = columns;
    this._rows = rows.map((row) => this._toRowArray(row));
    this._autoColWidths = this._computeAutoColumnWidthsFromLocalData();
    this._chunkRows.clear();
    this._chunkPending.clear();
    this._chunkTotalRows = rows.length;
    this._ensureColWidths(true);
    this._columnFilters.clear();
    this._conditionalFormats = [];
    this._rebuildConditionalFormatIndex();
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

  setCellClass(cellClassFn) {
    this._cellClass = typeof cellClassFn === "function" ? cellClassFn : null;
    this._renderBody();
  }

  setEditable(isEditable) {
    const nextEditable = Boolean(isEditable);
    if (!nextEditable) {
      this._commitActiveEdit({ rerender: false });
      this._setEditMode(false);
    }
    this._opts.editable = Boolean(isEditable);
    if (this._editModeBtn) {
      this._editModeBtn.disabled = !nextEditable;
      this._refreshEditModeToggle();
    }
    this._renderBody();
  }

  setConditionalFormat(colIndex, formatSpec) {
    const abs = colIndex | 0;
    if (abs < 0 || abs >= this._columns.length) return;

    const next = this._normalizeConditionalFormat(abs, formatSpec);
    this._conditionalFormats = this._conditionalFormats.filter((rule) => rule.colIndex !== abs);
    if (next) this._conditionalFormats.push(next);
    this._rebuildConditionalFormatIndex();

    this._renderHeader();
    this._renderBody();
  }

  setConditionalFormats(formatSpecs) {
    this._conditionalFormats = [];
    const specs = Array.isArray(formatSpecs) ? formatSpecs : [];
    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i];
      if (!spec || typeof spec !== "object") continue;
      const abs = spec.colIndex ?? spec.column ?? spec.index;
      const colIndex = abs | 0;
      if (colIndex < 0 || colIndex >= this._columns.length) continue;
      const next = this._normalizeConditionalFormat(colIndex, spec);
      if (next) this._conditionalFormats.push(next);
    }
    this._rebuildConditionalFormatIndex();
    this._renderHeader();
    this._renderBody();
  }

  clearConditionalFormats(colIndex) {
    if (colIndex == null) {
      if (this._conditionalFormats.length === 0) return;
      this._conditionalFormats = [];
    } else {
      this._conditionalFormats = this._conditionalFormats.filter((rule) => rule.colIndex !== (colIndex | 0));
    }
    this._rebuildConditionalFormatIndex();
    this._renderHeader();
    this._renderBody();
  }

  setChunkMode(config = {}) {
    this._commitActiveEdit({ rerender: false });
    const next = config && typeof config === "object" ? config : {};
    if (typeof next.chunkSize === "number" && Number.isFinite(next.chunkSize)) {
      this._chunkSize = this._clamp(Math.floor(next.chunkSize), 25, 5000);
    }
    if (typeof next.onChunkRequest === "function") this._onChunkRequest = next.onChunkRequest;
    if (typeof next.fetchChunk === "function") this._fetchChunk = next.fetchChunk;

    if (Array.isArray(next.columns)) {
      this._columns = this._normalizeData({ columns: next.columns, rows: [] }).columns;
      this._autoColWidths = null;
      this._ensureColWidths(true);
    }

    this._mode = "chunked";
    this._rows = [];
    this._autoColWidths = null;
    this._chunkRows.clear();
    this._chunkPending.clear();
    this._columnFilters.clear();
    this._conditionalFormats = [];
    this._rebuildConditionalFormatIndex();
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
    this._commitActiveEdit({ rerender: false });
    this._ro?.disconnect();
    this._cancelActivePointerGesture();
    this._closeFilterMenu();
    this._closeContextMenu();
    this._closeThemeMenu();
    if (this._mobileCopyResetTimer) {
      window.clearTimeout(this._mobileCopyResetTimer);
      this._mobileCopyResetTimer = 0;
    }
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
    this._undoStack.length = 0;
    this._redoStack.length = 0;
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

    const sUp = this._createButton(
      "vgt__sbtn vgt__triBtn vgt__triBtn--up",
      "",
      () => this._scrollBy(-this._bodyH * 0.9),
      "Scroll up"
    );
    const sDown = this._createButton(
      "vgt__sbtn vgt__triBtn vgt__triBtn--down",
      "",
      () => this._scrollBy(this._bodyH * 0.9),
      "Scroll down"
    );
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

    const copyFabGroup = document.createElement("div");
    copyFabGroup.className = "vgt__copyFabGroup";
    copyFabGroup.dataset.show = "0";

    const copyFab = document.createElement("button");
    copyFab.className = "vgt__copyFab";
    copyFab.type = "button";
    copyFab.dataset.copied = "0";
    copyFab.textContent = "Copy";
    copyFab.setAttribute("aria-label", "Copy selected cells");
    copyFab.addEventListener("click", (event) => {
      event.preventDefault();
      this._copySelectionToClipboard(false);
      this._flashMobileCopyButton(copyFab);
    });
    this._copyFab = copyFab;

    const copyFabWithHeaders = document.createElement("button");
    copyFabWithHeaders.className = "vgt__copyFab vgt__copyFab--headers";
    copyFabWithHeaders.type = "button";
    copyFabWithHeaders.dataset.copied = "0";
    copyFabWithHeaders.textContent = "Copy with headers";
    copyFabWithHeaders.setAttribute("aria-label", "Copy selected cells with headers");
    copyFabWithHeaders.addEventListener("click", (event) => {
      event.preventDefault();
      this._copySelectionToClipboard(true);
      this._flashMobileCopyButton(copyFabWithHeaders);
    });
    this._copyFabWithHeaders = copyFabWithHeaders;
    copyFabGroup.append(copyFab, copyFabWithHeaders);
    this._copyFabGroup = copyFabGroup;

    mid.append(rowBumpers, rowsHost, scroll, hscroll, corner, overlay, copyFabGroup);

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

    const editModeBtn = this._createButton("vgt__pill vgt__editModeToggle", "Edit", () => {
      this._toggleEditMode();
    });
    editModeBtn.disabled = !this._opts.editable;
    this._editModeBtn = editModeBtn;
    this._refreshEditModeToggle();

    const themeControl = document.createElement("div");
    themeControl.className = "vgt__themeControl";

    const themeBtn = document.createElement("button");
    themeBtn.className = "vgt__pill vgt__themeToggle";
    themeBtn.type = "button";
    themeBtn.title = "Theme";
    themeBtn.setAttribute("aria-label", "Theme options");
    themeBtn.setAttribute("aria-expanded", "false");
    themeBtn.append(this._paintPaletteIcon());
    this._themeToggle = themeBtn;

    const themeMenu = document.createElement("div");
    themeMenu.className = "vgt__themeMenu";
    themeMenu.dataset.open = "0";
    this._themeMenu = themeMenu;
    this._themeMenuItems = [];

    const currentThemeItem = this._createButton("vgt__themeMenuItem vgt__themeMenuItem--current", "Current", () => {
      this._applyTheme(this._readThemeMode());
      this._closeThemeMenu();
    });
    currentThemeItem.dataset.theme = "current";
    currentThemeItem.disabled = true;
    this._currentThemeMenuItem = currentThemeItem;
    themeMenu.append(currentThemeItem);

    for (let i = 0; i < VGT_THEME_OPTIONS.length; i += 1) {
      const option = VGT_THEME_OPTIONS[i];
      const item = this._createButton("vgt__themeMenuItem", option.label, () => {
        this._applyTheme(option.value);
        this._closeThemeMenu();
      });
      item.dataset.theme = option.value;
      this._themeMenuItems.push(item);
      themeMenu.append(item);
    }

    themeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      this._toggleThemeMenu();
    });
    themeControl.append(themeBtn, themeMenu);
    this._refreshThemeMenuState();

    searchWrap.append(searchSel, searchInp, clearBtn, editModeBtn, themeControl);

    const pager = document.createElement("div");
    pager.className = "vgt__pager";

    const pUp = this._createButton(
      "vgt__pill vgt__navBtn vgt__triBtn vgt__triBtn--up",
      "",
      () => this._scrollBy(-this._bodyH),
      "Page up"
    );
    const pDown = this._createButton(
      "vgt__pill vgt__navBtn vgt__triBtn vgt__triBtn--down",
      "",
      () => this._scrollBy(this._bodyH),
      "Page down"
    );
    const pLeft = this._createButton(
      "vgt__pill vgt__navBtn vgt__triBtn vgt__triBtn--left",
      "",
      () => this._scrollXBy(-this._bodyW * 0.9),
      "Scroll left"
    );
    const pRight = this._createButton(
      "vgt__pill vgt__navBtn vgt__triBtn vgt__triBtn--right",
      "",
      () => this._scrollXBy(this._bodyW * 0.9),
      "Scroll right"
    );
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

    const filterLabel = document.createElement("div");
    filterLabel.className = "vgt__filterSection";
    filterLabel.textContent = "Filter";
    filterMenu.append(filterLabel);

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

    const divider = document.createElement("div");
    divider.className = "vgt__filterDivider";
    filterMenu.append(divider);

    const sortLabel = document.createElement("div");
    sortLabel.className = "vgt__filterSection";
    sortLabel.textContent = "Sort";
    filterMenu.append(sortLabel);

    const filterSortBtn = this._createButton("vgt__pill vgt__filterSortBtn", "", () => {
      const current = this._filterSortBtn?.dataset.state || "none";
      this._setFilterSortState(this._nextSortState(current));
    });
    filterSortBtn.dataset.state = "none";
    this._filterSortBtn = filterSortBtn;
    this._setFilterSortState("none");
    filterMenu.append(filterSortBtn);

    const filterActions = document.createElement("div");
    filterActions.className = "vgt__filterActions";
    const applyFilterBtn = this._createButton("vgt__pill vgt__filterApply", "Apply", () => this._applyFilterMenu());
    const clearFilterBtn = this._createButton("vgt__pill vgt__filterClear", "Clear", () => {
      if (this._filterMenuCol < 0) return;
      const absCol = this._filterMenuCol | 0;
      this.setColumnFilter(absCol, null);
      if (this._sort && this._sort.colIndex === absCol) this.clearSort();
    });
    filterActions.append(applyFilterBtn, clearFilterBtn);
    filterMenu.append(filterActions);

    const formatDivider = document.createElement("div");
    formatDivider.className = "vgt__filterDivider";
    filterMenu.append(formatDivider);

    const formatLabel = document.createElement("div");
    formatLabel.className = "vgt__filterSection";
    formatLabel.textContent = "Format";
    filterMenu.append(formatLabel);

    const formatOp = document.createElement("select");
    formatOp.className = "vgt__filterOp vgt__formatOp";
    for (let i = 0; i < filterOps.length; i += 1) {
      const option = document.createElement("option");
      option.value = filterOps[i];
      option.textContent = filterOps[i];
      formatOp.append(option);
    }
    formatOp.addEventListener("change", () => this._syncFilterMenuInputs());
    filterMenu.append(formatOp);
    this._formatOp = formatOp;

    const formatValueA = document.createElement("input");
    formatValueA.className = "vgt__filterInput vgt__formatInput";
    formatValueA.type = "text";
    formatValueA.placeholder = "Value";
    formatValueA.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this._applyFormatMenu();
      }
    });
    filterMenu.append(formatValueA);
    this._formatValueA = formatValueA;

    const formatValueB = document.createElement("input");
    formatValueB.className = "vgt__filterInput vgt__formatInput";
    formatValueB.type = "text";
    formatValueB.placeholder = "And";
    formatValueB.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this._applyFormatMenu();
      }
    });
    filterMenu.append(formatValueB);
    this._formatValueB = formatValueB;

    const formatColors = document.createElement("div");
    formatColors.className = "vgt__formatColors";

    const formatBgLabel = document.createElement("label");
    formatBgLabel.className = "vgt__formatColorField";
    formatBgLabel.textContent = "Background";
    const formatBg = document.createElement("input");
    formatBg.className = "vgt__formatColorInput";
    formatBg.type = "color";
    formatBg.value = defaultConditionalFormatColors(this._readThemeMode()).backgroundColor;
    formatBgLabel.append(formatBg);
    this._formatBg = formatBg;

    const formatTextLabel = document.createElement("label");
    formatTextLabel.className = "vgt__formatColorField";
    formatTextLabel.textContent = "Text";
    const formatText = document.createElement("input");
    formatText.className = "vgt__formatColorInput";
    formatText.type = "color";
    formatText.value = defaultConditionalFormatColors(this._readThemeMode()).color;
    formatTextLabel.append(formatText);
    this._formatText = formatText;

    formatColors.append(formatBgLabel, formatTextLabel);
    filterMenu.append(formatColors);

    const formatActions = document.createElement("div");
    formatActions.className = "vgt__filterActions";
    const applyFormatBtn = this._createButton("vgt__pill vgt__formatApply", "Apply format", () => this._applyFormatMenu());
    const clearFormatBtn = this._createButton("vgt__pill vgt__formatClear", "Clear format", () => {
      if (this._filterMenuCol < 0) return;
      this.clearConditionalFormats(this._filterMenuCol);
      this._closeFilterMenu();
    });
    formatActions.append(applyFormatBtn, clearFormatBtn);
    filterMenu.append(formatActions);

    const contextMenu = document.createElement("div");
    contextMenu.className = "vgt__ctxMenu";
    contextMenu.dataset.open = "0";

    const copyMenuBtn = document.createElement("button");
    copyMenuBtn.className = "vgt__ctxMenuItem";
    copyMenuBtn.type = "button";
    copyMenuBtn.textContent = "Copy";
    copyMenuBtn.addEventListener("click", (event) => {
      event.preventDefault();
      this._copySelectionToClipboard(false);
      this._closeContextMenu();
    });

    const copyMenuHeadersBtn = document.createElement("button");
    copyMenuHeadersBtn.className = "vgt__ctxMenuItem";
    copyMenuHeadersBtn.type = "button";
    copyMenuHeadersBtn.textContent = "Copy with headers";
    copyMenuHeadersBtn.addEventListener("click", (event) => {
      event.preventDefault();
      this._copySelectionToClipboard(true);
      this._closeContextMenu();
    });

    contextMenu.append(copyMenuBtn, copyMenuHeadersBtn);
    this._contextMenu = contextMenu;

    toolbar.append(searchWrap);
    top.append(toolbar, head);
    footer.append(footerSpacer, pager, status);
    root.append(top, mid, footer, filterMenu, contextMenu);

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
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const lowered = k.toLowerCase();
        if (lowered === "c") {
          if (this._hasSelection() && !this._isEditableTarget(event.target)) {
            event.preventDefault();
            this._copySelectionToClipboard();
          }
          return;
        }

        if (lowered === "z") {
          if (!this._isEditableTarget(event.target)) {
            event.preventDefault();
            if (event.shiftKey) {
              this._redo();
            } else {
              this._undo();
            }
          }
          return;
        }

        if (lowered === "y") {
          if (!this._isEditableTarget(event.target)) {
            event.preventDefault();
            this._redo();
          }
          return;
        }
      }

      const isEnter = k === "Enter" || k === "NumpadEnter";
      const isTab = k === "Tab";

      if (this._activeEdit && (isEnter || isTab)) {
        event.preventDefault();
        this._commitActiveEdit({ rerender: false, preserveSelection: true });
        this._moveSelectionByNavigationKey(isEnter ? "Enter" : "Tab", event.shiftKey);
        this._focusRootNextTick();
        event.stopImmediatePropagation();
        return;
      }

      if (this._isEditableTarget(event.target)) return;

      if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        const printable = k.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
        if (printable) {
          const cell = this._selectionAnchorCell();
          if (cell) {
            event.preventDefault();
            this._beginCellEdit(cell, k, { selectionRange: this._selectionRange });
          }
          return;
        }
      }

      if (isEnter || isTab) {
        this._moveSelectionByNavigationKey(isEnter ? "Enter" : "Tab", event.shiftKey);
        event.preventDefault();
        this._focusRootNextTick();
        return;
      }

      if (this._canEditCells() && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if ((k === "Delete" || k === "Backspace") && this._opts.deleteSelection !== false && this._hasSelection()) {
          event.preventDefault();
          this._clearSelectedLocalCells();
          return;
        }
      }

      if (this._hasSelection() && this._moveSelectionByArrows(k)) {
        event.preventDefault();
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
        if (this._contextMenu?.dataset.open === "1") {
          event.preventDefault();
          this._closeContextMenu();
        }
        if (this._themeMenu?.dataset.open === "1") {
          event.preventDefault();
          this._closeThemeMenu();
        }
      }
    }, true);

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
    this._rowsHost.addEventListener("dblclick", (event) => this._rowsDoubleClick(event));
    this._rowBumpers.addEventListener("pointerdown", (event) => this._rowBumperPointerStart(event));
    this._root.addEventListener("copy", (event) => this._onCopy(event));
    this._root.addEventListener("paste", (event) => this._onPaste(event));
    this._root.addEventListener("contextmenu", (event) => this._onContextMenu(event));
    this._boundWindowPointerDown = (event) => this._windowPointerDown(event);
    window.addEventListener("pointerdown", this._boundWindowPointerDown, true);
    this._boundWindowResize = () => {
      this._closeFilterMenu();
      this._closeContextMenu();
      this._closeThemeMenu();
    };
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

  _normalizeConditionalFormat(colIndex, formatSpec) {
    const condition = this._normalizeColumnFilter(formatSpec);
    if (!condition) return null;

    const backgroundColor = this._normalizeCssColor(
      formatSpec.backgroundColor ?? formatSpec.bgColor ?? formatSpec.background
    );
    const color = this._normalizeCssColor(formatSpec.color ?? formatSpec.textColor ?? formatSpec.foregroundColor);
    if (!backgroundColor && !color) return null;

    return {
      colIndex,
      ...condition,
      backgroundColor,
      color,
    };
  }

  _rebuildConditionalFormatIndex() {
    this._conditionalFormatCols = new Map();
    for (let i = 0; i < this._conditionalFormats.length; i += 1) {
      const rule = this._conditionalFormats[i];
      const list = this._conditionalFormatCols.get(rule.colIndex);
      if (list) {
        list.push(rule);
      } else {
        this._conditionalFormatCols.set(rule.colIndex, [rule]);
      }
    }
  }

  _hasConditionalFormat(colIndex) {
    return this._conditionalFormatCols.has(colIndex | 0);
  }

  _firstConditionalFormatForColumn(colIndex) {
    const list = this._conditionalFormatCols.get(colIndex | 0);
    return list?.[0] ?? null;
  }

  _matchingConditionalFormat(colIndex, value) {
    const list = this._conditionalFormatCols.get(colIndex | 0);
    if (!list) return null;
    for (let i = 0; i < list.length; i += 1) {
      if (this._matchesColumnFilter(value, list[i])) return list[i];
    }
    return null;
  }

  _normalizeCssColor(value) {
    if (value == null) return "";
    const color = String(value).trim();
    if (!color) return "";
    if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)) return color;
    return "";
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
        const auto = this._autoColWidths && Number.isFinite(this._autoColWidths[i]) ? this._autoColWidths[i] : null;
        const width = Number.isFinite(incoming)
          ? incoming
          : Number.isFinite(prior)
            ? prior
            : Number.isFinite(auto)
              ? auto
              : defaultWidth;
        next[i] = this._clamp(Math.floor(width), this._minColWidth, this._maxColWidth);
      }
      this._colWidths = next;
    }
  }

  _computeAutoColumnWidthsFromLocalData() {
    const colCount = this._columns.length | 0;
    if (colCount <= 0 || !Array.isArray(this._rows)) return null;

    const maxChars = this._maxAutoColChars | 0;
    const maxTexts = new Array(colCount);
    const maxLens = new Array(colCount);
    for (let col = 0; col < colCount; col += 1) {
      const label = this._columns[col]?.label ?? this._columns[col]?.key ?? "";
      const capped = this._capAutoWidthText(label, maxChars);
      maxTexts[col] = capped;
      maxLens[col] = capped.length;
    }

    for (let rowIndex = 0; rowIndex < this._rows.length; rowIndex += 1) {
      const row = this._rows[rowIndex] || [];
      for (let col = 0; col < colCount; col += 1) {
        const value = row[col];
        if (value == null) continue;
        const capped = this._capAutoWidthText(value, maxChars);
        if (capped.length > maxLens[col]) {
          maxLens[col] = capped.length;
          maxTexts[col] = capped;
        }
      }
    }

    const widths = new Array(colCount);
    const maxPx = this._measureTextWidth("W".repeat(Math.max(1, maxChars))) + this._cellChromeWidthPx();
    for (let col = 0; col < colCount; col += 1) {
      const label = this._columns[col]?.label ?? this._columns[col]?.key ?? "";
      const labelPx = this._measureTextWidth(label) + this._headerChromeWidthPx();
      const contentPx = this._measureTextWidth(maxTexts[col] ?? "") + this._cellChromeWidthPx();
      const width = Math.max(labelPx, contentPx);
      widths[col] = this._clamp(Math.ceil(width), this._minColWidth, Math.min(this._maxColWidth, Math.ceil(maxPx)));
    }
    return widths;
  }

  _capAutoWidthText(value, maxChars) {
    const text = value == null ? "" : String(value);
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars);
  }

  _measureTextWidth(value) {
    if (!this._textMeasureCtx) {
      const canvas = document.createElement("canvas");
      this._textMeasureCtx = canvas.getContext("2d");
    }
    const ctx = this._textMeasureCtx;
    if (!ctx) return String(value ?? "").length * 8;
    if (this._root && window.getComputedStyle) {
      const cs = window.getComputedStyle(this._root);
      const fontWeight = cs.fontWeight || "400";
      const fontSize = cs.fontSize || "13px";
      const fontFamily = cs.fontFamily || "sans-serif";
      ctx.font = `${fontWeight} ${fontSize} ${fontFamily}`;
    }
    return ctx.measureText(String(value ?? "")).width;
  }

  _cellChromeWidthPx() {
    const padVar =
      this._root && window.getComputedStyle ? window.getComputedStyle(this._root).getPropertyValue("--vgt-pad-x") : "";
    const pad = Number.parseFloat(padVar || "") || 8;
    return pad * 2 + 6;
  }

  _headerChromeWidthPx() {
    return this._cellChromeWidthPx() + 34;
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
    this._syncMobileCopyButton();
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
        hc.addEventListener("pointerdown", (event) => {
          if (event.target instanceof Element && event.target.closest(".vgt__resizeHandle")) return;
          if (event.target instanceof Element && event.target.closest(".vgt__filterBtn")) return;
          this._headerPointerStart(event, hc);
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
      headerCell.classList.toggle("vgt__hcell--selected", this._isColumnFullySelected(abs));

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
        sortEl.className = this._sort.dir === 1 ? "vgt__sort vgt__sort--asc" : "vgt__sort vgt__sort--desc";
        controls.append(sortEl);
      }

      const filterBtn = document.createElement("button");
      filterBtn.className = "vgt__filterBtn vgt__triBtn vgt__triBtn--down";
      filterBtn.type = "button";
      filterBtn.title = "Column filter, sort, and format";
      filterBtn.dataset.active = this._columnFilters.has(abs) || this._hasConditionalFormat(abs) ? "1" : "0";
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
    if (
      !col ||
      !this._filterMenu ||
      !this._filterOp ||
      !this._filterValueA ||
      !this._filterValueB ||
      !this._filterSortBtn ||
      !this._formatOp ||
      !this._formatValueA ||
      !this._formatValueB ||
      !this._formatBg ||
      !this._formatText
    ) {
      return;
    }

    this._filterMenuCol = absCol;
    const existing = this._columnFilters.get(absCol);
    const existingFormat = this._firstConditionalFormatForColumn(absCol);
    this._filterTitle.textContent = "Column: " + String(col.label ?? col.key ?? "Column " + (absCol + 1));
    this._filterOp.value = existing?.op ?? "like";
    this._filterValueA.value = existing?.value ?? "";
    this._filterValueB.value = existing?.valueTo ?? "";
    this._setFilterSortState(this._sort && this._sort.colIndex === absCol ? (this._sort.dir === 1 ? "asc" : "desc") : "none");
    this._formatOp.value = existingFormat?.op ?? "like";
    this._formatValueA.value = existingFormat?.value ?? "";
    this._formatValueB.value = existingFormat?.valueTo ?? "";
    const formatDefaults = defaultConditionalFormatColors(this._readThemeMode());
    this._formatBg.value = existingFormat?.backgroundColor || formatDefaults.backgroundColor;
    this._formatText.value = existingFormat?.color || formatDefaults.color;
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
    if (this._formatOp && this._formatValueB) {
      const isFormatBetween = this._formatOp.value === "between";
      this._formatValueB.style.display = isFormatBetween ? "block" : "none";
      this._formatValueB.disabled = !isFormatBetween;
    }
  }

  _applyTheme(themeMode) {
    const nextTheme = normalizeThemeMode(themeMode);
    if (typeof window.setAppTheme === "function") {
      window.setAppTheme(nextTheme);
    } else {
      document.documentElement.setAttribute("data-theme", nextTheme);
    }
    this._refreshThemeMenuState();
  }

  _readThemeMode() {
    return normalizeThemeMode(document.documentElement.getAttribute("data-theme"));
  }

  _refreshThemeMenuState() {
    if (!this._themeMenuItems?.length || !this._themeMenu) return;

    const currentTheme = this._readThemeMode();
    if (this._currentThemeMenuItem) {
      const label = this._themeLabel(currentTheme);
      this._currentThemeMenuItem.textContent = `Current (${label})`;
    }

    for (let i = 0; i < this._themeMenuItems.length; i += 1) {
      const item = this._themeMenuItems[i];
      const isActive = item.dataset.theme === currentTheme;
      item.dataset.active = isActive ? "1" : "0";
    }
  }

  _themeLabel(themeMode) {
    const mode = normalizeThemeMode(themeMode);
    for (let i = 0; i < VGT_THEME_OPTIONS.length; i += 1) {
      if (VGT_THEME_OPTIONS[i].value === mode) return VGT_THEME_OPTIONS[i].label;
    }
    return mode;
  }

  _openThemeMenu() {
    if (!this._themeMenu) return;
    this._closeContextMenu();
    this._closeFilterMenu();
    this._refreshThemeMenuState();
    this._themeMenu.dataset.open = "1";
    if (this._themeToggle) this._themeToggle.setAttribute("aria-expanded", "true");
  }

  _closeThemeMenu() {
    if (!this._themeMenu) return;
    this._themeMenu.dataset.open = "0";
    if (this._themeToggle) this._themeToggle.setAttribute("aria-expanded", "false");
  }

  _toggleThemeMenu() {
    const isOpen = this._themeMenu?.dataset.open === "1";
    if (isOpen) {
      this._closeThemeMenu();
    } else {
      this._openThemeMenu();
    }
  }

  _paintPaletteIcon() {
    const iconWrap = document.createElement("span");
    iconWrap.className = "vgt__themeIcon";
    iconWrap.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M19 9.8a8 8 0 1 1-8-8c.7 0 1.4.1 2 .2a8 8 0 0 1 6 7.8 8 8 0 0 1-1 0Z" />
        <circle cx="14.5" cy="11.5" r="1.2" />
        <circle cx="10" cy="9" r="1.2" />
        <circle cx="7" cy="12.5" r="1.2" />
        <circle cx="10" cy="15.5" r="1.2" />
        <circle cx="13.8" cy="14.2" r="1.2" />
      </svg>
    `;
    return iconWrap;
  }

  _applyFilterMenu() {
    if (this._filterMenuCol < 0 || !this._filterOp || !this._filterValueA || !this._filterValueB || !this._filterSortBtn) return;
    const absCol = this._filterMenuCol | 0;
    const sortDir = this._filterSortBtn.dataset.state || "none";
    this.setColumnFilter(absCol, {
      op: this._filterOp.value,
      value: this._filterValueA.value,
      valueTo: this._filterOp.value === "between" ? this._filterValueB.value : "",
    });
    if (sortDir === "asc" || sortDir === "desc") {
      this.sortBy(absCol, sortDir);
    } else if (this._sort && this._sort.colIndex === absCol) {
      this.clearSort();
    }
  }

  _applyFormatMenu() {
    if (this._filterMenuCol < 0 || !this._formatOp || !this._formatValueA || !this._formatValueB || !this._formatBg || !this._formatText) return;
    const absCol = this._filterMenuCol | 0;
    this.setConditionalFormat(absCol, {
      op: this._formatOp.value,
      value: this._formatValueA.value,
      valueTo: this._formatOp.value === "between" ? this._formatValueB.value : "",
      backgroundColor: this._formatBg.value,
      color: this._formatText.value,
    });
    this._closeFilterMenu();
  }

  _nextSortState(state) {
    if (state === "none") return "asc";
    if (state === "asc") return "desc";
    return "none";
  }

  _setFilterSortState(state) {
    if (!this._filterSortBtn) return;
    const safeState = state === "asc" || state === "desc" ? state : "none";
    this._filterSortBtn.dataset.state = safeState;
    this._filterSortBtn.textContent =
      safeState === "asc" ? "Sort: ascending" : safeState === "desc" ? "Sort: descending" : "Sort: none";
  }

  _onContextMenu(event) {
    if (this._isCoarsePointer()) return;
    if (!this._hasSelection()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!this._isContextMenuSelectionTarget(target)) return;
    event.preventDefault();
    this._openContextMenu(event.clientX, event.clientY);
  }

  _isContextMenuSelectionTarget(target) {
    return Boolean(
      target.closest(".vgt__cell") ||
      target.closest(".vgt__rowBumper") ||
      target.closest(".vgt__hcell") ||
      target.closest(".vgt__headBumper")
    );
  }

  _openContextMenu(clientX, clientY) {
    if (!this._contextMenu) return;
    const rootRect = this._root.getBoundingClientRect();
    const menu = this._contextMenu;
    menu.dataset.open = "1";
    menu.style.visibility = "hidden";
    menu.style.left = "0px";
    menu.style.top = "0px";
    const menuRect = menu.getBoundingClientRect();
    const x = this._clamp(clientX - rootRect.left, 6, Math.max(6, rootRect.width - menuRect.width - 6));
    const y = this._clamp(clientY - rootRect.top, 6, Math.max(6, rootRect.height - menuRect.height - 6));
    menu.style.left = `${Math.floor(x)}px`;
    menu.style.top = `${Math.floor(y)}px`;
    menu.style.visibility = "";
  }

  _closeContextMenu() {
    if (!this._contextMenu) return;
    this._contextMenu.dataset.open = "0";
    this._contextMenu.style.left = "";
    this._contextMenu.style.top = "";
    this._contextMenu.style.visibility = "";
  }

  _windowPointerDown(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (this._contextMenu?.dataset.open === "1") {
      if (!target.closest(".vgt__ctxMenu")) this._closeContextMenu();
    }
    if (this._themeMenu?.dataset.open === "1") {
      if (!target.closest(".vgt__themeMenu") && !target.closest(".vgt__themeToggle")) {
        this._closeThemeMenu();
      }
    }
    if (this._filterMenuCol >= 0) {
      if (!target.closest(".vgt__filterMenu") && !target.closest(".vgt__filterBtn")) {
        this._closeFilterMenu();
      }
    }
    if (
      this._hasSelection() &&
      !this._shouldRetainSelectionOnPointerDown(target)
    ) {
      this._clearSelection();
    }
  }

  _shouldRetainSelectionOnPointerDown(target) {
    if (!(target instanceof Element) || !this._root?.contains(target)) return false;
    return Boolean(
      target.closest(".vgt__cell") ||
      target.closest(".vgt__rowBumper") ||
      target.closest(".vgt__hcell") ||
      target.closest(".vgt__headBumper") ||
      target.closest(".vgt__copyFabGroup") ||
      target.closest(".vgt__ctxMenu") ||
      target.closest(".vgt__scroll") ||
      target.closest(".vgt__hscroll") ||
      target.closest(".vgt__navBtn") ||
      target.closest(".vgt__corner")
    );
  }

  _renderBody() {
    if (this._activeEdit) this._commitActiveEdit({ rerender: false });
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
        this._applyCellFormatting(cellEl, value, row, viewIndex, baseIndex, c);
        if (this._isCellSelected(viewIndex, c)) cellEl.classList.add("vgt__cell--selected");
      }
    }

    if (this._mode === "chunked") {
      const reason = this._nextChunkReason ?? "viewport";
      this._nextChunkReason = null;
      this._ensureChunkForViewport(reason);
    }
  }

  _applyCellFormatting(cellEl, value, row, viewIndex, baseIndex, colIndex) {
    cellEl.className = "vgt__cell";
    cellEl.removeAttribute("data-format-bg");
    cellEl.removeAttribute("data-format-color");
    cellEl.style.removeProperty("--vgt-cell-bg");
    cellEl.style.removeProperty("--vgt-cell-color");
    if (!row) return;

    const format = this._matchingConditionalFormat(colIndex, value);
    if (format) {
      if (format.backgroundColor) {
        cellEl.dataset.formatBg = "1";
        cellEl.style.setProperty("--vgt-cell-bg", format.backgroundColor);
      }
      if (format.color) {
        cellEl.dataset.formatColor = "1";
        cellEl.style.setProperty("--vgt-cell-color", format.color);
      }
    }

    if (this._cellClass) {
      this._addCellClasses(
        cellEl,
        this._cellClass(value, row, {
          viewRow: viewIndex,
          baseIndex,
          colIndex,
          column: this._columns[colIndex],
        })
      );
    }
  }

  _addCellClasses(cellEl, classValue) {
    if (!classValue) return;
    const classes = Array.isArray(classValue) ? classValue : String(classValue).split(/\s+/);
    for (let i = 0; i < classes.length; i += 1) {
      const className = String(classes[i] ?? "").trim();
      if (className) cellEl.classList.add(className);
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
      const nextWidth = this._clamp(
        Math.floor(startWidth + (moveEvent.clientX - startX)),
        this._minColWidth,
        this._maxColWidth
      );
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
    if (event.detail > 1) return;
    if (this._activeEdit && this._activeEdit.input?.contains(event.target)) return;
    if (this._activeEdit) this._commitActiveEdit({ rerender: true });
    if (this._activePointerGesture) this._cancelActivePointerGesture();
    const startCell = this._cellFromEvent(event);
    if (this._isTouchDragEvent(event)) {
      event.preventDefault();
      this._startTouchGesture(event, startCell);
      return;
    }
    if (!startCell) {
      this._clearSelection();
      return;
    }
    event.preventDefault();
    this._startSelectionDrag(event, startCell);
  }

  _rowsDoubleClick(event) {
    if (!this._canEditCells()) return;
    const cell = this._cellFromEvent(event);
    if (!cell) return;
    event.preventDefault();
    this._beginCellEdit(cell);
  }

  _headerPointerStart(event, headerCell) {
    if (event.button !== 0 && event.button !== -1) return;
    const startCol = parseInt(headerCell?.dataset.abs || "-1", 10) | 0;
    if (startCol < 0 || startCol >= this._columns.length) {
      this._clearSelection();
      return;
    }

    event.preventDefault();
    this._activePointerGesture = null;
    this._pointerSelecting = true;
    this._selectColumnRange(startCol, startCol);
    this._root.focus({ preventScroll: true });

    const state = {
      active: true,
      lastClientX: event.clientX,
      vScrollX: 0,
      rafId: 0,
    };

    const edgeThreshold = 30;
    const maxEdgeScrollPerFrame = 22;

    const updateFromPointer = (shouldScheduleRaf) => {
      const rect = this._rowsHost.getBoundingClientRect();
      state.vScrollX = this._edgeVelocityX(
        rect,
        state.lastClientX,
        edgeThreshold,
        maxEdgeScrollPerFrame
      );

      const nextCol = this._colFromHeaderClientPointClamped(state.lastClientX);
      if (nextCol >= 0) this._selectColumnRange(startCol, nextCol);

      if (shouldScheduleRaf && state.rafId === 0 && state.vScrollX !== 0) {
        state.rafId = window.requestAnimationFrame(onFrame);
      }
    };

    const onFrame = () => {
      state.rafId = 0;
      if (!state.active) return;
      if (state.vScrollX !== 0) this._setScrollXPx(this._scrollXPx + state.vScrollX);
      updateFromPointer(true);
    };

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      state.lastClientX = moveEvent.clientX;
      updateFromPointer(true);
    };

    const onUp = () => {
      state.active = false;
      this._pointerSelecting = false;
      if (state.rafId) window.cancelAnimationFrame(state.rafId);
      try {
        this._head.releasePointerCapture(event.pointerId);
      } catch (err) {
        void err;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      this._syncMobileCopyButton();
    };

    try {
      this._head.setPointerCapture(event.pointerId);
    } catch (err) {
      void err;
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: true });
    window.addEventListener("pointercancel", onUp, { passive: true });
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
    this._pointerSelecting = true;
    this._selectRowRange(startRow, startRow);
    this._root.focus({ preventScroll: true });
    this._rowBumpers.classList.add("vgt__rows--selecting");
    this._syncMobileCopyButton();
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
      state.vScroll = this._edgeVelocityY(
        rect,
        state.lastClientY,
        edgeThreshold,
        maxEdgeScrollPerFrame
      );

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
      this._pointerSelecting = false;
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
      this._syncMobileCopyButton();
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
    const gesture = this._activePointerGesture;
    this._activePointerGesture = null;
    if (typeof gesture.cleanup === "function") {
      gesture.cleanup();
      return;
    }
    if (Object.prototype.hasOwnProperty.call(gesture, "priorTouchAction")) {
      this._rowsHost.style.touchAction = gesture.priorTouchAction;
    }
    if (gesture.timer) {
      window.clearTimeout(gesture.timer);
    }
    if (gesture.rafId) window.cancelAnimationFrame(gesture.rafId);
    this._rowsHost.classList.remove("vgt__rows--dragging", "vgt__rows--selecting");
    this._pointerSelecting = false;
  }

  _startSelectionDrag(event, startCell) {
    this._activePointerGesture = null;
    this._pointerSelecting = true;
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
      state.vScrollX = this._edgeVelocityX(
        rect,
        state.lastClientX,
        edgeThreshold,
        maxEdgeScrollPerFrame
      );
      state.vScrollY = this._edgeVelocityY(
        rect,
        state.lastClientY,
        edgeThreshold,
        maxEdgeScrollPerFrame
      );

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
      this._pointerSelecting = false;
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
      this._syncMobileCopyButton();
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
      cleanup: null,
      rafId: 0,
    };
    this._activePointerGesture = gesture;

    const state = {
      active: true,
      lastClientX: startX,
      lastClientY: startY,
      vScrollX: 0,
      vScrollY: 0,
      rafId: 0,
    };

    const edgeThreshold = 30;
    const maxEdgeScrollPerFrame = 22;

    const updateSelectionFromPointer = (shouldScheduleRaf) => {
      if (!startCell) return;

      const rect = this._rowsHost.getBoundingClientRect();
      state.vScrollX = this._edgeVelocityX(
        rect,
        state.lastClientX,
        edgeThreshold,
        maxEdgeScrollPerFrame
      );
      state.vScrollY = this._edgeVelocityY(
        rect,
        state.lastClientY,
        edgeThreshold,
        maxEdgeScrollPerFrame
      );

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
      if (!state.active || gesture.mode !== "select") return;
      if (state.vScrollX !== 0) this._setScrollXPx(this._scrollXPx + state.vScrollX);
      if (state.vScrollY !== 0) this._setScrollPx(this._scrollPx + state.vScrollY);
      updateSelectionFromPointer(true);
    };

    const beginSelectionMode = () => {
      if (!startCell || !state.active) return;
      gesture.mode = "select";
      this._rowsHost.classList.remove("vgt__rows--dragging");
      this._rowsHost.classList.add("vgt__rows--selecting");
      this._setSelectionRange(startCell, startCell);
      this._root.focus({ preventScroll: true });
      updateSelectionFromPointer(true);
    };

    if (gesture.mode === "pending") {
      gesture.timer = window.setTimeout(() => {
        if (this._activePointerGesture !== gesture || gesture.mode !== "pending") return;
        beginSelectionMode();
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

    let cleaned = false;
    let onMove = null;
    let onUp = null;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      state.active = false;
      if (gesture.timer) {
        window.clearTimeout(gesture.timer);
        gesture.timer = null;
      }
      if (state.rafId) {
        window.cancelAnimationFrame(state.rafId);
        state.rafId = 0;
      }
      this._rowsHost.style.touchAction = priorTouchAction;
      this._rowsHost.classList.remove("vgt__rows--dragging", "vgt__rows--selecting");
      if (this._activePointerGesture === gesture) this._activePointerGesture = null;
      try {
        this._rowsHost.releasePointerCapture(pointerId);
      } catch (err) {
        void err;
      }
      if (onMove) window.removeEventListener("pointermove", onMove);
      if (onUp) {
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      }
      this._syncMobileCopyButton();
    };
    gesture.cleanup = cleanup;

    onMove = (moveEvent) => {
      state.lastClientX = moveEvent.clientX;
      state.lastClientY = moveEvent.clientY;
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
        moveEvent.preventDefault();
        updateSelectionFromPointer(true);
      }
    };

    onUp = () => {
      cleanup();
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: true });
    window.addEventListener("pointercancel", onUp, { passive: true });
  }

  _cellFromEvent(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      if (target instanceof Node && target.parentElement instanceof Element) {
        return this._cellFromElement(target.parentElement);
      }
      return null;
    }
    return this._cellFromElement(target);
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

  _colFromHeaderClientPointClamped(clientX) {
    const colCount = this._columns.length | 0;
    if (colCount <= 0) return -1;
    const rect = this._rowsHost.getBoundingClientRect();
    if (rect.width <= 0) return -1;
    const clampedX = this._clamp(clientX, rect.left + 1, rect.right - 1);
    const localX = clampedX - rect.left + this._scrollXPx;
    const maxX = Math.max(0, this._totalContentWidth() - 1);
    const x = this._clamp(localX, 0, maxX);
    let cursor = 0;
    for (let i = 0; i < colCount; i += 1) {
      const width = Math.max(this._minColWidth, this._colWidths[i] ?? this._minColWidth);
      if (x < cursor + width) return i;
      cursor += width;
    }
    return colCount - 1;
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
    this._applySelectionRange(
      {
        rowMin: 0,
        rowMax: rowCount - 1,
        colMin: 0,
        colMax: colCount - 1,
      },
      { focusRoot: true }
    );
  }

  _selectRowRange(rowA, rowB) {
    const rowCount = this._viewCount | 0;
    const colCount = this._columns.length | 0;
    if (rowCount <= 0 || colCount <= 0) return;
    const minRow = this._clamp(Math.min(rowA | 0, rowB | 0), 0, rowCount - 1);
    const maxRow = this._clamp(Math.max(rowA | 0, rowB | 0), 0, rowCount - 1);
    this._applySelectionRange({
      rowMin: minRow,
      rowMax: maxRow,
      colMin: 0,
      colMax: colCount - 1,
    });
  }

  _selectColumnRange(colA, colB) {
    const rowCount = this._viewCount | 0;
    const colCount = this._columns.length | 0;
    if (rowCount <= 0 || colCount <= 0) return;
    const minCol = this._clamp(Math.min(colA | 0, colB | 0), 0, colCount - 1);
    const maxCol = this._clamp(Math.max(colA | 0, colB | 0), 0, colCount - 1);
    this._applySelectionRange({
      rowMin: 0,
      rowMax: rowCount - 1,
      colMin: minCol,
      colMax: maxCol,
    });
  }

  _setSelectionRange(anchorCell, focusCell) {
    const rowA = anchorCell.row | 0;
    const rowB = focusCell.row | 0;
    const colA = anchorCell.col | 0;
    const colB = focusCell.col | 0;
    this._applySelectionRange({
      rowMin: Math.min(rowA, rowB),
      rowMax: Math.max(rowA, rowB),
      colMin: Math.min(colA, colB),
      colMax: Math.max(colA, colB),
    });
  }

  _moveSelectionByArrows(k) {
    const range = this._selectionRange;
    if (!range) return false;

    const rowCount = this._viewCount | 0;
    const colCount = this._columns.length | 0;
    if (rowCount <= 0 || colCount <= 0) return false;

    const firstRow = 0;
    const lastRow = rowCount - 1;
    const firstCol = 0;
    const lastCol = colCount - 1;

    const anchor = this._selectionAnchorCell();
    if (!anchor) return false;

    const isWholeColumn = range.colMin === range.colMax && range.rowMin === firstRow && range.rowMax === lastRow;
    const isWholeRow = range.rowMin === range.rowMax && range.colMin === firstCol && range.colMax === lastCol;

    let next = null;

    if (k === "ArrowLeft") {
      if (isWholeColumn) {
        const nextCol = this._clamp(range.colMin - 1, firstCol, lastCol);
        if (nextCol !== range.colMin) {
          next = { rowMin: firstRow, rowMax: lastRow, colMin: nextCol, colMax: nextCol };
        }
      } else {
        const nextCol = this._clamp(anchor.col - 1, firstCol, lastCol);
        if (nextCol !== anchor.col) {
          next = { rowMin: anchor.row, rowMax: anchor.row, colMin: nextCol, colMax: nextCol };
        }
      }
    } else if (k === "ArrowRight") {
      if (isWholeColumn) {
        const nextCol = this._clamp(range.colMin + 1, firstCol, lastCol);
        if (nextCol !== range.colMin) {
          next = { rowMin: firstRow, rowMax: lastRow, colMin: nextCol, colMax: nextCol };
        }
      } else {
        const nextCol = this._clamp(anchor.col + 1, firstCol, lastCol);
        if (nextCol !== anchor.col) {
          next = { rowMin: anchor.row, rowMax: anchor.row, colMin: nextCol, colMax: nextCol };
        }
      }
    } else if (k === "ArrowUp") {
      if (isWholeRow) {
        const nextRow = this._clamp(range.rowMin - 1, firstRow, lastRow);
        if (nextRow !== range.rowMin) {
          next = { rowMin: nextRow, rowMax: nextRow, colMin: firstCol, colMax: lastCol };
        }
      } else {
        const nextRow = this._clamp(anchor.row - 1, firstRow, lastRow);
        if (nextRow !== anchor.row) {
          next = { rowMin: nextRow, rowMax: nextRow, colMin: anchor.col, colMax: anchor.col };
        }
      }
    } else if (k === "ArrowDown") {
      if (isWholeRow) {
        const nextRow = this._clamp(range.rowMin + 1, firstRow, lastRow);
        if (nextRow !== range.rowMin) {
          next = { rowMin: nextRow, rowMax: nextRow, colMin: firstCol, colMax: lastCol };
        }
      } else {
        const nextRow = this._clamp(anchor.row + 1, firstRow, lastRow);
        if (nextRow !== anchor.row) {
          next = { rowMin: nextRow, rowMax: nextRow, colMin: anchor.col, colMax: anchor.col };
        }
      }
    }

    if (!next) return false;

    this._applySelectionRange(next, { focusRoot: true });
    this._scrollSelectionIntoView(next.rowMin, next.colMin);
    return true;
  }

  _moveSelectionByNavigationKey(key, shiftKey = false) {
    if (key === "Tab") {
      return this._moveSelectionByArrows("ArrowRight");
    }
    if (key === "Enter") {
      return this._moveSelectionByArrows("ArrowDown");
    }
    return false;
  }

  _scrollSelectionIntoView(viewRow, colIndex) {
    const rowCount = this._viewCount | 0;
    const colCount = this._columns.length | 0;
    const firstCol = 0;
    if (rowCount <= 0 || colCount <= 0) return;
    this._ensureColWidths();

    const rowTop = viewRow * this._opts.rowHeight;
    const rowBottom = rowTop + this._opts.rowHeight;
    if (rowTop < this._scrollPx) {
      this._setScrollPx(rowTop);
    } else if (rowBottom > this._scrollPx + this._bodyH) {
      this._setScrollPx(rowBottom - this._bodyH);
    }

    let left = 0;
    const targetCol = this._clamp(colIndex | 0, firstCol, colCount - 1);
    for (let c = 0; c < targetCol; c += 1) {
      left += Math.max(this._minColWidth, this._colWidths[c] ?? this._minColWidth);
    }
    const width = Math.max(this._minColWidth, this._colWidths[targetCol] ?? this._minColWidth);
    const right = left + width;

    if (left < this._scrollXPx) {
      this._setScrollXPx(left);
    } else if (right > this._scrollXPx + this._bodyW) {
      this._setScrollXPx(right - this._bodyW);
    }
  }

  _applySelectionRange(range, options = {}) {
    this._selectionRange = range;
    if (options.focusRoot) this._root.focus({ preventScroll: true });
    this._syncHeadBumperState();
    this._renderBody();
    this._renderHeaderSelectionState();
    this._syncMobileCopyButton();
  }

  _clearSelection(rerender = true) {
    if (!this._selectionRange) return;
    this._selectionRange = null;
    this._closeContextMenu();
    this._syncHeadBumperState();
    if (rerender) {
      this._renderBody();
      this._renderHeaderSelectionState();
    }
    this._syncMobileCopyButton();
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

  _isColumnFullySelected(colIndex) {
    const range = this._selectionRange;
    const lastRow = this._viewCount - 1;
    if (!range || lastRow < 0) return false;
    return colIndex >= range.colMin && colIndex <= range.colMax && range.rowMin === 0 && range.rowMax === lastRow;
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

  _renderHeaderSelectionState() {
    if (!this._hcells) return;
    for (let i = 0; i < this._hcells.length; i += 1) {
      const abs = parseInt(this._hcells[i].dataset.abs || "-1", 10) | 0;
      this._hcells[i].classList.toggle("vgt__hcell--selected", abs >= 0 && this._isColumnFullySelected(abs));
    }
  }

  _isCoarsePointer() {
    return Boolean(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  }

  _syncMobileCopyButton() {
    if (!this._copyFabGroup) return;
    const hasSelection = this._hasSelection();
    const isGestureActive =
      this._pointerSelecting ||
      this._rowsHost.classList.contains("vgt__rows--dragging") ||
      this._rowsHost.classList.contains("vgt__rows--selecting") ||
      this._rowBumpers.classList.contains("vgt__rows--selecting");
    const shouldShow = this._isCoarsePointer() && hasSelection && !isGestureActive;
    this._copyFabGroup.dataset.show = shouldShow ? "1" : "0";
    if (!shouldShow) this._copyFab.dataset.copied = "0";
    if (!shouldShow && this._copyFabWithHeaders) this._copyFabWithHeaders.dataset.copied = "0";
  }

  _flashMobileCopyButton(button) {
    const targetBtn = button || this._copyFab;
    if (!targetBtn || this._copyFabGroup?.dataset.show !== "1") return;
    if (this._mobileCopyResetTimer) {
      window.clearTimeout(this._mobileCopyResetTimer);
      this._mobileCopyResetTimer = 0;
    }
    if (this._copyFab) this._copyFab.dataset.copied = "0";
    if (this._copyFabWithHeaders) this._copyFabWithHeaders.dataset.copied = "0";
    targetBtn.dataset.copied = "1";
    this._mobileCopyResetTimer = window.setTimeout(() => {
      this._mobileCopyResetTimer = 0;
      if (targetBtn) targetBtn.dataset.copied = "0";
    }, 950);
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

  _focusRoot() {
    if (!this._root) return;
    try {
      this._root.focus({ preventScroll: true });
      return;
    } catch (error) {
      try {
        this._root.focus();
      } catch (error2) {
        void error2;
      }
    }
  }

  _focusRootNextTick() {
    this._focusRoot();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (document?.activeElement !== this._root) this._focusRoot();
      });
    } else {
      setTimeout(() => {
        if (document?.activeElement !== this._root) this._focusRoot();
      }, 0);
    }
  }

  _canEditCells() {
    return this._opts.editable === true && this._editMode === true && this._mode === "local" && this._columns.length > 0;
  }

  _selectionAnchorCell() {
    const range = this._selectionRange;
    if (!range) return null;
    return { row: range.rowMin, col: range.colMin };
  }

  _forEachSelectedVisibleCell(range, callback) {
    const normalized = this._normalizedSelectionRange(range);
    if (!normalized || !this._rowEls) return;
    const { rowMin, rowMax, colMin, colMax } = normalized;
    for (let slotIndex = 0; slotIndex < this._rowEls.length; slotIndex += 1) {
      const slot = this._rowEls[slotIndex];
      const viewRow = Number(slot.rowEl.dataset.viewRow);
      if (!Number.isFinite(viewRow) || viewRow < rowMin || viewRow > rowMax) continue;

      for (let colIndex = colMin; colIndex <= colMax; colIndex += 1) {
        const cellEl = slot.cellEls[colIndex];
        if (!cellEl) continue;
        callback(cellEl, viewRow, colIndex);
      }
    }
  }

  _applySelectionDraft(range, draftText) {
    const text = draftText == null ? "" : String(draftText);
    this._forEachSelectedVisibleCell(range, (cellEl) => {
      if (cellEl.classList.contains("vgt__cell--editing")) return;
      cellEl.textContent = text;
      cellEl.classList.add("vgt__cell--multiEditing");
    });
  }

  _clearSelectionDraft(range) {
    this._forEachSelectedVisibleCell(range, (cellEl) => {
      cellEl.classList.remove("vgt__cell--multiEditing");
    });
  }

  _syncSelectionFromData(range) {
    if (this._mode !== "local") return;
    this._forEachSelectedVisibleCell(range, (cellEl, viewRow, colIndex) => {
      const baseIndex = this._viewIndexToBase(viewRow);
      if (baseIndex < 0) return;
      const value = this._rows[baseIndex]?.[colIndex];
      cellEl.textContent = value == null ? "" : String(value);
    });
  }

  _removeActiveEditInput(edit) {
    if (!edit?.input) return;
    const input = edit.input;
    const parent = input.closest(".vgt__cell");
    if (parent) parent.classList.remove("vgt__cell--editing");
    input.remove();
  }

  _setEditMode(isEditMode) {
    const next = this._opts.editable === true && Boolean(isEditMode);
    if (next === this._editMode) {
      if (this._editModeBtn) this._editModeBtn.disabled = !this._opts.editable;
      this._refreshEditModeToggle();
      return;
    }

    if (!next && this._activeEdit) {
      this._commitActiveEdit({ rerender: false });
    }

    this._editMode = next;
    if (!this._opts.editable) this._editMode = false;
    if (this._editModeBtn) {
      this._editModeBtn.disabled = !this._opts.editable;
      this._refreshEditModeToggle();
    }
  }

  _refreshEditModeToggle() {
    if (!this._editModeBtn) return;
    if (!this._opts.editable) {
      this._editModeBtn.textContent = "Read";
      this._editModeBtn.dataset.mode = "read";
      return;
    }

    if (this._editMode) {
      this._editModeBtn.textContent = "Edit";
      this._editModeBtn.dataset.mode = "edit";
      return;
    }

    this._editModeBtn.textContent = "Read";
    this._editModeBtn.dataset.mode = "read";
  }

  _toggleEditMode() {
    this._setEditMode(!this._editMode);
  }

  _normalizedSelectionRange(range) {
    if (!range) return null;
    const rowCount = this._viewCount | 0;
    const colCount = this._columns.length | 0;
    if (rowCount <= 0 || colCount <= 0) return null;

    const rowMin = this._clamp(range.rowMin | 0, 0, rowCount - 1);
    const rowMax = this._clamp(range.rowMax | 0, 0, rowCount - 1);
    const colMin = this._clamp(range.colMin | 0, 0, colCount - 1);
    const colMax = this._clamp(range.colMax | 0, 0, colCount - 1);
    if (rowMin > rowMax || colMin > colMax) return null;

    return {
      rowMin,
      rowMax,
      colMin,
      colMax,
    };
  }

  _cellElementForViewCell(viewRow, colIndex) {
    if (!this._rowEls) return null;
    for (let i = 0; i < this._rowEls.length; i += 1) {
      const slot = this._rowEls[i];
      if (Number(slot.rowEl.dataset.viewRow) === viewRow) return slot.cellEls[colIndex] ?? null;
    }
    return null;
  }

  _beginCellEdit(cell, initialText = null, options = {}) {
    if (!this._canEditCells()) return false;
    if (!cell) return false;

    const anchor = {
      row: cell?.row | 0,
      col: cell?.col | 0,
    };
    const baseSelection = this._normalizedSelectionRange(options.selectionRange);
    const editSelection = baseSelection || {
      rowMin: anchor.row,
      rowMax: anchor.row,
      colMin: anchor.col,
      colMax: anchor.col,
    };
    const isMultiEdit = editSelection.rowMin !== editSelection.rowMax || editSelection.colMin !== editSelection.colMax;

    const viewRow = this._clamp(editSelection.rowMin, 0, this._viewCount - 1);
    const colIndex = this._clamp(editSelection.colMin, 0, Math.max(0, this._columns.length - 1));
    const baseIndex = this._viewIndexToBase(viewRow);
    if (baseIndex < 0 || colIndex < 0) return false;

    this._commitActiveEdit({ rerender: false });
    const cellEl = this._cellElementForViewCell(viewRow, colIndex);
    if (!cellEl) return false;

    this._applySelectionRange(editSelection);

    const oldValue = this._rows[baseIndex]?.[colIndex];
    const input = document.createElement("input");
    input.className = "vgt__cellEditor";
    input.type = "text";
    if (initialText != null) {
      input.value = String(initialText);
    } else {
      input.value = oldValue == null ? "" : String(oldValue);
    }
    input.setAttribute("aria-label", "Edit cell");

    const edit = {
      input,
      viewRow,
      colIndex,
      selectionRange: editSelection,
      oldValue,
      isMultiEdit,
    };
    this._activeEdit = edit;
    if (isMultiEdit) this._applySelectionDraft(editSelection, input.value);

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "NumpadEnter") {
        event.preventDefault();
        this._commitActiveEdit({ rerender: false, preserveSelection: true });
        this._moveSelectionByNavigationKey("Enter", false);
        this._focusRootNextTick();
        return;
      } else if (event.key === "Escape") {
        event.preventDefault();
        this._cancelActiveEdit({ rerender: true });
        this._focusRootNextTick();
      } else if (event.key === "Tab") {
        event.preventDefault();
        this._commitActiveEdit({ rerender: false, preserveSelection: true });
        this._moveSelectionByNavigationKey("Tab", event.shiftKey);
        this._focusRootNextTick();
      }
    });
    input.addEventListener("blur", () => {
      if (this._activeEdit === edit) this._commitActiveEdit({ rerender: true });
    });

    input.addEventListener("input", () => {
      if (this._activeEdit === edit && edit.isMultiEdit) {
        this._applySelectionDraft(edit.selectionRange, input.value);
      }
    });

    cellEl.classList.add("vgt__cell--editing");
    cellEl.textContent = "";
    cellEl.append(input);
    input.focus({ preventScroll: true });
    if (initialText == null) {
      input.select();
    } else {
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
    return true;
  }

  _commitActiveEdit(options = {}) {
    const edit = this._activeEdit;
    if (!edit) return false;
    this._removeActiveEditInput(edit);
    this._clearSelectionDraft(edit.selectionRange);
    this._activeEdit = null;
    const changes = [];
    const nextValue = edit.input ? edit.input.value : "";
    const range = this._normalizedSelectionRange(edit.selectionRange);

    if (range && this._mode === "local") {
      for (let viewRow = range.rowMin; viewRow <= range.rowMax; viewRow += 1) {
        const baseIndex = this._viewIndexToBase(viewRow);
        if (baseIndex < 0) continue;
        for (let colIndex = range.colMin; colIndex <= range.colMax; colIndex += 1) {
          this._queueLocalCellChange(changes, baseIndex, colIndex, nextValue);
        }
      }
    }

    if (changes.length > 0) {
      this._applyLocalCellChanges(changes, {
        rerender: options.rerender !== false,
        preserveSelection: options.preserveSelection === true,
      });
      if (options.rerender === false) this._syncSelectionFromData(range);
      return true;
    }

    if (options.rerender === false) this._syncSelectionFromData(range);
    else this._renderBody();
    return false;
  }

  _cancelActiveEdit(options = {}) {
    if (!this._activeEdit) return;
    const edit = this._activeEdit;
    this._removeActiveEditInput(edit);
    this._clearSelectionDraft(edit.selectionRange);
    this._activeEdit = null;
    if (options.rerender === false) {
      this._syncSelectionFromData(edit.selectionRange);
    } else {
      this._renderBody();
    }
  }

  _onPaste(event) {
    if (!this._canEditCells() || this._opts.paste === false || this._isEditableTarget(event.target)) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    const startCell = this._selectionAnchorCell();
    if (!startCell) return;
    const matrix = this._parseClipboardMatrix(text);
    if (matrix.length === 0) return;

    event.preventDefault();
    this._pasteLocalCells(startCell, matrix);
  }

  _parseClipboardMatrix(text) {
    const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines.map((line) => line.split("\t"));
  }

  _pasteLocalCells(startCell, matrix) {
    const range = this._selectionRange;
    const changes = [];
    const fillSelection =
      matrix.length === 1 &&
      matrix[0].length === 1 &&
      range &&
      (range.rowMax > range.rowMin || range.colMax > range.colMin);

    if (fillSelection) {
      const value = matrix[0][0];
      for (let viewRow = range.rowMin; viewRow <= range.rowMax; viewRow += 1) {
        const baseIndex = this._viewIndexToBase(viewRow);
        if (baseIndex < 0) continue;
        for (let col = range.colMin; col <= range.colMax; col += 1) {
          this._queueLocalCellChange(changes, baseIndex, col, value);
        }
      }
    } else {
      for (let r = 0; r < matrix.length; r += 1) {
        const viewRow = startCell.row + r;
        if (viewRow >= this._viewCount) break;
        const baseIndex = this._viewIndexToBase(viewRow);
        if (baseIndex < 0) continue;
        for (let c = 0; c < matrix[r].length; c += 1) {
          const colIndex = startCell.col + c;
          if (colIndex >= this._columns.length) break;
          this._queueLocalCellChange(changes, baseIndex, colIndex, matrix[r][c]);
        }
      }
    }

    this._applyLocalCellChanges(changes, { rerender: true });
  }

  _clearSelectedLocalCells() {
    if (!this._canEditCells() || !this._selectionRange) return;
    this._commitActiveEdit({ rerender: false });
    const { rowMin, rowMax, colMin, colMax } = this._selectionRange;
    const changes = [];
    for (let viewRow = rowMin; viewRow <= rowMax; viewRow += 1) {
      const baseIndex = this._viewIndexToBase(viewRow);
      if (baseIndex < 0) continue;
      for (let col = colMin; col <= colMax; col += 1) {
        this._queueLocalCellChange(changes, baseIndex, col, "");
      }
    }
    this._applyLocalCellChanges(changes, { rerender: true });
  }

  _queueLocalCellChange(changes, baseIndex, colIndex, value) {
    if (baseIndex < 0 || baseIndex >= this._rows.length || colIndex < 0 || colIndex >= this._columns.length) return;
    const row = this._rows[baseIndex] || [];
    const oldValue = row[colIndex];
    if ((oldValue == null ? "" : String(oldValue)) === String(value ?? "")) return;
    changes.push({ baseIndex, colIndex, oldValue, value: value ?? "" });
  }

  _recordHistoryEntry(changes) {
    if (!Array.isArray(changes) || changes.length === 0) return;

    const snapshot = new Array(changes.length);
    for (let i = 0; i < changes.length; i += 1) {
      const change = changes[i];
      snapshot[i] = {
        baseIndex: change.baseIndex,
        colIndex: change.colIndex,
        oldValue: change.oldValue,
        value: change.value,
      };
    }

    this._undoStack.push(snapshot);
    if (this._undoStack.length > this._undoHistoryLimit) this._undoStack.shift();
    this._redoStack.length = 0;
  }

  _applyCellChangesWithResolver(changes, valueResolver, options = {}) {
    if (this._mode !== "local" || !Array.isArray(changes) || changes.length === 0) return [];

    const touchedRows = new Set();
    const applied = [];

    for (let i = 0; i < changes.length; i += 1) {
      const change = changes[i];
      if (!change) continue;
      const baseIndex = change.baseIndex | 0;
      const colIndex = change.colIndex | 0;
      if (baseIndex < 0 || baseIndex >= this._rows.length || colIndex < 0 || colIndex >= this._columns.length) continue;

      const row = this._rows[baseIndex];
      if (!row) continue;

      const nextValue = valueResolver(change);
      const prevValue = row[colIndex];
      if (Object.is(prevValue, nextValue)) continue;

      row[colIndex] = nextValue;
      touchedRows.add(baseIndex);
      applied.push({
        baseIndex,
        colIndex,
        oldValue: prevValue,
        value: nextValue,
      });
    }

    if (applied.length === 0) return [];

    this._invalidateLocalRowCaches(touchedRows);
    this._autoColWidths = this._computeAutoColumnWidthsFromLocalData();
    if (this._hasLocalQueryState() && options.preserveSelection !== true) this._clearSelection(false);
    this._recomputeView();
    this._clampScroll();
    if (options.rerender !== false) this._renderAll();
    if (options.notify !== false) this._notifyCellsChange(applied);

    return applied;
  }

  _applyHistoryEntry(entry, direction, options = {}) {
    return this._applyCellChangesWithResolver(entry, (change) => {
      return direction === "undo" ? change.oldValue : change.value;
    }, options);
  }

  _undo() {
    if (this._undoStack.length === 0) return false;
    if (this._activeEdit) this._commitActiveEdit({ rerender: false });

    const entry = this._undoStack.pop();
    const applied = this._applyHistoryEntry(entry, "undo", { rerender: true, notify: true });
    if (applied.length === 0) return false;

    this._redoStack.push(entry);
    if (this._redoStack.length > this._undoHistoryLimit) this._redoStack.shift();
    return true;
  }

  _redo() {
    if (this._redoStack.length === 0) return false;
    if (this._activeEdit) this._commitActiveEdit({ rerender: false });

    const entry = this._redoStack.pop();
    const applied = this._applyHistoryEntry(entry, "redo", { rerender: true, notify: true });
    if (applied.length === 0) return false;

    this._undoStack.push(entry);
    if (this._undoStack.length > this._undoHistoryLimit) this._undoStack.shift();
    return true;
  }

  _applyLocalCellChanges(changes, options = {}) {
    const applied = this._applyCellChangesWithResolver(changes, (change) => change.value, {
      rerender: options.rerender !== false,
      notify: true,
      preserveSelection: options.preserveSelection === true,
    });
    if (applied.length === 0) return false;

    if (options.skipHistory !== true) this._recordHistoryEntry(applied);
    return true;
  }

  _invalidateLocalRowCaches(rowIndexes) {
    for (const baseIndex of rowIndexes) {
      this._searchCache[baseIndex] = null;
      this._searchColCache[baseIndex] = null;
    }
  }

  _hasLocalQueryState() {
    return Boolean(this._filter || this._searchQuery || this._sort || this._columnFilters.size > 0);
  }

  _notifyCellsChange(changes) {
    if (!this._onCellsChange) return;
    const payload = changes.map((change) => ({
      baseIndex: change.baseIndex,
      colIndex: change.colIndex,
      column: this._columns[change.colIndex],
      row: this._rows[change.baseIndex],
      oldValue: change.oldValue,
      value: change.value,
    }));
    try {
      this._onCellsChange(payload);
    } catch (err) {
      console.error("VirtualGridTable onCellsChange failed", err);
    }
  }

  _onCopy(event) {
    if (!this._hasSelection()) return;
    const payload = this._clipboardPayload(this._isAllSelected());
    if (!payload.text) return;
    event.preventDefault();
    this._writeClipboardData(event.clipboardData, payload);
  }

  _copySelectionToClipboard(includeHeaders = this._isAllSelected()) {
    const payload = this._clipboardPayload(includeHeaders);
    if (!payload.text) return;
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.write === "function" &&
      typeof ClipboardItem === "function"
    ) {
      const itemData = {
        "text/plain": new Blob([payload.text], { type: "text/plain" }),
      };
      if (payload.html) {
        itemData["text/html"] = new Blob([payload.html], { type: "text/html" });
      }
      navigator.clipboard.write([new ClipboardItem(itemData)]).catch(() => {
        this._fallbackCopyPayload(payload);
      });
      return;
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(payload.text).catch(() => {
        this._fallbackCopyPayload(payload);
      });
      return;
    }
    this._fallbackCopyPayload(payload);
  }

  _fallbackCopyPayload(payload) {
    const writeHandler = (event) => {
      event.preventDefault();
      this._writeClipboardData(event.clipboardData, payload);
    };
    document.addEventListener("copy", writeHandler, true);
    const ta = document.createElement("textarea");
    ta.value = payload.text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      document.removeEventListener("copy", writeHandler, true);
    }
    ta.remove();
  }

  _writeClipboardData(clipboardData, payload) {
    if (!clipboardData) return;
    clipboardData.setData("text/plain", payload.text);
    if (payload.html) clipboardData.setData("text/html", payload.html);
  }

  _clipboardPayload(includeHeaders = false) {
    const rows = this._selectionRowsForClipboard(includeHeaders);
    if (rows.length === 0) return { text: "", html: "" };
    return {
      text: rows.map((row) => row.join("\t")).join("\n"),
      html: this._selectionRowsToHtml(rows, includeHeaders),
    };
  }

  _selectionRowsForClipboard(includeHeaders = false) {
    if (!this._selectionRange) return [];
    const { rowMin, rowMax, colMin, colMax } = this._selectionRange;
    const out = [];
    if (includeHeaders) {
      const headerOut = [];
      for (let col = colMin; col <= colMax; col += 1) {
        const column = this._columns[col];
        const label = column ? column.label ?? column.key ?? "" : "";
        headerOut.push(String(label));
      }
      out.push(headerOut);
    }
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
      out.push(rowOut);
    }
    return out;
  }

  _selectionRowsToHtml(rows, hasHeaderRow) {
    if (!rows.length) return "";
    const colCount = rows[0]?.length || 0;
    const colWidths = this._estimateClipboardColumnWidths(rows, colCount);
    const tableStyle =
      "border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;line-height:1.4;color:#0f172a;background:#ffffff;table-layout:auto;";
    const thStyle =
      "border:1px solid #d0d7de;padding:6px 10px;background:#f6f8fa;font-weight:600;text-align:left;white-space:nowrap;";
    const tdStyle =
      "border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top;white-space:nowrap;";
    let html = `<table style="${tableStyle}">`;
    if (colWidths.length > 0) {
      html += "<colgroup>";
      for (let c = 0; c < colWidths.length; c += 1) {
        html += `<col style="width:${colWidths[c]}px;">`;
      }
      html += "</colgroup>";
    }
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r];
      html += "<tr>";
      for (let c = 0; c < row.length; c += 1) {
        const tag = hasHeaderRow && r === 0 ? "th" : "td";
        const style = tag === "th" ? thStyle : tdStyle;
        html += `<${tag} style="${style}">${this._escapeHtml(row[c])}</${tag}>`;
      }
      html += "</tr>";
    }
    html += "</table>";
    return html;
  }

  _estimateClipboardColumnWidths(rows, colCount) {
    if (!rows.length || colCount <= 0) return [];
    const out = new Array(colCount).fill(0);
    for (let c = 0; c < colCount; c += 1) {
      let maxLen = 0;
      for (let r = 0; r < rows.length; r += 1) {
        const value = rows[r][c];
        const text = String(value == null ? "" : value);
        const compact = text.replace(/\s+/g, " ").trim();
        const measured = compact.length || text.length;
        if (measured > maxLen) maxLen = measured;
      }
      out[c] = this._clamp(Math.round(maxLen * 7.4 + 34), 84, 460);
    }
    return out;
  }

  _escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  _selectionToTsv() {
    const rows = this._selectionRowsForClipboard(this._isAllSelected());
    if (rows.length === 0) return "";
    return rows.map((row) => row.join("\t")).join("\n");
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

  _edgeVelocity(point, minEdge, maxEdge, edgeThreshold, maxEdgeScrollPerFrame) {
    if (point < minEdge) {
      const ratio = this._clamp01((minEdge - point) / edgeThreshold);
      return -ratio * maxEdgeScrollPerFrame;
    }
    if (point > maxEdge) {
      const ratio = this._clamp01((point - maxEdge) / edgeThreshold);
      return ratio * maxEdgeScrollPerFrame;
    }
    return 0;
  }

  _edgeVelocityX(rect, clientX, edgeThreshold, maxEdgeScrollPerFrame) {
    return this._edgeVelocity(
      clientX,
      rect.left + edgeThreshold,
      rect.right - edgeThreshold,
      edgeThreshold,
      maxEdgeScrollPerFrame
    );
  }

  _edgeVelocityY(rect, clientY, edgeThreshold, maxEdgeScrollPerFrame) {
    return this._edgeVelocity(
      clientY,
      rect.top + edgeThreshold,
      rect.bottom - edgeThreshold,
      edgeThreshold,
      maxEdgeScrollPerFrame
    );
  }

  _clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  _clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }
}

window.VirtualGridTable = VirtualGridTable;

const VGT_THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "chrome-dark", label: "Chrome Dark" },
  { value: "warm", label: "Warm" },
  { value: "aurora", label: "Aurora" },
];

const VGT_THEME_VALUES = VGT_THEME_OPTIONS.map((option) => option.value);

function isThemeValue(mode) {
  return VGT_THEME_VALUES.includes(mode);
}

function normalizeThemeMode(mode) {
  if (typeof mode === "string") {
    const normalized = mode.trim().toLowerCase();
    if (normalized === "dark") return "chrome-dark";
    if (isThemeValue(normalized)) return normalized;
    if (normalized === "current") return normalizeThemeMode(document.documentElement.getAttribute("data-theme"));
  }

  const current = document.documentElement.getAttribute("data-theme");
  if (typeof current === "string") {
    const normalized = current.trim().toLowerCase();
    if (normalized === "dark") return "chrome-dark";
    if (isThemeValue(normalized)) return normalized;
  }
  return "light";
}

function defaultConditionalFormatColors(themeMode) {
  const theme = normalizeThemeMode(themeMode);
  if (theme === "warm") {
    return { backgroundColor: "#5a311d", color: "#ffe7d1" };
  }
  if (theme === "aurora") {
    return { backgroundColor: "#14384b", color: "#e8fbff" };
  }
  if (theme === "chrome-dark" || theme === "dark") {
    return { backgroundColor: "#173153", color: "#e6f0ff" };
  }
  return { backgroundColor: "#dbe8ff", color: "#183a66" };
}

window.setAppTheme = function setAppTheme(mode) {
  const theme = normalizeThemeMode(mode);
  document.documentElement.setAttribute("data-theme", theme);
  return theme;
};

function pick(list, index) {
  return list[index % list.length];
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatFakeTimestamp(index) {
  const month = (index % 12) + 1;
  const day = ((index * 7) % 28) + 1;
  const hour = (index * 3) % 24;
  const minute = (index * 11) % 60;
  return `2026-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`;
}

function makeFakeCustomerName(index) {
  const firstNames = [
    "Nova",
    "Pixel",
    "Velvet",
    "Orbit",
    "Moxie",
    "Zippy",
    "Quasar",
    "Echo",
    "Rivet",
    "Indigo",
    "Jett",
    "Kilo",
  ];
  const surnames = [
    "McTestface",
    "Placeholder",
    "Sampleton",
    "Demochild",
    "Pretendwell",
    "Fauxworthy",
    "Mockridge",
    "Standin",
    "Inventson",
    "Fictioneer",
    "Specimen",
    "Bogusby",
  ];
  return `${pick(firstNames, index)} ${pick(surnames, index * 5 + 3)}`;
}

function makeFakeProductDescription(index) {
  const adjectives = [
    "Neon",
    "Pocket",
    "Modular",
    "Weatherproof",
    "Glow-in-the-dark",
    "Ultra-lite",
    "Retro",
    "Quantum-ish",
    "Desk-ready",
    "Midnight",
    "Noise-loving",
    "Overclocked",
  ];
  const materials = [
    "alloy",
    "carbon shell",
    "velvet polymer",
    "soft-touch resin",
    "ceramic mesh",
    "faux titanium",
    "matte graphite",
    "translucent acrylic",
    "rubberized steel",
    "woven nylon",
  ];
  const products = [
    "signal booster",
    "espresso drone dock",
    "keyboard shrine",
    "cable wrangler",
    "monitor halo bar",
    "sidecar battery brick",
    "thermal mug sleeve",
    "desktop launch switch",
    "pixel badge printer",
    "ambient fan tower",
    "sticker vault",
    "tiny fog machine",
  ];
  const features = [
    "for suspiciously enthusiastic workflows",
    "with reversible charging fins",
    "featuring zero practical restraint",
    "for late-night spreadsheet heroics",
    "with optional dramatic backlighting",
    "for desks that take themselves too seriously",
    "with a politely unnecessary turbo mode",
    "for chaotic-neutral professionals",
    "with anti-boring trim panels",
    "for controlled aesthetic overkill",
  ];
  return [
    pick(adjectives, index),
    pick(materials, index * 2 + 1),
    pick(products, index * 3 + 2),
    pick(features, index * 7 + 4),
  ].join(" ");
}

function buildDemoTransaction(index) {
  const channels = ["web", "retail", "partner", "field", "kiosk"];
  const regions = ["NA-CENTRAL", "NA-WEST", "EU-NORTH", "APAC-LAB", "MOON-BASE-2"];
  const statuses = ["PAID", "PENDING", "REVIEW", "HOLD", "REFUNDED"];
  const repFirstNames = [
    "Cass",
    "Juno",
    "Milo",
    "Tess",
    "Rex",
    "Poppy",
    "Dax",
    "Vera",
    "Nico",
    "Lux",
    "Ivy",
    "Otto",
  ];
  const repLastNames = [
    "Draft",
    "Mercer",
    "Vale",
    "Onyx",
    "Wilder",
    "Knox",
    "Hollow",
    "Fable",
    "Sterling",
    "Voss",
    "Marlowe",
    "Sable",
  ];
  const qty = (index % 9) + 1;
  const unitPrice = 19 + ((index * 17) % 240) + ((index % 5) * 0.95);
  return {
    order_id: `TXN-${String(index + 1).padStart(6, "0")}`,
    customer: makeFakeCustomerName(index),
    product: makeFakeProductDescription(index),
    qty,
    unit_price: unitPrice.toFixed(2),
    total: (qty * unitPrice).toFixed(2),
    channel: pick(channels, index * 2 + 1),
    region: pick(regions, index * 3 + 2),
    status: pick(statuses, index * 3 + 4),
    rep: `${pick(repFirstNames, index * 2 + 1)} ${pick(repLastNames, index * 3 + 2)}`,
    memo: index % 6 === 0 ? "Generated preview row for UI testing" : "",
    placed_at: formatFakeTimestamp(index),
  };
}

const grid = new VirtualGridTable("grid", {
  rowHeight: 28,
  visibleCols: 6,
  overscan: 2,
  editable: true,
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
    demo.push(buildDemoTransaction(i));
  }

  setTimeout(() => {
    grid.setData(demo);
    grid.setConditionalFormats([
      {
        colIndex: 5,
        op: ">",
        value: "1200",
        backgroundColor: "#173b2f",
        color: "#b7f7d8",
      },
      {
        colIndex: 8,
        op: "=",
        value: "HOLD",
        backgroundColor: "#4a1b1f",
        color: "#ffd0d7",
      },
      {
        colIndex: 8,
        op: "=",
        value: "REFUNDED",
        backgroundColor: "#332047",
        color: "#ead7ff",
      },
    ]);
    grid.setLoading(false);
  }, 250);
}
