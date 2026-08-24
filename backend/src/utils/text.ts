/**
 * Escapes a user-supplied string for safe use inside a `$regex` filter. Search terms
 * reach `eventRepo.list` and `venueRepo.list` straight from query parameters, so this is
 * a security boundary, not a nicety — an unescaped `.*` or a pathological alternation
 * from an untrusted caller can turn a cheap query into a ReDoS.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
