import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

const scriptLoaders = new Map();

function loadScript(src) {
  if (!src) return Promise.resolve();
  if (scriptLoaders.has(src)) return scriptLoaders.get(src);

  const promise = new Promise((resolve, reject) => {
    const existing = Array.from(document.scripts).find((script) => script.dataset.vgtReactSrc === src);
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.vgtReactSrc = src;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true }
    );
    script.addEventListener("error", reject, { once: true });
    document.head.append(script);
  });

  scriptLoaders.set(src, promise);
  return promise;
}

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

async function resolveGridClass({ scriptSrc, VirtualGridTableClass }) {
  if (VirtualGridTableClass) return VirtualGridTableClass;
  if (typeof window === "undefined") return null;
  if (window.VirtualGridTable) return window.VirtualGridTable;

  await loadScript(scriptSrc);
  return window.VirtualGridTable || null;
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
    scriptSrc,
    VirtualGridTableClass,
    onReady,
    onError,
    ...divProps
  },
  ref
) {
  const generatedId = useId();
  const gridId = useMemo(() => id || `vgt-react-${normalizeReactId(generatedId)}`, [generatedId, id]);
  const instanceRef = useRef(null);
  const [instance, setInstance] = useState(null);
  const [mountError, setMountError] = useState(null);

  useImperativeHandle(ref, () => instance, [instance]);

  if (mountError) throw mountError;

  useEffect(() => {
    let cancelled = false;

    resolveGridClass({ scriptSrc, VirtualGridTableClass })
      .then((GridClass) => {
        if (cancelled) return;
        if (!GridClass) {
          throw new Error(
            "VirtualGridTable React wrapper requires window.VirtualGridTable, a scriptSrc, or VirtualGridTableClass."
          );
        }

        const grid = new GridClass(gridId, options);
        instanceRef.current = grid;
        setInstance(grid);
        if (typeof onReady === "function") onReady(grid);
      })
      .catch((error) => {
        if (cancelled) return;
        if (typeof onError === "function") onError(error);
        else setMountError(error);
      });

    return () => {
      cancelled = true;
      if (instanceRef.current) {
        instanceRef.current.destroy();
        instanceRef.current = null;
      }
    };
  }, [VirtualGridTableClass, gridId, scriptSrc]);

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
