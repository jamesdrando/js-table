import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { VirtualGridTable as CoreVirtualGridTable } from "../src/index.js";

function normalizeReactId(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

function eachColumnFilter(columnFilters, apply) {
  if (!columnFilters) return;

  if (columnFilters instanceof Map) {
    columnFilters.forEach((filterSpec, colIndex) => apply(Number(colIndex), filterSpec));
    return;
  }

  if (Array.isArray(columnFilters)) {
    columnFilters.forEach((filterSpec) => {
      if (!filterSpec) return;
      apply(Number(filterSpec.colIndex), filterSpec);
    });
    return;
  }

  Object.entries(columnFilters).forEach(([colIndex, filterSpec]) => {
    apply(Number(colIndex), filterSpec);
  });
}

export const VirtualGridTable = forwardRef(function VirtualGridTable(
  {
    id,
    className,
    style,
    options = {},
    data,
    chunkMode,
    loading,
    search,
    searchColumn,
    filter,
    columnFilters,
    conditionalFormats,
    cellClass,
    editable,
    VirtualGridTableClass,
    onReady,
    ...divProps
  },
  ref
) {
  const generatedId = useId();
  const gridId = useMemo(() => id || `vgt-react-${normalizeReactId(generatedId)}`, [generatedId, id]);
  const instanceRef = useRef(null);
  const [instance, setInstance] = useState(null);

  useImperativeHandle(ref, () => instance, [instance]);

  useEffect(() => {
    const GridClass = VirtualGridTableClass || CoreVirtualGridTable;
    const grid = new GridClass(gridId, options);
    instanceRef.current = grid;
    setInstance(grid);
    if (typeof onReady === "function") onReady(grid);

    return () => {
      if (instanceRef.current) {
        instanceRef.current.destroy();
        instanceRef.current = null;
        setInstance(null);
      }
    };
  }, [VirtualGridTableClass, gridId]);

  useEffect(() => {
    if (!instance || chunkMode == null) return;
    instance.setChunkMode(chunkMode);
  }, [chunkMode, instance]);

  useEffect(() => {
    if (!instance || data === undefined || chunkMode != null) return;
    instance.setData(data);
  }, [chunkMode, data, instance]);

  useEffect(() => {
    if (!instance || loading === undefined) return;
    instance.setLoading(Boolean(loading));
  }, [instance, loading]);

  useEffect(() => {
    if (!instance || search === undefined) return;
    instance.setSearch(search);
  }, [instance, search]);

  useEffect(() => {
    if (!instance || searchColumn === undefined) return;
    instance.setSearchColumn(searchColumn);
  }, [instance, searchColumn]);

  useEffect(() => {
    if (!instance || filter === undefined) return;
    if (typeof filter === "function") instance.setFilter(filter);
    else instance.clearFilter();
  }, [filter, instance]);

  useEffect(() => {
    if (!instance || columnFilters === undefined) return;
    instance.clearColumnFilters();
    eachColumnFilter(columnFilters, (colIndex, filterSpec) => {
      if (Number.isFinite(colIndex)) instance.setColumnFilter(colIndex, filterSpec);
    });
  }, [columnFilters, instance]);

  useEffect(() => {
    if (!instance || conditionalFormats === undefined) return;
    if (conditionalFormats == null) instance.clearConditionalFormats();
    else instance.setConditionalFormats(conditionalFormats);
  }, [conditionalFormats, instance]);

  useEffect(() => {
    if (!instance || cellClass === undefined) return;
    instance.setCellClass(cellClass);
  }, [cellClass, instance]);

  useEffect(() => {
    if (!instance || editable === undefined) return;
    instance.setEditable(Boolean(editable));
  }, [editable, instance]);

  return <div id={gridId} className={className} style={style} {...divProps} />;
});

export default VirtualGridTable;
