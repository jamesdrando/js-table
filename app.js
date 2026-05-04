import {
  VirtualGridTable,
  defaultConditionalFormatColors,
  normalizeThemeMode,
  setAppTheme,
} from "./src/index.js";

if (typeof window !== "undefined") {
  window.VirtualGridTable = VirtualGridTable;
  window.defaultVirtualGridTableConditionalFormatColors = defaultConditionalFormatColors;
  window.normalizeVirtualGridTableThemeMode = normalizeThemeMode;
  window.setAppTheme = setAppTheme;
}

export {
  VirtualGridTable,
  defaultConditionalFormatColors,
  normalizeThemeMode,
  setAppTheme,
};
