// A small streaming CSV parser (RFC 4180: quoted fields, doubled quotes, CRLF or LF). Feed string chunks; get rows.

export class CsvStream {
  private buf = "";
  private row: string[] = [];
  private field = "";
  private inQuotes = false;
  private quoteSeen = false;

  /** Parse a chunk; returns the rows completed by it. */
  push(chunk: string): string[][] {
    const out: string[][] = [];
    const s = this.buf + chunk;
    this.buf = "";
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i]!;
      if (this.inQuotes) {
        if (c === '"') {
          if (i + 1 >= n) {
            // Could be an escaped quote split across chunks; wait for more input.
            this.buf = '"';
            return out;
          }
          if (s[i + 1] === '"') {
            this.field += '"';
            i += 2;
            continue;
          }
          this.inQuotes = false;
          i++;
          continue;
        }
        // Copy a run of ordinary characters at once.
        const q = s.indexOf('"', i);
        const end = q < 0 ? n : q;
        this.field += s.slice(i, end);
        i = end;
        continue;
      }
      if (c === '"' && this.field === "" && !this.quoteSeen) {
        this.inQuotes = true;
        this.quoteSeen = true;
        i++;
      } else if (c === ",") {
        this.row.push(this.field);
        this.field = "";
        this.quoteSeen = false;
        i++;
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && i + 1 >= n) {
          this.buf = "\r";
          return out;
        }
        this.row.push(this.field);
        this.field = "";
        this.quoteSeen = false;
        if (!(this.row.length === 1 && this.row[0] === "")) out.push(this.row);
        this.row = [];
        i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
      } else {
        let j = i;
        while (j < n && s[j] !== "," && s[j] !== "\n" && s[j] !== "\r" && s[j] !== '"') j++;
        if (j === i) j++; // a stray quote inside an unquoted field: keep it literally
        this.field += s.slice(i, j);
        i = j;
      }
    }
    return out;
  }

  /** Flush the final row (a file without a trailing newline). */
  end(): string[][] {
    const out = this.buf ? this.push("") : [];
    if (this.buf === "\r" || this.buf === '"') {
      if (this.buf === '"') this.inQuotes = false;
      this.buf = "";
    }
    if (this.field !== "" || this.row.length) {
      this.row.push(this.field);
      out.push(this.row);
    }
    this.row = [];
    this.field = "";
    return out;
  }
}

/** Parse a whole CSV text into objects keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const p = new CsvStream();
  const rows = [...p.push(text), ...p.end()];
  return toObjects(rows);
}

export function toObjects(rows: string[][], header?: string[]): Record<string, string>[] {
  const h = header ?? rows.shift();
  if (!h) return [];
  return rows.map((r) => {
    const o: Record<string, string> = {};
    for (let i = 0; i < h.length; i++) o[h[i]!] = r[i] ?? "";
    return o;
  });
}

/** Stream objects from chunks of CSV text. */
export async function* csvObjects(chunks: AsyncIterable<string>): AsyncGenerator<Record<string, string>> {
  const p = new CsvStream();
  let header: string[] | undefined;
  const emit = function* (rows: string[][]) {
    for (const r of rows) {
      if (!header) {
        header = r.map((x, i) => (i === 0 ? x.replace(/^﻿/, "") : x));
        continue;
      }
      const o: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) o[header[i]!] = r[i] ?? "";
      yield o;
    }
  };
  for await (const c of chunks) yield* emit(p.push(c));
  yield* emit(p.end());
}
