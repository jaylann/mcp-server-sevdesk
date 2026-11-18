/**
 * Writes `src/pages/styles.generated.ts` from `src/pages/pages.css` and the installed
 * `@lanfermann/ui`. Usage: `pnpm pages:css`, after changing the page stylesheet or updating the
 * design system.
 */
import { writeFileSync } from "node:fs";

import { renderStylesModule } from "./page-css.js";

const target = new URL("../src/pages/styles.generated.ts", import.meta.url);
writeFileSync(target, await renderStylesModule());
console.log(`wrote ${target.pathname}`);
