/**
 * Cloudflare Worker — StayOS subdomain proxy.
 * Route: *.stayos.org/*   (the apex stayos.org is NOT proxied through this)
 *
 * - Root "/" on a hotel subdomain → redirect to /login (subdomain = hotel staff,
 *   not the marketing page).
 * - Everything else is proxied to Firebase Hosting; the browser keeps the
 *   {slug}.stayos.org address so the app resolves the tenant from the subdomain.
 *
 * Paste this into the Worker's "Edit code", then Save and deploy.
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Subdomain root → login (marketing lives only on the apex).
    if (url.pathname === '/' || url.pathname === '' || url.pathname === '/index.html') {
      return Response.redirect(url.origin + '/login', 302);
    }

    url.hostname = 'panel-d25c9.web.app';
    return fetch(url, request);
  }
};
