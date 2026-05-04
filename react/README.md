# React wrapper

This folder contains a small React lifecycle wrapper around the core `VirtualGridTable` class. It does not fork table behavior; it creates, updates, exposes, and destroys the imperative instance from React.

Include the core CSS somewhere in your app:

```js
import "../theme.css";
import "../styles.css";
```

Use the wrapper:

```jsx
import { VirtualGridTable } from "./react";

export function OrdersGrid({ rows }) {
  return (
    <VirtualGridTable
      style={{ width: "100%", height: 520 }}
      options={{ rowHeight: 28, visibleCols: 6, editable: true }}
      data={rows}
      searchColumn={-1}
    />
  );
}
```

The forwarded ref is the underlying `VirtualGridTable` instance:

```jsx
const gridRef = useRef(null);

<VirtualGridTable ref={gridRef} data={rows} />;

gridRef.current?.sortBy(2, "desc");
```

Props mapped to table methods:

- `data` -> `setData(data)`
- `chunkMode` -> `setChunkMode(config)`
- `loading` -> `setLoading(boolean)`
- `search` -> `setSearch(string)`
- `searchColumn` -> `setSearchColumn(indexOrAll)`
- `filter` -> `setFilter(fn)` or `clearFilter()`
- `columnFilters` -> `clearColumnFilters()` then `setColumnFilter(...)`
- `conditionalFormats` -> `setConditionalFormats(...)` or `clearConditionalFormats()`
- `cellClass` -> `setCellClass(fn)`
- `editable` -> `setEditable(boolean)`

`options` are read when the component mounts. Pass a different `key` to the component if you need to recreate the table with different constructor options.
