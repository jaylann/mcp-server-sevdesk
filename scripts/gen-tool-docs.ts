/**
 * Writes `docs/tools.md`. Usage: `pnpm docs:tools` (then run Prettier, which `pnpm docs:tools`
 * does for you).
 */
import { writeFileSync } from "node:fs";

import { renderToolDocs } from "./tool-docs.js";

const target = new URL("../docs/tools.md", import.meta.url);
writeFileSync(target, renderToolDocs());
console.log(`wrote ${target.pathname}`);
