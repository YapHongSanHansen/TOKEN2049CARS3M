/**
 * DaisyMarket: a seller's datasets as a white daisy.
 *
 *   petals          the seller's current datasets (hover / tap: title + date, click: details)
 *   fallen petals   archived datasets, faded, lying under the flower (still selectable)
 *   centre          the seller's reputation, coloured by range: 0–49 Bad, 50–75 Intermediate, 76–100 Good
 *
 * Fully controlled: the host passes `active`, `archived` and `reputation`. On an upload, pass the next
 * state from `uploadDataset()` and the flower animates it: the oldest petal detaches and falls, and the
 * new one grows into its place. Transparent background, no layout around it.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import "./daisy.css";

export interface PetalDataset {
  id: string;
  title: string;
  uploadedAt: string | Date;
  description: string;
  /** A short sample of the data, shown in a monospace block. */
  preview: string;
  /** Display price, e.g. "5 USDM". */
  price: string;
  /** When the dataset fell off the flower. Set by `uploadDataset()`. */
  archivedAt?: string | Date;
}
export interface DaisyState { active: PetalDataset[]; archived: PetalDataset[] }
export type PetalKind = "active" | "archived";

export interface DaisyMarketProps extends DaisyState {
  /** Seller reputation, 0–100. */
  reputation: number;
  /** Accessible name for the flower, e.g. "WhaleWatcher's datasets". */
  label?: string;
  className?: string;
  /** Extra controls in a petal's details (e.g. a Buy button). */
  renderActions?: (dataset: PetalDataset, kind: PetalKind) => ReactNode;
  /** Replaces the description + preview block in a petal's details. */
  renderDetails?: (dataset: PetalDataset, kind: PetalKind) => ReactNode;
  /** Called when a petal's details open or close. */
  onSelect?: (dataset: PetalDataset | null, kind?: PetalKind) => void;
}

/** Archives the oldest current dataset and adds the new one, so the petal count stays the same. */
export function uploadDataset(state: DaisyState, dataset: PetalDataset, now: Date = new Date()): DaisyState {
  const oldest = [...state.active].sort((a, b) => time(a.uploadedAt) - time(b.uploadedAt))[0];
  if (!oldest) return { active: [dataset], archived: state.archived };
  return {
    active: [...state.active.filter(d => d !== oldest), dataset],
    archived: [...state.archived, { ...oldest, archivedAt: now.toISOString() }],
  };
}

/** The exact ranges: 0–49 Bad (red), 50–75 Intermediate (amber), 76–100 Good (green). */
export function reputationStatus(reputation: number) {
  const value = Math.round(Math.min(100, Math.max(0, Number.isFinite(reputation) ? reputation : 0)));
  if (value <= 49) return { value, label: "Bad", tone: "bad" } as const;
  if (value <= 75) return { value, label: "Intermediate", tone: "mid" } as const;
  return { value, label: "Good", tone: "good" } as const;
}

// ---- geometry (SVG user units; the SVG scales to its container) -----------------------------------

const VB_W = 420;
const C = { x: 210, y: 200 };
const DISC_R = 50;
const BASE_R = 30; // petals start under the disc
const PETAL_L = 138;
const FLOWER_BOTTOM = C.y + BASE_R + PETAL_L + 8;
const GROUND_TOP = FLOWER_BOTTOM + 46;
const ROW_H = 40;
const FALLEN_SCALE = 0.62;
// Fallen petals lie in a brick pattern (rows of 4 and 3), each row filled centre-out.
const COLS = [[72, 164, 256, 348], [118, 210, 302]];
const FILL_ORDER = [[1, 2, 0, 3], [1, 0, 2]];

const time = (value: string | Date) => new Date(value).getTime();
const tf = (x: number, y: number, rotate: number, scale = 1) => `translate(${x}px, ${y}px) rotate(${rotate}deg) scale(${scale})`;

/** A stable 0..1 value per string, for natural-looking variation. */
function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// Petals touch along their sides, like the reference daisy: the circumference at mid-petal is shared out with almost no gap.
const petalWidth = (count: number) => Math.min(50, Math.max(11, ((2 * Math.PI * (BASE_R + PETAL_L * 0.45)) / Math.max(count, 1)) * 1.02));

/** A slender daisy petal centred on (0, 0): narrow base at +L/2, rounded, faintly notched tip at -L/2. */
function petalPath(length: number, width: number) {
  const h = length / 2;
  const w = width / 2;
  const n = (v: number) => v.toFixed(2);
  return [
    `M 0 ${n(h)}`,
    `C ${n(-w * 0.42)} ${n(h - length * 0.04)}, ${n(-w * 1.04)} ${n(h - length * 0.4)}, ${n(-w)} ${n(-h + length * 0.3)}`,
    `C ${n(-w * 0.98)} ${n(-h + length * 0.1)}, ${n(-w * 0.62)} ${n(-h + 0.4)}, ${n(-w * 0.12)} ${n(-h + 1.2)}`,
    `Q 0 ${n(-h + length * 0.03)}, ${n(w * 0.12)} ${n(-h + 1.2)}`,
    `C ${n(w * 0.62)} ${n(-h + 0.4)}, ${n(w * 0.98)} ${n(-h + length * 0.1)}, ${n(w)} ${n(-h + length * 0.3)}`,
    `C ${n(w * 1.04)} ${n(h - length * 0.4)}, ${n(w * 0.42)} ${n(h - length * 0.04)}, 0 ${n(h)} Z`,
  ].join(" ");
}

function veinPath(length: number, width: number) {
  const h = length / 2;
  const w = width / 2;
  return `M 0 ${h - 6} L 0 ${-h + 9} M ${-w * 0.28} ${h - 8} Q ${-w * 0.5} 0, ${-w * 0.36} ${-h + 14} M ${w * 0.28} ${h - 8} Q ${w * 0.5} 0, ${w * 0.36} ${-h + 14}`;
}

interface SlotGeometry { angle: number; length: number; width: number; back: boolean; dir: { x: number; y: number }; x: number; y: number }

function slotGeometry(slot: number, count: number): SlotGeometry {
  const jitter = (key: string) => hash(`slot:${count}:${slot}:${key}`) - 0.5;
  const angle = (360 / count) * slot + jitter("a") * 5;
  const back = count > 8 && slot % 2 === 1; // alternate petals sit a little behind, like a real daisy
  const length = PETAL_L * (1 + jitter("l") * 0.14) * (back ? 0.93 : 1);
  const width = petalWidth(count) * (1 + jitter("w") * 0.12);
  const rad = (angle * Math.PI) / 180;
  const dir = { x: Math.sin(rad), y: -Math.cos(rad) };
  const r = BASE_R + length / 2;
  return { angle, length, width, back, dir, x: C.x + dir.x * r, y: C.y + dir.y * r };
}

interface FallenGeometry { x: number; y: number; rotation: number; row: number; length: number }

function fallenGeometry(index: number, id: string): FallenGeometry {
  let row = 0;
  let i = index;
  while (i >= COLS[row % 2].length) { i -= COLS[row % 2].length; row++; }
  const jitter = (key: string) => hash(`${id}:${key}`) - 0.5;
  return {
    x: COLS[row % 2][FILL_ORDER[row % 2][i]] + jitter("x") * 8,
    y: GROUND_TOP + row * ROW_H + jitter("y") * 8,
    rotation: (hash(`${id}:side`) < 0.5 ? 90 : -90) + jitter("r") * 28,
    row,
    length: PETAL_L * (1 + jitter("l") * 0.08),
  };
}

/** Keeps each dataset on its petal; a new dataset takes the slot of the one that fell. */
function assignSlots(previous: Map<string, number>, active: PetalDataset[]) {
  const ids = new Set(active.map(d => d.id));
  const byAge = [...active].sort((a, b) => time(a.uploadedAt) - time(b.uploadedAt));
  if (previous.size !== active.length) return new Map(byAge.map((d, i) => [d.id, i]));
  const slots = new Map([...previous].filter(([id]) => ids.has(id)));
  const free = [...previous].filter(([id]) => !ids.has(id)).map(([, slot]) => slot).sort((a, b) => a - b);
  for (const d of byAge) if (!slots.has(d.id)) slots.set(d.id, free.shift()!);
  return slots;
}

function fallKeyframes(from: SlotGeometry, to: FallenGeometry): Keyframe[] {
  const start = from.angle;
  let end = to.rotation;
  while (end - start < 180) end += 360;
  while (end - start > 540) end -= 360;
  const out = { x: from.x + from.dir.x * 14, y: from.y + from.dir.y * 14 };
  const at = (t: number, sway: number) => ({ x: out.x + (to.x - out.x) * t + sway, y: out.y + (to.y - out.y) * t });
  const a = at(0.4, -34);
  const b = at(0.76, 26);
  return [
    { offset: 0, transform: tf(from.x, from.y, start), opacity: 1 },
    { offset: 0.14, transform: tf(out.x, out.y, start + 8), opacity: 1 },
    { offset: 0.45, transform: tf(a.x, a.y, start + (end - start) * 0.42, 0.9), opacity: 0.95 },
    { offset: 0.78, transform: tf(b.x, b.y, start + (end - start) * 0.82, 0.78), opacity: 0.8 },
    { offset: 1, transform: tf(to.x, to.y, end, FALLEN_SCALE), opacity: 0.62 },
  ];
}

// Disc florets in a sunflower spiral: the daisy centre's soft texture.
const FLORETS = Array.from({ length: 420 }, (_, i) => {
  const r = DISC_R * 0.95 * Math.sqrt((i + 0.5) / 420);
  const a = i * 2.39996;
  return { x: C.x + r * Math.cos(a), y: C.y + r * Math.sin(a), r: 1.15 + 1.05 * (r / DISC_R), light: i % 3 === 0 };
});

const DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const formatDate = (value: string | Date) => DATE.format(new Date(value));

function usePrefersReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

// ---- component -----------------------------------------------------------------------------------

interface Entry { key: string; kind: PetalKind; dataset: PetalDataset; anchor: { x: number; y: number } }

export function DaisyMarket({ active, archived, reputation, label = "Datasets", className = "", renderActions, renderDetails, onSelect }: DaisyMarketProps) {
  const uid = `dm${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const reduced = usePrefersReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, SVGGElement>());
  const lastPointer = useRef<string>("mouse");
  const committed = useRef<{ slots: Map<string, number>; ids: Set<string> }>({ slots: new Map(), ids: new Set() });

  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null); // touch: first tap shows the label
  const [selected, setSelected] = useState<string | null>(null);
  const [openedByKey, setOpenedByKey] = useState(false);
  const [roving, setRoving] = useState<Record<PetalKind, string | null>>({ active: null, archived: null });
  const [layoutTick, setLayoutTick] = useState(0);

  const count = active.length;
  const slots = useMemo(() => assignSlots(committed.current.slots, active), [active]);
  const newestId = useMemo(() => [...active].sort((a, b) => time(b.uploadedAt) - time(a.uploadedAt))[0]?.id, [active]);
  const ring = useMemo(() => active
    .map(dataset => ({ dataset, g: slotGeometry(slots.get(dataset.id) ?? 0, count), slot: slots.get(dataset.id) ?? 0 }))
    .sort((a, b) => a.slot - b.slot), [active, slots, count]);
  const fallen = useMemo(() => [...archived]
    .sort((a, b) => time(a.archivedAt ?? a.uploadedAt) - time(b.archivedAt ?? b.uploadedAt))
    .map((dataset, i) => ({ dataset, g: fallenGeometry(i, dataset.id) })), [archived]);
  const rows = fallen.length ? fallen[fallen.length - 1].g.row + 1 : 0;
  const height = rows ? GROUND_TOP + (rows - 1) * ROW_H + 40 : FLOWER_BOTTOM + 12;
  const width = petalWidth(count);
  const rep = reputationStatus(reputation);

  const entries = useMemo(() => {
    const map = new Map<string, Entry>();
    for (const { dataset, g } of ring) {
      const r = BASE_R + g.length + 12;
      map.set(`active:${dataset.id}`, { key: `active:${dataset.id}`, kind: "active", dataset, anchor: { x: C.x + g.dir.x * r, y: C.y + g.dir.y * r } });
    }
    for (const { dataset, g } of fallen) map.set(`archived:${dataset.id}`, { key: `archived:${dataset.id}`, kind: "archived", dataset, anchor: { x: g.x, y: g.y - 20 } });
    return map;
  }, [ring, fallen]);

  // Upload animation: the dataset that left the flower falls to its place below; the new one grows in.
  useLayoutEffect(() => {
    const previous = committed.current;
    const ids = new Set(active.map(d => d.id));
    if (previous.ids.size) {
      const fell = [...previous.ids].filter(id => !ids.has(id));
      const grew = active.filter(d => !previous.ids.has(d.id));
      fell.forEach((id, i) => {
        const el = elements.current.get(`archived:${id}`);
        const slot = previous.slots.get(id);
        const to = fallen.find(f => f.dataset.id === id);
        if (!el || slot === undefined || !to) return;
        if (reduced) { el.animate([{ opacity: 0 }, { opacity: 0.62 }], { duration: 250, fill: "backwards" }); return; }
        el.animate(fallKeyframes(slotGeometry(slot, previous.ids.size), to.g), { duration: 2000, delay: i * 150, easing: "cubic-bezier(.45,.05,.35,1)", fill: "backwards" });
      });
      for (const d of grew) {
        const el = elements.current.get(`active:${d.id}`);
        if (!el) continue;
        const g = slotGeometry(slots.get(d.id) ?? 0, count);
        if (reduced) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, delay: fell.length ? 200 : 0, fill: "backwards" }); continue; }
        el.animate([
          { transform: tf(C.x + g.dir.x * BASE_R, C.y + g.dir.y * BASE_R, g.angle, 0.02), opacity: 0.3 },
          { transform: tf(g.x, g.y, g.angle, 1), opacity: 1 },
        ], { duration: 1100, delay: fell.length ? 850 : 0, easing: "cubic-bezier(.2,.75,.25,1)", fill: "backwards" });
      }
    }
    committed.current = { slots, ids };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback((returnFocus: boolean) => {
    const key = selected;
    setSelected(null);
    setOpenedByKey(false);
    onSelect?.(null);
    if (returnFocus && key) elements.current.get(key)?.focus();
  }, [selected, onSelect]);

  const toggle = (entry: Entry, byKeyboard: boolean) => {
    setPeek(null);
    if (selected === entry.key) { close(byKeyboard); return; }
    setSelected(entry.key);
    setOpenedByKey(byKeyboard);
    onSelect?.(entry.dataset, entry.kind);
  };

  // A selected petal that left (or a removed dataset) closes its details.
  useEffect(() => { if (selected && !entries.has(selected)) { setSelected(null); onSelect?.(null); } }, [entries, selected, onSelect]);

  // Click outside closes the details.
  useEffect(() => {
    if (!selected) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (popRef.current?.contains(target) || (rootRef.current?.contains(target) && target.closest("[data-petal]"))) return;
      close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [selected, close]);

  // Re-place the tooltip / details when the flower resizes.
  useEffect(() => {
    if (!rootRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setLayoutTick(t => t + 1));
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, []);

  const tipKey = [hovered, peek, focused].find(k => k && k !== selected && entries.has(k)) ?? null;
  const tip = tipKey ? entries.get(tipKey)! : null;
  const open = selected ? entries.get(selected) ?? null : null;

  // Position a floating box near its petal, kept inside the flower's width.
  const place = useCallback((box: HTMLElement | null, entry: Entry | null, gap: number) => {
    const root = rootRef.current;
    if (!box || !root || !entry) return;
    const scale = root.clientWidth / VB_W;
    const ax = entry.anchor.x * scale;
    const ay = entry.anchor.y * scale;
    const { width: w, height: h } = box.getBoundingClientRect();
    const below = entry.kind === "active" && entry.anchor.y > C.y; // away from the flower
    const left = Math.min(Math.max(ax - w / 2, 4), Math.max(4, root.clientWidth - w - 4));
    let top = below ? ay + gap : ay - h - gap;
    if (!below && top < 0) top = ay + gap;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.visibility = "visible";
  }, []);
  useLayoutEffect(() => place(tipRef.current, tip, 8), [tip, place, layoutTick]);
  useLayoutEffect(() => place(popRef.current, open, 10), [open, place, layoutTick]);
  useEffect(() => { if (open && openedByKey) popRef.current?.focus(); }, [open, openedByKey]);

  const ordered: Record<PetalKind, string[]> = {
    active: ring.map(r => `active:${r.dataset.id}`),
    archived: fallen.map(f => `archived:${f.dataset.id}`),
  };
  const tabStop = (kind: PetalKind) => {
    const keys = ordered[kind];
    const current = roving[kind];
    return current && keys.includes(current) ? current : keys[0];
  };

  const onPetalKey = (event: KeyboardEvent<SVGGElement>, entry: Entry) => {
    const keys = ordered[entry.kind];
    const index = keys.indexOf(entry.key);
    const moveTo = (i: number) => {
      const key = keys[(i + keys.length) % keys.length];
      setRoving(r => ({ ...r, [entry.kind]: key }));
      elements.current.get(key)?.focus();
    };
    switch (event.key) {
      case "ArrowRight": case "ArrowDown": event.preventDefault(); moveTo(index + 1); break;
      case "ArrowLeft": case "ArrowUp": event.preventDefault(); moveTo(index - 1); break;
      case "Home": event.preventDefault(); moveTo(0); break;
      case "End": event.preventDefault(); moveTo(keys.length - 1); break;
      case "Enter": case " ": event.preventDefault(); toggle(entry, true); break;
      case "Escape": if (selected) { event.preventDefault(); close(true); } else setPeek(null); break;
    }
  };

  const petalProps = (entry: Entry) => ({
    ref: (el: SVGGElement | null) => { if (el) elements.current.set(entry.key, el); else elements.current.delete(entry.key); },
    "data-petal": entry.kind,
    role: "button",
    tabIndex: tabStop(entry.kind) === entry.key ? 0 : -1,
    "aria-label": `${entry.kind === "archived" ? "Archived dataset" : "Dataset"}: ${entry.dataset.title}, uploaded ${formatDate(entry.dataset.uploadedAt)}${entry.dataset.id === newestId && entry.kind === "active" ? ", newest" : ""}`,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": selected === entry.key,
    "aria-describedby": tipKey === entry.key ? `${uid}-tip` : undefined,
    onPointerDown: (e: React.PointerEvent) => { lastPointer.current = e.pointerType; },
    onPointerEnter: (e: React.PointerEvent) => { if (e.pointerType === "mouse") setHovered(entry.key); },
    onPointerLeave: (e: React.PointerEvent) => { if (e.pointerType === "mouse") setHovered(h => (h === entry.key ? null : h)); },
    onFocus: () => { setFocused(entry.key); setRoving(r => ({ ...r, [entry.kind]: entry.key })); },
    onBlur: () => setFocused(f => (f === entry.key ? null : f)),
    onClick: () => {
      if (lastPointer.current === "touch" && peek !== entry.key && selected !== entry.key) { setPeek(entry.key); return; }
      toggle(entry, false);
    },
    onKeyDown: (e: KeyboardEvent<SVGGElement>) => onPetalKey(e, entry),
  });
  const state = (key: string) => [selected === key && "is-selected", (hovered === key || peek === key) && "is-hover"].filter(Boolean).join(" ");

  return (
    <div ref={rootRef} className={`dm-root ${className}`}>
      <svg className="dm-svg" viewBox={`0 0 ${VB_W} ${height}`} role="group" aria-label={`${label}: ${count} current, ${archived.length} archived. Seller reputation ${rep.value}% · ${rep.label}`}>
        <defs>
          <linearGradient id={`${uid}-front`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#dfe3d8" /><stop offset=".22" stopColor="#f6f7f3" /><stop offset="1" stopColor="#ffffff" />
          </linearGradient>
          <linearGradient id={`${uid}-back`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#d2d7cc" /><stop offset=".3" stopColor="#eeeee9" /><stop offset="1" stopColor="#fbfbf8" />
          </linearGradient>
          <linearGradient id={`${uid}-fallen`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#d3d4c6" /><stop offset=".4" stopColor="#e6e6de" /><stop offset="1" stopColor="#f1f1ec" />
          </linearGradient>
          <radialGradient id={`${uid}-dome`} cx=".38" cy=".32" r=".75">
            <stop offset="0" stopColor="#fff" stopOpacity=".45" /><stop offset=".45" stopColor="#fff" stopOpacity=".06" /><stop offset="1" stopColor="#000" stopOpacity=".3" />
          </radialGradient>
        </defs>


        {fallen.map(({ dataset, g }) => {
          const entry = entries.get(`archived:${dataset.id}`)!;
          const lift = hovered === entry.key || peek === entry.key || selected === entry.key ? 1.06 : 1;
          return (
            <g key={entry.key} {...petalProps(entry)} className={`dm-petal dm-fallen ${state(entry.key)}`} style={{ transform: tf(g.x, g.y, g.rotation, FALLEN_SCALE * lift) }}>
              <rect className="dm-hit" fill="transparent" x={-width * 0.7} y={-g.length / 2} width={width * 1.4} height={g.length} />
              <path className="dm-shadow" d={petalPath(g.length, width)} />
              <path className="dm-shape" d={petalPath(g.length, width)} fill={`url(#${uid}-fallen)`} />
              <path className="dm-veins" d={veinPath(g.length, width)} />
            </g>
          );
        })}

        {[...ring].sort((a, b) => Number(b.g.back) - Number(a.g.back)).map(({ dataset, g }) => {
          const entry = entries.get(`active:${dataset.id}`)!;
          const up = hovered === entry.key || peek === entry.key || selected === entry.key ? 6 : 0;
          const d = petalPath(g.length, g.width);
          return (
            <g key={entry.key} {...petalProps(entry)} className={`dm-petal ${state(entry.key)}`} style={{ transform: tf(g.x + g.dir.x * up, g.y + g.dir.y * up, g.angle, up ? 1.03 : 1) }}>
              <rect className="dm-hit" fill="transparent" x={-g.width * 0.65} y={-g.length / 2} width={g.width * 1.3} height={g.length} />
              {dataset.id === newestId && <><path className="dm-halo dm-halo-wide" d={d} /><path className="dm-halo" d={d} /></>}
              <path className="dm-shadow" d={d} />
              <path className="dm-shape" d={d} fill={`url(#${uid}-${g.back ? "back" : "front"})`} />
              <path className="dm-veins" d={veinPath(g.length, g.width)} />
            </g>
          );
        })}

        <g className={`dm-disc dm-${rep.tone}`} role="img" aria-label={`Seller reputation ${rep.value}% · ${rep.label}`}>
          <circle className="dm-shadow" cx={C.x} cy={C.y + 2} r={DISC_R + 1} />
          <circle className="dm-disc-base" cx={C.x} cy={C.y} r={DISC_R} />
          {FLORETS.map((f, i) => <circle key={i} className={f.light ? "dm-floret-a" : "dm-floret-b"} cx={f.x} cy={f.y} r={f.r} />)}
          <circle cx={C.x} cy={C.y} r={DISC_R} fill={`url(#${uid}-dome)`} />
          <circle className="dm-disc-rim" cx={C.x} cy={C.y} r={DISC_R - 0.75} />
          <text className="dm-rep" x={C.x} y={C.y + 4}>{rep.value}%</text>
          <text className="dm-rep-status" x={C.x} y={C.y + 21}>{rep.label}</text>
        </g>
      </svg>

      {tip && (
        <div ref={tipRef} id={`${uid}-tip`} role="tooltip" className="dm-tip" style={{ visibility: "hidden" }}>
          <strong>{tip.dataset.title}</strong>
          <span>{tip.kind === "archived" ? "Archived · uploaded " : "Uploaded "}{formatDate(tip.dataset.uploadedAt)}</span>
          {peek === tip.key && <span className="dm-tip-hint">Tap again for details</span>}
        </div>
      )}

      {open && (
        <div ref={popRef} className="dm-pop" role="dialog" aria-labelledby={`${uid}-pop-title`} tabIndex={-1} style={{ visibility: "hidden" }}
          onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); close(true); } }}>
          <div className="dm-pop-head">
            <span className={`dm-tag dm-tag-${open.kind === "archived" ? "archived" : open.dataset.id === newestId ? "new" : "current"}`}>
              {open.kind === "archived" ? "Archived" : open.dataset.id === newestId ? "Newest" : "Current"}
            </span>
            <button type="button" className="dm-close" aria-label="Close details" onClick={() => close(true)}>×</button>
          </div>
          <h4 id={`${uid}-pop-title`}>{open.dataset.title}</h4>
          <p className="dm-date">
            Uploaded {formatDate(open.dataset.uploadedAt)}
            {open.kind === "archived" && open.dataset.archivedAt && <> · archived {formatDate(open.dataset.archivedAt)}</>}
          </p>
          {renderDetails ? renderDetails(open.dataset, open.kind) : (
            <>
              <p className="dm-desc">{open.dataset.description}</p>
              <pre className="dm-preview" aria-label="Preview">{open.dataset.preview}</pre>
            </>
          )}
          <div className="dm-pop-foot">
            <span className="dm-price">{open.dataset.price}</span>
            {renderActions?.(open.dataset, open.kind)}
          </div>
        </div>
      )}
    </div>
  );
}
