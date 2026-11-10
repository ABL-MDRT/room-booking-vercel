import { readFile } from 'node:fs/promises';
import { gatePage, hasAccess } from '../lib/access.js';

const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' };

export default {
  async fetch(request: Request): Promise<Response> {
    if (!hasAccess(request.headers.get('cookie'), process.env, Date.now())) {
      return new Response(gatePage(), { status: 401, headers: HTML_HEADERS });
    }
    const html = await readFile(new URL('../views/index.html', import.meta.url), 'utf8');
    return new Response(html, { headers: HTML_HEADERS });
  },
};
