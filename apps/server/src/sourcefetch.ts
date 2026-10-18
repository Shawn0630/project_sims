/**
 * Source fetching for whole-problem generation.
 *
 * The author points the generator at a problem source — a URL, pasted
 * text, or an uploaded .md/.txt. URL sources are fetched SERVER-side
 * (the browser would hit CORS and the log must be able to prove what the
 * model actually read). The honesty contract mirrors the rest of the
 * generation system: a fetch failure, a login wall, or an empty page is
 * an ERROR the author sees — the pipeline never pretends it read
 * something it did not, and never fabricates a problem from nothing.
 */

/** Hard cap on source text handed to the model (≈30k chars). */
export const SOURCE_TEXT_LIMIT = 30_000;

/** Fetch budget for one source URL. */
export const SOURCE_FETCH_TIMEOUT_MS = 15_000;

/** Below this, a fetched page is treated as a wall / empty shell. */
const MIN_USEFUL_CHARS = 120;

export class SourceFetchError extends Error {}

/** Cap a source text at the limit, reporting whether it was cut. */
export function capSourceText(text: string): { text: string; truncated: boolean } {
  if (text.length <= SOURCE_TEXT_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, SOURCE_TEXT_LIMIT), truncated: true };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  times: '×',
  le: '≤',
  ge: '≥',
  approx: '≈',
  rarr: '→',
  larr: '←',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : m;
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

/**
 * HTML → plain text, good enough for problem statements: scripts, styles
 * and other non-content elements are dropped wholesale, block-level tags
 * become line breaks, list items get a dash, remaining tags are stripped
 * and entities decoded. Deliberately NOT a readability extractor — the
 * model copes with some chrome text, and honest noise beats clever
 * guessing about which part of the page "is" the article.
 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(
    /<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ' ',
  );
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(
    /<\/(p|div|section|article|header|footer|main|h[1-6]|ul|ol|table|tr|blockquote|pre|figure|figcaption)\s*>/gi,
    '\n',
  );
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, i, arr) => line !== '' || (arr[i - 1] ?? '') !== '')
    .join('\n')
    .trim();
  return s;
}

export interface FetchedSource {
  text: string;
  truncated: boolean;
  /** URL after redirects — what was actually read. */
  finalUrl: string;
  contentType: string;
}

/**
 * Fetch one source URL and extract its text. Throws SourceFetchError
 * with an author-actionable message on: invalid/non-http URL, network
 * failure or timeout, non-2xx status, an unsupported content type, a
 * redirect into a login page, or a page whose extracted text is too
 * short to be a problem source (login walls and JS shells land here).
 */
export async function fetchSourceText(rawUrl: string): Promise<FetchedSource> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourceFetchError(`链接不合法：${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SourceFetchError(`只支持 http/https 链接，收到的是 ${url.protocol}`);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; SDS-ProblemGenerator/1.0; +local-authoring-tool)',
        Accept: 'text/html, text/plain, text/markdown;q=0.9, */*;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new SourceFetchError(
      timedOut
        ? `抓取超时（${SOURCE_FETCH_TIMEOUT_MS / 1000}s）：${rawUrl} 没有在时限内响应。可以改用「粘贴文本」把题面贴进来。`
        : `抓取失败：${err instanceof Error ? err.message : String(err)}。可以改用「粘贴文本」把题面贴进来。`,
    );
  }
  if (!res.ok) {
    throw new SourceFetchError(
      `抓取失败：对方返回 HTTP ${res.status}（${rawUrl}）。页面可能需要登录或已下线——可以改用「粘贴文本」把题面贴进来。`,
    );
  }
  const contentType = res.headers.get('content-type') ?? '';
  const finalUrl = res.url || rawUrl;
  if (/\/(login|signin|sign-in|auth)(\b|\/|\?)/i.test(new URL(finalUrl).pathname)) {
    throw new SourceFetchError(
      `链接被重定向到了登录页（${finalUrl}），读不到题面正文。请改用「粘贴文本」把题面贴进来。`,
    );
  }
  const raw = await res.text();
  const isHtml = /html/i.test(contentType) || /^\s*</.test(raw);
  const isText = /text|markdown|json/i.test(contentType);
  if (!isHtml && !isText) {
    throw new SourceFetchError(
      `链接返回的不是文本内容（Content-Type: ${contentType || '未知'}），无法当作题目来源。可以改用「粘贴文本」。`,
    );
  }
  const extracted = isHtml ? htmlToText(raw) : raw.trim();
  if (extracted.length < MIN_USEFUL_CHARS) {
    throw new SourceFetchError(
      `页面抓到了，但提取出的正文只有 ${extracted.length} 字，太少——多半是登录墙、纯前端渲染的空壳页，或正文在图片里。请改用「粘贴文本」把题面贴进来。`,
    );
  }
  const { text, truncated } = capSourceText(extracted);
  return { text, truncated, finalUrl, contentType };
}
