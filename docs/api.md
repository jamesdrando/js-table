# VirtualGridTable API reference

## `new VirtualGridTable(containerId, options?)`

**Category:** initialization  
**Returns:** `VirtualGridTable`

Creates and mounts a virtual grid into an existing DOM element.

**Parameters**

- `containerId` `string` — `id` of the host element
- `options.width` `string | number` — root width, default `"100%"`
- `options.height` `string | number` — root height, default `"100%"`
- `options.rowHeight` `number` — row height in pixels, default `28`
- `options.visibleCols` `number` — used when estimating default column widths, default `6`
- `options.overscan` `number` — extra pooled rows above and below the viewport, default `2`
- `options.mode` `"local" | "chunked"` — initial data mode, default `"local"`
- `options.chunkSize` `number` — chunk request size, default `250`
- `options.totalRows` `number` — initial total row count for chunked mode, default `0`
- `options.onChunkRequest` `(request) => void | response` — optional side-effect or fallback callback
- `options.fetchChunk` `(request) => response | Promise<response>` — optional chunk provider
- `options.cellClass` `(value, rowArray, ctx) => string | string[]` — optional visible-cell class callback
- `options.demo_mode` `boolean | "chunked"` — demo-only option used by the sample page
- `options.demo_rows` `number` — demo-only row count used by the sample page

**Example**

```js
const grid = new window.VirtualGridTable("grid", {
  rowHeight: 28,
  visibleCols: 6,
  overscan: 2
});
```

**Common mistakes**

- Passing an `HTMLElement` instead of the container id string
- Assuming `visibleCols` limits the rendered column count; it only affects width heuristics

## `setLoading(isLoading)`

**Category:** state  
**Returns:** `void`

Shows or hides the overlay.

**Parameters**

- `isLoading` `boolean`

**Notes**

- When `true`, the overlay text becomes `Loading...`
- When `false`, the overlay shows `No data to display` only if there are no visible rows

## `setData(data)`

**Category:** local data  
**Returns:** `void`

Loads local data and switches the table into local mode.

**Parameters**

- `data` `Array<object>` — infers columns from the first object
- `data` `{ columns, rows }` — explicit column schema plus rows

**Accepted column shapes**

- `"total"` → `{ key: "total", label: "total" }`
- `{ key: "total", label: "Total" }`

**Accepted row shapes**

- Arrays, aligned to the `columns` order
- Objects, mapped by each column `key`

**Side effects**

- Clears chunk cache and pending chunk requests
- Recomputes auto column widths from the local dataset
- Clears column filters
- Resets sort, selection, and scroll position

**Common mistakes**

- Calling `setData([])` and expecting inferred columns
- Expecting previous local sort state to survive new data

## `setSearch(query)`

**Category:** local/chunked query  
**Returns:** `void`

Stores a case-insensitive search string.

**Parameters**

- `query` `string`

**Notes**

- Search is applied locally only in local mode
- In chunked mode the query is sent to chunk providers in each request

## `setSearchColumn(indexOrAll)`

**Category:** local/chunked query  
**Returns:** `void`

Targets search to one column or to all columns.

**Parameters**

- `indexOrAll` `number | -1 | null | undefined`

**Notes**

- `-1`, `null`, and `undefined` mean all columns

## `clearSearch()`

**Category:** local/chunked query  
**Returns:** `void`

Equivalent to `setSearch("")`.

## `setFilter(filterFn)`

**Category:** local query  
**Returns:** `void`

Sets a custom row filter used only in local mode.

**Parameters**

- `filterFn` `(rowArray, rowIndex) => boolean`

**Notes**

- The callback receives normalized row arrays
- In chunked mode the function itself is not serialized; request objects only expose `hasCustomFilter`

## `clearFilter()`

**Category:** local query  
**Returns:** `void`

Equivalent to `setFilter(null)`.

## `setColumnFilter(colIndex, filterSpec)`

**Category:** local/chunked query  
**Returns:** `void`

Sets a column-level filter.

**Parameters**

- `colIndex` `number`
- `filterSpec.op` `"like" | "=" | ">" | "<" | ">=" | "<=" | "not" | "between"`
- `filterSpec.value` `string`
- `filterSpec.valueTo` `string` — required for `between`

**Notes**

- Empty or invalid filter specs are ignored
- Numeric comparisons are numeric only when both sides parse as finite numbers
- Chunked mode includes serialized column filters in each request

**Example**

```js
grid.setColumnFilter(2, { op: ">=", value: "100" });
grid.setColumnFilter(3, { op: "between", value: "A", valueTo: "M" });
```

## `clearColumnFilters()`

**Category:** local/chunked query  
**Returns:** `void`

Removes all column filters.

## `setCellClass(cellClassFn)`

**Category:** rendering
**Returns:** `void`

Sets a callback that can add CSS classes to visible cells during render.

**Parameters**

- `cellClassFn` `(value, rowArray, ctx) => string | string[]`
- `ctx.viewRow` `number`
- `ctx.baseIndex` `number`
- `ctx.colIndex` `number`
- `ctx.column` `object`

**Notes**

- Runs only for pooled visible cells
- Pass `null` to clear the callback

## `setConditionalFormat(colIndex, formatSpec)`

**Category:** rendering
**Returns:** `void`

Sets one conditional format rule for a column.

**Parameters**

- `colIndex` `number`
- `formatSpec.op` `"like" | "=" | ">" | "<" | ">=" | "<=" | "not" | "between"`
- `formatSpec.value` `string`
- `formatSpec.valueTo` `string` — required for `between`
- `formatSpec.backgroundColor` `"#rrggbb" | "#rgb"`
- `formatSpec.color` `"#rrggbb" | "#rgb"`

**Example**

```js
grid.setConditionalFormat(5, {
  op: ">",
  value: "1200",
  backgroundColor: "#173b2f",
  color: "#b7f7d8"
});
```

## `setConditionalFormats(formatSpecs)`

**Category:** rendering
**Returns:** `void`

Replaces all conditional format rules. Multiple rules can target the same column; the first matching rule wins.

## `clearConditionalFormats(colIndex?)`

**Category:** rendering
**Returns:** `void`

Clears conditional formats for one column, or all columns when no index is passed.

## `sortBy(colIndex, dir)`

**Category:** local/chunked query  
**Returns:** `void`

Sets single-column sorting.

**Parameters**

- `colIndex` `number`
- `dir` `"asc" | "desc" | null`

**Notes**

- `null` clears sort state
- Local sorting is stable for equal values because the original row index is used as the tiebreaker
- Chunked mode sends the requested sort to the provider; it does not sort cached rows locally

## `clearSort()`

**Category:** local/chunked query  
**Returns:** `void`

Clears the current sort state.

## `setChunkMode(config)`

**Category:** chunked data  
**Returns:** `void`

Switches the table into chunked mode.

**Parameters**

- `config.columns` `Array<string | { key, label?, width? }>`
- `config.totalRows` `number`
- `config.chunkSize` `number`
- `config.onChunkRequest` `(request) => void | response`
- `config.fetchChunk` `(request) => response | Promise<response>`

**Chunk request shape**

- `id` `number`
- `start` `number`
- `endExclusive` `number`
- `size` `number`
- `reason` `string`
- `totalRows` `number`
- `query` `string`
- `searchColumn` `number`
- `hasCustomFilter` `boolean`
- `sort` `null | { colIndex, dir: "asc" | "desc" }`
- `columnFilters` `Array<{ colIndex, op, value, valueTo }>`

**Accepted responses**

- `rows`
- `{ start, rows, totalRows }`

**Notes**

- The table dispatches a `vgt:chunk-request` `CustomEvent` on the host element for every request
- `fetchChunk` takes precedence over `onChunkRequest` when both are present
- The table prefetches the next chunk after the current viewport window

**Common mistakes**

- Expecting chunked mode to filter or sort cached rows locally
- Returning object rows without providing `config.columns`

## `setChunkRows(startIndex, rows, totalRows?)`

**Category:** chunked data  
**Returns:** `void`

Stores a chunk manually.

**Parameters**

- `startIndex` `number`
- `rows` `Array<Array | object>`
- `totalRows` `number?`

**Notes**

- Rows beyond the current total are ignored
- Object rows are normalized using the current column keys

## `setChunkRowCount(totalRows, rerender = true)`

**Category:** chunked data  
**Returns:** `void`

Updates the total remote row count and trims cached rows outside the new range.

## `clearChunkCache()`

**Category:** chunked data  
**Returns:** `void`

Clears cached chunk rows and pending chunk windows.

**Notes**

- In chunked mode this triggers fresh loading on the next render

## `getOffsets()`

**Category:** inspection  
**Returns:** `{ rowPx, rowStart, colPx, colStart }`

Returns the current scroll offsets.

**Notes**

- `rowStart` is the first fully visible logical row
- `colStart` is based on the currently visible column range

## `destroy()`

**Category:** lifecycle  
**Returns:** `void`

Disconnects observers, removes listeners, closes menus, and removes the rendered root node.

## Browser globals

### `window.VirtualGridTable`

The public class constructor.

### `window.setAppTheme(mode)`

Demo-page helper that sets `document.documentElement.dataset.theme`.

**Parameters**

- `mode` `"dark" | "light"`

**Returns**

- `"dark" | "light"`
