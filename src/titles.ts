import { type Slide } from "./parser.js";

/**
 * How much of a document is searched for its `<title>`, and how long a
 * heading or title may be before it is ignored.
 *
 * The document is attacker-supplied — it arrives from `deckrun <url>`,
 * `/__fetch-doc` or a `POST /__present-doc` body — so every scan here is
 * bounded. An unbounded `[^>]*` or `[\s\S]*?` re-scans the remaining input
 * from every candidate start position, which turns a megabyte of `<title`
 * into quadratic work on the server's only thread.
 */
const HEAD_SCAN_LIMIT = 64 * 1024;
const ATTR_LIMIT = 200;
const TEXT_LIMIT = 2000;

const HEADING_RE = new RegExp(
  `<h[1-6][^>]{0,${ATTR_LIMIT}}>([\\s\\S]{0,${TEXT_LIMIT}}?)</h[1-6]>`,
  "i"
);
const TITLE_RE = new RegExp(
  `<title[^>]{0,${ATTR_LIMIT}}>([\\s\\S]{0,${TEXT_LIMIT}}?)</title>`,
  "i"
);

function stripTags(value: string): string {
  return value.replace(/<[^>]{0,1000}>/g, "").trim();
}

/** First heading of the deck, with inline markup stripped. */
export function deckTitle(slides: Slide[], fallback: string): string {
  const heading = slides[0]?.html.slice(0, HEAD_SCAN_LIMIT).match(HEADING_RE);
  const text = heading ? stripTags(heading[1]) : "";
  return text || fallback;
}

/** An HTML doc's own `<title>`, with inline markup stripped. */
export function docTitle(html: string, fallback: string): string {
  const match = html.slice(0, HEAD_SCAN_LIMIT).match(TITLE_RE);
  const text = match ? stripTags(match[1]) : "";
  return text || fallback;
}
