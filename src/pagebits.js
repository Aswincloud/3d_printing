// Tiny helpers shared by standalone pages.
export { esc } from "./lib.js";
export const rupeesText = (paise) => "₹" + (Number(paise || 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
