# VirtualGridTable architecture

## Surface area

- Implementation file: `/app.js`
- Public browser globals: `window.VirtualGridTable`, `window.setAppTheme`
- Mount target: existing DOM node identified by id

## Rendering model

The table builds one root with a toolbar, header, body, status/footer area, overlay, filter menu, and context menu. Rendering is DOM-based with a fixed pool of row elements sized from the viewport plus overscan. Scrolling reuses those pooled rows by updating their content and translating the row container.

## Virtualization boundaries

- **Virtualized:** rows
- **Not virtualized:** columns

All columns remain part of each pooled row. Horizontal movement is handled by translating the header/body content and resizing the horizontal thumb.

## Data modes

### Local mode

- Backing store: `_rows`
- Optional derived view: `_view`
- `setData(...)` normalizes incoming rows to arrays
- Auto column widths are computed from headers and local content

### Chunked mode

- Backing store: sparse `_chunkRows` map keyed by absolute row index
- `_viewCount` comes from `totalRows` or the highest cached row index
- Missing viewport rows trigger chunk requests
- One extra chunk after the viewport is prefetched

## Local query pipeline

When local mode has active query state, rows are processed in this order:

1. Custom row filter (`setFilter`)
2. Column filters (`setColumnFilter`)
3. Search (`setSearch` + `setSearchColumn`)
4. Sort (`sortBy`)

The output is stored as `_view`, which maps visible row indexes back to source row indexes.

## Chunk request flow

When chunked mode needs data, the table:

1. Computes the visible logical row window from scroll position, row height, and overscan
2. Expands that window to chunk boundaries
3. Requests every missing chunk in the window
4. Prefetches one additional chunk after the window
5. Dispatches a `vgt:chunk-request` event on the host element
6. Calls `onChunkRequest(request)` if provided
7. Calls `fetchChunk(request)` if provided and prefers its return value
8. Accepts either `rows` or `{ start, rows, totalRows }`

Chunk requests include the current search text, search column, sort state, and serialized column filters so a remote provider can mirror the local UX.

## Selection and clipboard model

- Cell dragging selects rectangular ranges
- Row bumpers select full rows
- Header dragging selects full columns
- The top-left bumper selects the entire table
- `Ctrl/Cmd + C` copies the current selection
- Right-click on desktop opens a copy menu
- Touch devices use long-press selection and floating copy buttons

Clipboard export supports both TSV text and HTML tables. When the entire table is selected, header labels are included by default.

## Local editing model

Editing is available only when `options.editable` is enabled, the table is in local mode, and `Read/Edit` mode is set to `Edit`. The grid keeps one active input editor at a time; commits write through to `_rows` by base row index and column index, then invalidates search caches and recomputes the local view.

Paste uses the browser clipboard's plain-text payload as Excel-style tab/newline data. A single pasted value fills the current selection; a rectangular pasted range writes from the selection's top-left cell and is clamped to existing row and column bounds. `Delete` and `Backspace` clear selected local cells to empty strings.

Chunked mode does not accept edits, paste, or delete operations because the grid does not own the full remote dataset.

## Column sizing

- Explicit `column.width` wins
- Existing user-resized widths are preserved when possible
- Local mode can auto-size from content
- Widths are clamped between internal min/max values

## Resize behavior

A `ResizeObserver` watches the body area. On resize, the table remeasures the viewport, rebuilds the row pool if needed, clamps scroll positions, and rerenders.

## Important constraints

- Constructor input is a container id string, not a DOM node
- Empty object-array datasets cannot infer columns
- Chunked mode does not run local search/sort/filter against cached rows
- Custom filter callbacks are not serializable for remote providers
