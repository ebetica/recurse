// Browser-only entry points used by the document conversion worker.
declare module "mammoth/mammoth.browser.js" {
  export { convertToHtml, images } from "mammoth";
}
declare module "linkedom/worker" {
  export { parseHTML } from "linkedom";
}
