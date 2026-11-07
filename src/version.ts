import pkg from "../package.json" with { type: "json" };

/** npm package name, also used as the MCP server name. */
export const PACKAGE_NAME: string = pkg.name;

/** Package version; release-please bumps it in package.json and the bundler inlines it. */
export const VERSION: string = pkg.version;
