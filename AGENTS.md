# js-table agent guide

`js-table` ships a browser `VirtualGridTable` class defined in `/app.js` and exposed on `window.VirtualGridTable`. It renders large datasets with row virtualization, horizontal scrolling, search, sorting, column filters, selection, local editing, and clipboard copy. It supports fully local data or chunked/remote loading driven by your callbacks. A thin React lifecycle wrapper lives in `/react`.

## What it does not do

- It does **not** currently ship TypeScript types.
- It does **not** provide npm packaging or module exports for the core `/app.js` class right now.
- It does **not** virtualize columns; only rows are pooled.
- It does **not** provide frozen columns, grouped rows, or multiple framework adapters.
- It does **not** serialize custom `setFilter(fn)` logic for remote providers.

## Canonical docs

- API reference: [`./docs/api.md`](./docs/api.md)
- Rendering model and data flow: [`./docs/architecture.md`](./docs/architecture.md)
- Common usage patterns: [`./docs/cookbook.md`](./docs/cookbook.md)
- Agent entry points: [`./llms.txt`](./llms.txt), [`./llms-full.txt`](./llms-full.txt)
- React wrapper notes: [`./react/README.md`](./react/README.md)

## Common tasks

### 1. Create a local table from an array of objects

```html
<div id="grid"></div>
<script src="./app.js"></script>
<script>
  const rows = [
    { id: 1, name: "Ada", status: "PAID" },
    { id: 2, name: "Linus", status: "HOLD" }
  ];

  const grid = new window.VirtualGridTable("grid", {
    rowHeight: 28,
    visibleCols: 4
  });

  grid.setData(rows);
</script>
```

### 2. Create a table with explicit columns and row arrays

```js
grid.setData({
  columns: [
    { key: "id", label: "Order ID", width: 120 },
    { key: "customer", label: "Customer", width: 220 },
    { key: "total", label: "Total", width: 120 }
  ],
  rows: [
    ["TXN-000001", "Ada Lovelace", "199.95"],
    ["TXN-000002", "Grace Hopper", "89.00"]
  ]
});
```

### 3. Apply local search, sort, and column filters

```js
grid.setSearch("paid");
grid.setSearchColumn(-1); // all columns
grid.sortBy(2, "desc");
grid.setColumnFilter(1, { op: "like", value: "Ada" });
```

### 4. Enable chunked loading

```js
grid.setChunkMode({
  columns: [
    { key: "id", label: "ID" },
    { key: "title", label: "Title" },
    { key: "total", label: "Total" }
  ],
  totalRows: 100000,
  chunkSize: 250,
  async fetchChunk(request) {
    const response = await fetch(`/api/orders?start=${request.start}&size=${request.size}`);
    return response.json();
  }
});
```

### 5. Tear down the instance

```js
grid.destroy();
```

### 6. Use the React wrapper

```jsx
import { VirtualGridTable } from "./react";

export function OrdersGrid({ rows }) {
  return (
    <VirtualGridTable
      style={{ width: "100%", height: 520 }}
      options={{ rowHeight: 28, visibleCols: 6 }}
      data={rows}
    />
  );
}
```

## Gotchas

- The constructor takes a **container element id string**, not an `HTMLElement`.
- The React wrapper handles the id and calls `destroy()` on unmount.
- `setData([])` produces an empty table because columns are inferred from the first object.
- In local mode, row order is `filter -> column filters -> search -> sort`.
- In chunked mode, request objects include `query`, `searchColumn`, `sort`, and `columnFilters`; your provider must apply those server-side if you want matching results.
- `setFilter(fn)` is useful for local mode only. Chunked mode exposes only `hasCustomFilter`, not the function body.
- `setData(...)` clears sort, selection, and scroll state. Search text remains whatever you last set.
- Selecting all cells makes copy include header labels by default.
