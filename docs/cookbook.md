# VirtualGridTable cookbook

## Recipe: mount a local table from object rows

```html
<div id="grid"></div>
<script src="./app.js"></script>
<script>
  const grid = new window.VirtualGridTable("grid", {
    rowHeight: 28,
    visibleCols: 5
  });

  grid.setData([
    { id: "TXN-1", customer: "Ada Lovelace", status: "PAID", total: "199.00" },
    { id: "TXN-2", customer: "Grace Hopper", status: "HOLD", total: "89.00" }
  ]);
</script>
```

## Recipe: use explicit columns with row arrays

```js
const grid = new window.VirtualGridTable("grid");

grid.setData({
  columns: [
    { key: "id", label: "Order ID", width: 120 },
    { key: "customer", label: "Customer", width: 220 },
    { key: "status", label: "Status", width: 120 },
    { key: "total", label: "Total", width: 100 }
  ],
  rows: [
    ["TXN-1", "Ada Lovelace", "PAID", "199.00"],
    ["TXN-2", "Grace Hopper", "HOLD", "89.00"]
  ]
});
```

## Recipe: search all columns, then narrow to one column

```js
grid.setSearch("ada");
grid.setSearchColumn(-1);

grid.setSearch("paid");
grid.setSearchColumn(2);
```

## Recipe: combine local custom filtering, column filters, and sort

```js
grid.setFilter((row) => Number(row[3]) >= 50);
grid.setColumnFilter(2, { op: "not", value: "REFUNDED" });
grid.sortBy(3, "desc");
```

## Recipe: provide chunked data with `fetchChunk`

```js
const grid = new window.VirtualGridTable("grid", { rowHeight: 28, overscan: 2 });

grid.setChunkMode({
  columns: [
    { key: "id", label: "ID" },
    { key: "customer", label: "Customer" },
    { key: "status", label: "Status" },
    { key: "total", label: "Total" }
  ],
  totalRows: 0,
  chunkSize: 200,
  async fetchChunk(request) {
    const params = new URLSearchParams({
      start: String(request.start),
      size: String(request.size),
      query: request.query,
      searchColumn: String(request.searchColumn)
    });

    if (request.sort) {
      params.set("sortCol", String(request.sort.colIndex));
      params.set("sortDir", request.sort.dir);
    }

    const response = await fetch(`/api/orders?${params}`);
    return response.json();
  }
});
```

## Recipe: feed chunks manually from the `vgt:chunk-request` event

```js
const host = document.getElementById("grid");
const grid = new window.VirtualGridTable("grid");

host.addEventListener("vgt:chunk-request", async (event) => {
  const request = event.detail;
  const response = await fetch(`/api/orders?start=${request.start}&size=${request.size}`);
  const payload = await response.json();
  grid.setChunkRows(payload.start ?? request.start, payload.rows, payload.totalRows);
});

grid.setChunkMode({
  columns: ["id", "customer", "status", "total"],
  totalRows: 100000,
  chunkSize: 250
});
```

## Recipe: switch the demo page theme

```js
window.setAppTheme("light");
window.setAppTheme("chrome-dark");
window.setAppTheme("warm");
window.setAppTheme("aurora");
```

## Recipe: read scroll offsets

```js
const offsets = grid.getOffsets();
console.log(offsets.rowPx, offsets.rowStart, offsets.colPx, offsets.colStart);
```

## Recipe: destroy the table when the host view unmounts

```js
grid.destroy();
```
