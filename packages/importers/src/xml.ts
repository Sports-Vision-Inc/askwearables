// A minimal streaming XML tokenizer, enough for Apple Health's export.xml.
// Feed string chunks with push(); it calls back for each start and end tag and keeps only the
// unfinished tail of the input in memory. Text content is ignored (export.xml keeps data in attributes).

export interface XmlHandler {
  open(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  close(name: string): void;
}

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e] ?? m;
  });
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(s))) out[m[1]!] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

export class XmlStream {
  private buf = "";
  /** Bytes (UTF-16 code units) consumed so far; for progress reporting. */
  consumed = 0;
  /** Largest unconsumed buffer seen; a sanity check that memory stays flat. */
  maxBuffered = 0;

  constructor(private readonly h: XmlHandler, private readonly maxTagLength = 16 * 1024 * 1024) {}

  push(chunk: string): void {
    this.buf = this.buf.length ? this.buf + chunk : chunk;
    if (this.buf.length > this.maxBuffered) this.maxBuffered = this.buf.length;
    let pos = 0;
    const s = this.buf;
    const n = s.length;
    for (;;) {
      const lt = s.indexOf("<", pos);
      if (lt < 0) {
        pos = n;
        break;
      }
      pos = lt;
      if (lt + 1 >= n) break;
      const c1 = s[lt + 1]!;
      let end: number;
      if (c1 === "?") {
        end = s.indexOf("?>", lt + 2);
        if (end < 0) break;
        pos = end + 2;
        continue;
      }
      if (c1 === "!") {
        if (s.startsWith("<!--", lt)) {
          end = s.indexOf("-->", lt + 4);
          if (end < 0) break;
          pos = end + 3;
          continue;
        }
        if (s.startsWith("<![CDATA[", lt)) {
          end = s.indexOf("]]>", lt + 9);
          if (end < 0) break;
          pos = end + 3;
          continue;
        }
        // <!DOCTYPE ...> possibly with an internal subset [ ... ] holding '>' characters.
        const gt = this.tagEnd(s, lt + 2);
        const br = s.indexOf("[", lt + 2);
        if (br >= 0 && (gt < 0 || br < gt)) {
          const close = /\]\s*>/g;
          close.lastIndex = br;
          const m = close.exec(s);
          if (!m) {
            if (n - lt > this.maxTagLength) throw new Error("xml_doctype_too_long");
            break;
          }
          pos = m.index + m[0].length;
          continue;
        }
        if (gt < 0) break;
        pos = gt + 1;
        continue;
      }
      if (c1 === "/") {
        end = s.indexOf(">", lt + 2);
        if (end < 0) break;
        this.h.close(s.slice(lt + 2, end).trim());
        pos = end + 1;
        continue;
      }
      end = this.tagEnd(s, lt + 1);
      if (end < 0) {
        if (n - lt > this.maxTagLength) throw new Error("xml_tag_too_long");
        break;
      }
      const selfClosing = s[end - 1] === "/";
      const inner = s.slice(lt + 1, selfClosing ? end - 1 : end);
      const sp = inner.search(/[\s/]/);
      const name = sp < 0 ? inner : inner.slice(0, sp);
      this.h.open(name, sp < 0 ? {} : parseAttrs(inner.slice(sp)), selfClosing);
      if (selfClosing) this.h.close(name);
      pos = end + 1;
    }
    this.consumed += pos;
    this.buf = pos >= n ? "" : s.slice(pos);
  }

  /** Index of the '>' closing a tag that starts before `from`, skipping quoted attribute values. -1 if not yet in the buffer. */
  private tagEnd(s: string, from: number): number {
    let i = from;
    const n = s.length;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 62 /* > */) return i;
      if (c === 34 /* " */ || c === 39 /* ' */) {
        const q = s.indexOf(c === 34 ? '"' : "'", i + 1);
        if (q < 0) return -1;
        i = q + 1;
        continue;
      }
      i++;
    }
    return -1;
  }

  end(): void {
    if (this.buf.trim().length) throw new Error("xml_truncated");
    this.buf = "";
  }
}
