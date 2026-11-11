/**
 * Writes `src/pages/assets.generated.ts` from `assets/`. Usage: `pnpm pages:assets`, after
 * changing a font or the icon.
 */
import { writeFileSync } from "node:fs";

import { renderAssetsModule } from "./page-assets.js";

const target = new URL("../src/pages/assets.generated.ts", import.meta.url);
writeFileSync(target, renderAssetsModule());
console.log(`wrote ${target.pathname}`);
