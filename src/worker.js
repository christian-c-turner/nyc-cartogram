const DIAGNOSTIC_HEADER = "x-cph-cartogram-worker";

function withDiagnosticHeader(response) {
  const headers = new Headers(response.headers);
  headers.set(DIAGNOSTIC_HEADER, "1");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Pretty origin routes like /@55.67594,12.56553 are rendered by the app shell.
    if (url.pathname.startsWith("/@")) {
      url.pathname = "/";
    }
    const assetResponse = await env.ASSETS.fetch(new Request(url.toString(), request));
    return withDiagnosticHeader(assetResponse);
  },
};
