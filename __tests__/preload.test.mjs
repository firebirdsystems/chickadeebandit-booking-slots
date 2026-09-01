import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const html = readFileSync(join(__dirname, "../src/index.html"), "utf-8");
const norm = (s) => s.replace(/\s+/g, " ").trim();

// The hub runs `manifest.preload` while rendering the document and answers the
// app's matching api/db request from the embedded rows — matching on the
// statement text with whitespace collapsed. A drifted copy is not an error
// anywhere: it is a preload that silently never answers. So the manifest is
// checked against the source here.
describe("manifest.preload mirrors the app's first-render reads", () => {
  const body = norm(html);
  const prefix = `app_${manifest.id.replace(/-/g, "_")}__`;

  // Every first-render read here goes through dbAll(), which pages: the request
  // it actually posts is `<sql> LIMIT <DB_PAGE_SIZE> OFFSET 0`, not `<sql>`.
  //
  // This test used to ask only whether the declared text APPEARED in the source,
  // and a declared statement is trivially a substring of itself-plus-a-LIMIT —
  // so it passed for a long time while both preloads declared the un-paged text
  // and therefore never answered a single request. The hub ran them server-side
  // on every launch and the app fetched everything over the network anyway.
  // Pin the whole composition instead of a prefix of it.
  const PAGE_SIZE = Number(/const DB_PAGE_SIZE = (\d+)/.exec(html)?.[1]);

  it("agrees with dbAll's page size", () => {
    expect(PAGE_SIZE, "DB_PAGE_SIZE not found in src/index.html").toBeGreaterThan(0);
  });

  it("declares exactly the paged statement the app posts for the first page", () => {
    const suffix = ` LIMIT ${PAGE_SIZE} OFFSET 0`;
    for (const [name, { sql }] of Object.entries(manifest.preload)) {
      const declared = norm(sql);
      expect(declared.endsWith(suffix), `preload.${name} must be a dbAll first page (…${suffix})`).toBe(true);
      // The base statement has to appear as a whole dbAll() argument, not merely
      // somewhere in the file — that is what makes this a byte-for-byte check.
      const base = declared.slice(0, -suffix.length);
      expect(body.includes(`dbAll("${base}")`), `preload.${name} is not a statement src/index.html posts`).toBe(true);
    }
  });

  it("stays within the hub's caps and reads only this app's tables", () => {
    expect(Object.keys(manifest.preload).length).toBeLessThanOrEqual(6);
    for (const [name, { sql, params = [] }] of Object.entries(manifest.preload)) {
      expect(sql, name).toMatch(/^(SELECT|WITH) /);
      expect(sql, name).not.toMatch(/;|--/);
      for (const table of sql.match(/(?:FROM|JOIN)\s+(\w+)/g) ?? []) expect(table, name).toMatch(new RegExp(`\\s${prefix}`));
      expect((sql.match(/\?/g) ?? []).length, `${name}: placeholders vs params`).toBe(params.length);
    }
  });
});
