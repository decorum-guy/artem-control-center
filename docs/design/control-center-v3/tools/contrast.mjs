// WCAG 2.x contrast check for the V3 starting tokens (task section 3.1/3.2).
// node docs/design/control-center-v3/tools/contrast.mjs  -> Markdown tables on stdout.
// Text needs >= 4.5:1, meaningful lines/icons >= 3:1 (task section 3.2).
const night = {
  bg: { canvas: "#05070c", rail: "#0a0e16", "surface-1": "#0d121c", "surface-2": "#121927", interactive: "#182132", hover: "#1e2a3f" },
  fg: {
    text: "#eaf2ff", "text-secondary": "#a9b8d0", "text-muted": "#7385a0", "text-disabled": "#4d5b73",
    accent: "#35d6ff", "accent-strong": "#7ae7ff", focus: "#9bedff", heat: "#ffb454",
    success: "#3ee6a5", warning: "#ffc15a", danger: "#ff6b7a", stale: "#c9a878",
    offline: "#8794aa", unavailable: "#8e8698", uncertain: "#9aa9ff"
  },
  pairs: [["on-accent", "#031018", "accent", "#35d6ff"]]
};
const day = {
  bg: { canvas: "#eef2f7", "surface-1": "#ffffff", "surface-2": "#f5f8fc", interactive: "#e8eef6" },
  fg: {
    text: "#0c1626", "text-secondary": "#42526b", "text-muted": "#5f6f88",
    accent: "#0079a8", heat: "#b86a00", success: "#0e8a5f", warning: "#9a6200", danger: "#c7334a"
  },
  pairs: [["on-accent", "#ffffff", "accent", "#0079a8"]]
};

function channel(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
// Status background = 12% of the status colour over surface-1 (task 3.1).
function mix(fgHex, bgHex, share) {
  const f = Number.parseInt(fgHex.slice(1), 16);
  const b = Number.parseInt(bgHex.slice(1), 16);
  const part = (shift) => Math.round(((f >> shift) & 255) * share + ((b >> shift) & 255) * (1 - share));
  return `#${[16, 8, 0].map((shift) => part(shift).toString(16).padStart(2, "0")).join("")}`;
}
function verdict(value, isText) {
  if (value >= 4.5) return "text ok";
  if (value >= 3) return isText ? "**lines only (<4.5)**" : "lines ok";
  return "**FAIL (<3)**";
}

for (const [name, theme] of [["Night", night], ["Day", day]]) {
  const bgNames = Object.keys(theme.bg);
  console.log(`\n### ${name}: foreground vs background\n`);
  console.log(`| token | ${bgNames.join(" | ")} | worst | verdict |`);
  console.log(`|---|${bgNames.map(() => "---:").join("|")}|---:|---|`);
  for (const [fgName, fgHex] of Object.entries(theme.fg)) {
    const values = bgNames.map((bgName) => ratio(fgHex, theme.bg[bgName]));
    const worst = Math.min(...values);
    const isText = fgName.startsWith("text") && fgName !== "text-disabled";
    console.log(`| ${fgName} ${fgHex} | ${values.map((v) => v.toFixed(2)).join(" | ")} | ${worst.toFixed(2)} | ${fgName === "text-disabled" ? "disabled (exempt)" : verdict(worst, isText)} |`);
  }
  console.log(`\n${name}: status text on its own 12% tint over surface-1\n`);
  console.log("| status | tint | ratio | verdict |");
  console.log("|---|---|---:|---|");
  for (const status of ["accent", "heat", "success", "warning", "danger", "stale", "offline", "unavailable", "uncertain"]) {
    const hex = theme.fg[status];
    if (!hex) continue;
    const tint = mix(hex, theme.bg["surface-1"], 0.12);
    const value = ratio(hex, tint);
    console.log(`| ${status} ${hex} | ${tint} | ${value.toFixed(2)} | ${verdict(value, true)} |`);
  }
  for (const [fgName, fgHex, bgName, bgHex] of theme.pairs) {
    const value = ratio(fgHex, bgHex);
    console.log(`\n${name}: ${fgName} ${fgHex} on ${bgName} ${bgHex} = ${value.toFixed(2)} (${verdict(value, true)})`);
  }
  // Proposal: nearest value (mixing towards white at night, black by day) that reaches
  // 4.6:1 against every background and against its own 12% tint. Review visually.
  console.log(`\n${name}: proposed text-safe values (target 4.6:1 on all backgrounds and own tint)\n`);
  console.log("| token | start | proposed | worst after |");
  console.log("|---|---|---|---:|");
  const towards = name === "Night" ? "#ffffff" : "#000000";
  for (const [fgName, fgHex] of Object.entries(theme.fg)) {
    if (fgName === "text-disabled") continue;
    const worstFor = (hex) => Math.min(
      ...Object.values(theme.bg).map((bg) => ratio(hex, bg)),
      ratio(hex, mix(hex, theme.bg["surface-1"], 0.12))
    );
    if (worstFor(fgHex) >= 4.5) continue;
    let candidate = fgHex;
    for (let share = 0.01; share <= 1 && worstFor(candidate) < 4.6; share += 0.01) candidate = mix(towards, fgHex, share);
    console.log(`| ${fgName} | ${fgHex} | ${candidate} | ${worstFor(candidate).toFixed(2)} |`);
  }
}
