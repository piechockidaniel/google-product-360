/**
 * URL canonicalisation shared by the product link side and the Search Console
 * page side, so both end up with the same join key.
 */
const TRACKING_PARAMS = /^(utm_|gclid$|gbraid$|wbraid$|fbclid$|msclkid$|dclid$|mc_cid$|mc_eid$|_ga$|_gl$|ref$|srsltid$)/i;

export function canonicalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  const keep: [string, string][] = [];
  for (const [k, v] of url.searchParams) if (!TRACKING_PARAMS.test(k)) keep.push([k, v]);
  keep.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  url.search = '';
  for (const [k, v] of keep) url.searchParams.append(k, v);
  let out = url.toString();
  // Trailing slash is significant for Search Console only at the root; normalise elsewhere.
  if (url.pathname.length > 1 && url.pathname.endsWith('/') && !url.search) out = out.replace(/\/$/, '');
  return out;
}

/** `https://shop.example/` → `shop.example`; `sc-domain:shop.example` → `shop.example` */
export function siteHost(siteUrl: string): string | null {
  if (siteUrl.startsWith('sc-domain:')) return siteUrl.slice('sc-domain:'.length).toLowerCase();
  try {
    return new URL(siteUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether a page URL belongs to a Search Console property (domain properties include every sub-domain and scheme). */
export function urlBelongsToSite(url: string, siteUrl: string): boolean {
  const host = siteHost(siteUrl);
  if (!host) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (siteUrl.startsWith('sc-domain:')) return parsed.hostname === host || parsed.hostname.endsWith(`.${host}`);
  return url.toLowerCase().startsWith(siteUrl.toLowerCase().replace(/\/$/, ''));
}
