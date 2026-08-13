import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const DIR='/home/aswin/3d_printing/print';
const qr=readFileSync(`${DIR}/qr.svg`,'utf8');
const html=readFileSync(`${DIR}/card.html`,'utf8').replace('<!--QR-->',qr);
const b=await chromium.launch();
const p=await b.newPage();
await p.setContent(html,{waitUntil:'load'});
await p.emulateMedia({ media: 'print' });
await p.evaluate(()=>document.fonts.ready);
await p.waitForTimeout(400);
const r=await p.evaluate(()=>{
  const mm=96/25.4;
  const de=document.documentElement, bd=document.body;
  const out={
    htmlScrollW: de.scrollWidth/mm, htmlClientW: de.clientWidth/mm,
    bodyScrollW: bd.scrollWidth/mm, bodyClientW: bd.clientWidth/mm,
    htmlScrollH: de.scrollHeight/mm, htmlClientH: de.clientHeight/mm,
    over: [],
  };
  for (const el of document.querySelectorAll('body *')) {
    const b = el.getBoundingClientRect();
    if (b.right/mm > 70.05 || b.left/mm < -0.05 || b.bottom/mm > 155.05) {
      out.over.push({ tag: el.tagName+'.'+(el.className||'').toString().split(' ')[0],
        left: b.left/mm, right: b.right/mm, top: b.top/mm, bottom: b.bottom/mm });
    }
  }
  return out;
});
// Assert, do not just report. A body whose scrollable width exceeds its client width
// makes Chromium's PRINT path shrink the whole page to fit and anchor it top-left —
// the failure Aswin spotted as "still left aligned". The screenshot path ignores it,
// so this is the only cheap place to catch the cause rather than the symptom.
let bad = 0;
const slack = 0.2;   // mm; sub-pixel rounding
if (r.bodyScrollW > r.bodyClientW + slack) {
  console.log(`  FAIL body overflows: scrollWidth ${r.bodyScrollW.toFixed(2)}mm vs clientWidth ${r.bodyClientW.toFixed(2)}mm`);
  console.log(`       print would shrink the page by ${(r.bodyClientW / r.bodyScrollW * 100).toFixed(1)}%`);
  bad++;
}
console.log(`  html scrollWidth ${r.htmlScrollW.toFixed(2)}mm vs clientWidth ${r.htmlClientW.toFixed(2)}mm`);
console.log(`  body scrollWidth ${r.bodyScrollW.toFixed(2)}mm vs clientWidth ${r.bodyClientW.toFixed(2)}mm`);
console.log(`  html scrollHeight ${r.htmlScrollH.toFixed(2)}mm vs clientHeight ${r.htmlClientH.toFixed(2)}mm`);
console.log(`\n  elements crossing the 70x155mm box:`);
if (!r.over.length) console.log('    none');
for (const o of r.over) console.log(`    ${o.tag.padEnd(18)} x ${o.left.toFixed(2)}..${o.right.toFixed(2)}  y ${o.top.toFixed(2)}..${o.bottom.toFixed(2)}`);
await b.close();
console.log(bad ? `  ✗ ${bad} overflow problem(s)` : '  ✓ no page overflow — print will not rescale');
process.exit(bad ? 1 : 0);
