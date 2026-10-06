// @openuidev/react-lang mounts a devtools widget (loaded from a CDN) in dev unless this flag is set
// before the package is evaluated. Imports are hoisted, so this must be main.tsx's first import.
(globalThis as Record<symbol, unknown>)[Symbol.for("openui.devtools.autoMount")] = true;
