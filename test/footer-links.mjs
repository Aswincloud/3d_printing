// The footer links every customer page carries: Track your order and the Amazon
// storefront. A plain file check — these are static HTML and one template.
import { readFileSync, readdirSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const AMZ = "https://www.amazon.in/storefront?me=AB6RDVHBOORX4";
const pages = readdirSync(new URL("../public/", import.meta.url)).filter((f) => f.endsWith(".html") && f !== "shop.html")
  .map((f) => [f, readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8")]);
pages.push(["src/pdp.js (product pages)", readFileSync(new URL("../src/pdp.js", import.meta.url), "utf8")]);

console.log("\nfooter links on every customer page");
for (const [name, html] of pages) {
  const foot = html.slice(html.lastIndexOf("<footer"));
  ok(`${name}: Track your order`, foot.includes('href="/track"'));
  const a = foot.match(new RegExp(`<a href="${AMZ.replace(/[.?]/g, "\\$&")}"[^>]*>`));
  ok(`${name}: Amazon storefront, new tab, noopener`, a && /target="_blank"/.test(a[0]) && /rel="noopener"/.test(a[0]), a?.[0]);
}
const dash = readFileSync(new URL("../public/shop.html", import.meta.url), "utf8");
ok("the owner dashboard carries no storefront link", !dash.includes("AB6RDVHBOORX4"));
const all = pages.map(([, h]) => h).join("");
ok("no share-tracking tag (ref_=) in any link", !/AB6RDVHBOORX4[^"]*ref_/.test(all));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
