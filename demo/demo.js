import { VirtualGridTable, normalizeThemeMode, setAppTheme } from "../src/index.js";

window.VirtualGridTable = VirtualGridTable;
window.setAppTheme = setAppTheme;

function demoConditionalFormats(themeMode) {
  const theme = normalizeThemeMode(themeMode);
  if (theme === "light") {
    return [
      { colIndex: 5, op: ">", value: "1200", backgroundColor: "#dff7ea", color: "#145c3d" },
      { colIndex: 8, op: "=", value: "HOLD", backgroundColor: "#fff1c2", color: "#6b4500" },
      { colIndex: 8, op: "=", value: "REFUNDED", backgroundColor: "#eadcff", color: "#4f2f83" },
    ];
  }
  if (theme === "warm") {
    return [
      { colIndex: 5, op: ">", value: "1200", backgroundColor: "#4a301d", color: "#ffd9ac" },
      { colIndex: 8, op: "=", value: "HOLD", backgroundColor: "#5a2c15", color: "#ffe0bc" },
      { colIndex: 8, op: "=", value: "REFUNDED", backgroundColor: "#49321b", color: "#ffe5bf" },
    ];
  }
  if (theme === "aurora") {
    return [
      { colIndex: 5, op: ">", value: "1200", backgroundColor: "#15384a", color: "#dff8ff" },
      { colIndex: 8, op: "=", value: "HOLD", backgroundColor: "#34405f", color: "#e8efff" },
      { colIndex: 8, op: "=", value: "REFUNDED", backgroundColor: "#20304d", color: "#dcecff" },
    ];
  }
  return [
    { colIndex: 5, op: ">", value: "1200", backgroundColor: "#173b2f", color: "#b7f7d8" },
    { colIndex: 8, op: "=", value: "HOLD", backgroundColor: "#4a1b1f", color: "#ffd0d7" },
    { colIndex: 8, op: "=", value: "REFUNDED", backgroundColor: "#332047", color: "#ead7ff" },
  ];
}

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
  const repFirstNames = ["Cass", "Juno", "Milo", "Tess", "Rex", "Poppy", "Dax", "Vera", "Nico", "Lux", "Ivy", "Otto"];
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
});

grid.setLoading(true);

const demo = [];
for (let i = 0; i < 50000; i += 1) {
  demo.push(buildDemoTransaction(i));
}

setTimeout(() => {
  grid.setData(demo);
  grid.setConditionalFormats(demoConditionalFormats(grid._readThemeMode()));
  grid.setLoading(false);
}, 250);
