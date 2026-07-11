import { readFile } from "node:fs/promises";

const ASSETS = new Map([
  ["/channel-gateway", ["channel-gateway.html", "text/html; charset=utf-8"]],
  ["/channel-gateway/", ["channel-gateway.html", "text/html; charset=utf-8"]],
  ["/channel-gateway/app.js", ["channel-gateway.js", "text/javascript; charset=utf-8"]],
  ["/channel-gateway/app.css", ["channel-gateway.css", "text/css; charset=utf-8"]],
]);
const CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'self'; style-src 'self'; connect-src 'self'";

export function createConsoleAssetsHandler() {
  return async function handleConsoleAsset(request, response) {
    const pathname = new URL(request.url ?? "/", "http://channel-gateway.local").pathname;
    const asset = ASSETS.get(pathname);
    if (!asset || request.method !== "GET") {
      response.statusCode = asset ? 405 : 404;
      if (asset) response.setHeader("allow", "GET");
      response.end();
      return true;
    }
    const [file, contentType] = asset;
    const body = await readFile(new URL(`../ui/${file}`, import.meta.url));
    response.statusCode = 200;
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", CSP);
    response.setHeader("content-type", contentType);
    response.setHeader("x-content-type-options", "nosniff");
    response.end(body);
    return true;
  };
}
