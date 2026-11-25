"""Render the legal Markdown drafts as site pages. Handles only the subset the drafts use."""
import html, re, sys

LINKS = {
    "askwearables-privacy.md": "/privacy",
    "askwearables-terms.md": "/terms",
    "askwearables-developer-terms.md": "/terms#developer-terms",
}


def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    def link(m):
        href = LINKS.get(m.group(2), m.group(2))
        return f'<a href="{html.escape(href)}">{m.group(1)}</a>'
    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, s)
    return s


def slug(t):
    # Anchors leave out section numbers, so links such as /privacy#consumer-health-data survive renumbering.
    t = re.sub(r"^\d+\.\s+", "", t)
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")


def parse(md, demote=0, skip_banner=False, h1_id=None, prefix=""):
    lines = md.split("\n")
    out, toc = [], []
    i, title = 0, None
    while i < len(lines):
        ln = lines[i]
        if not ln.strip():
            i += 1
            continue
        m = re.match(r"^(#{1,3}) (.*)$", ln)
        if m:
            lvl = len(m.group(1)) + demote
            text = m.group(2)
            if lvl == 1:
                title = text
                out.append(f"<h1>{inline(text)}</h1>")
            else:
                hid = h1_id if (demote and len(m.group(1)) == 1) else prefix + slug(text)
                if lvl == 2:
                    toc.append((hid, text))
                out.append(f'<h{lvl} id="{hid}">{inline(text)}</h{lvl}>')
            i += 1
            continue
        if ln.startswith(">"):
            block = []
            while i < len(lines) and lines[i].startswith(">"):
                block.append(lines[i][1:].lstrip(" ") if lines[i] != ">" else "")
                i += 1
            first = block[0]
            if "DRAFT" in first:
                if not skip_banner:
                    out.append(f'<div class="banner" role="note">\n  <p>{inline(first)}</p>\n</div>')
            else:
                inner = parse("\n".join(block))[0]
                out.append(f'<div class="note" role="note">\n{inner}\n</div>')
            continue
        if ln.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            head, body = rows[0], rows[2:]
            t = ['<div class="table-wrap"><table>']
            if any(head):
                t.append("  <thead><tr>" + "".join(f'<th scope="col">{inline(c)}</th>' for c in head) + "</tr></thead>")
            else:
                pass
            t.append("  <tbody>")
            for r in body:
                cells = "".join((f'<th scope="row">{inline(c)}</th>' if (j == 0 and not any(head)) else f"<td>{inline(c)}</td>") for j, c in enumerate(r))
                t.append(f"    <tr>{cells}</tr>")
            t.append("  </tbody>\n</table></div>")
            out.append("\n".join(t))
            continue
        if re.match(r"^(- |\d+\. )", ln):
            ordered = bool(re.match(r"^\d+\. ", ln))
            tag = "ol" if ordered else "ul"
            items = []
            while i < len(lines) and (re.match(r"^(- |\d+\. )", lines[i]) or lines[i].startswith("  - ")):
                if lines[i].startswith("  - "):
                    items[-1][1].append(lines[i][4:])
                else:
                    items.append([re.sub(r"^(- |\d+\. )", "", lines[i]), []])
                i += 1
            li = []
            for text, sub in items:
                s = inline(text)
                if sub:
                    s += "\n    <ul>" + "".join(f"<li>{inline(x)}</li>" for x in sub) + "</ul>"
                li.append(f"  <li>{s}</li>")
            out.append(f"<{tag}>\n" + "\n".join(li) + f"\n</{tag}>")
            continue
        para = []
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#|>|\||- |\d+\. )", lines[i]):
            para.append(inline(lines[i]))
            i += 1
        cls = ' class="muted"' if para[0].startswith(("Draft of", "Effective date")) else ""
        out.append(f"<p{cls}>" + "<br>\n".join(para) + "</p>")
    return "\n\n".join(out), toc, title


HEADER = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · AskWearables</title>
<meta name="description" content="{desc}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header"><div class="inner">
  <a class="brand" href="/"><svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><circle class="ring" cx="12" cy="12" r="9"/><circle class="dot" cx="12" cy="12" r="3.5"/></svg>AskWearables</a>
  <nav class="site-nav" aria-label="Main">
    <a href="/docs/">Docs</a>
    <a href="/docs/quickstart">Quickstart</a>
    <a href="/results">Results</a>
    <a href="/docs/api">API</a>
    <a href="https://app.askwearables.app/">Console</a>
  </nav>
</div></header>

<main id="main" class="wrap">
"""

MAIN_OPEN = '<main id="main" class="wrap">'

FOOTER = """</main>

<footer class="site-footer"><div class="inner">
  <span>AskWearables. Wellness information only; not medical advice.</span>
  <nav aria-label="Footer">
    <a href="/docs/">Docs</a>
    <a href="/results">Results</a>
    <a href="/docs/api">API reference</a>
    <a href="/openapi.json">OpenAPI</a>
    <a href="/privacy">Privacy policy</a>
    <a href="/privacy#consumer-health-data">Consumer health data</a>
    <a href="/terms">Terms of service</a>
  </nav>
</div></footer>
</body>
</html>
"""


def page(parts, desc, out_path, source_note):
    bodies, toc, title = [], [], None
    for md, opts in parts:
        b, t, ti = parse(md, **opts)
        title = title or ti
        bodies.append(b)
        toc += t
    # Banner first, then h1, then the date line, then the table of contents, then the rest.
    body = "\n\n".join(bodies)
    nav = '<nav class="toc" aria-label="Contents">\n<ul>\n' + "\n".join(f'  <li><a href="#{h}">{inline(t)}</a></li>' for h, t in toc) + "\n</ul>\n</nav>"
    # Insert the TOC after the summary note of the first document.
    idx = body.find("</div>", body.find('<div class="note"')) + len("</div>")
    body = body[:idx] + "\n\n" + nav + body[idx:]
    body += f'\n\n<p class="muted"><small>{source_note}</small></p>\n'
    head = HEADER.format(title=html.escape(title.replace("AskWearables ", "")), desc=html.escape(desc))
    foot = FOOTER
    # Keep the site's current header and footer: if the page already exists, replace only its title,
    # description and the content of <main>. The built-in chrome is used only for a first render.
    try:
        old = open(out_path).read()
        start = old.index(MAIN_OPEN) + len(MAIN_OPEN)
        end = old.index("</main>")
        head, foot = old[:start] + "\n", old[end:]
        head = re.sub(r"<title>[^<]*</title>", lambda m: re.search(r"<title>[^<]*</title>", HEADER.format(title=html.escape(title.replace("AskWearables ", "")), desc="")).group(0), head, count=1)
        head = re.sub(r'<meta name="robots" content="noindex">\n?', "", head)
        head = re.sub(r'<meta name="description" content="[^"]*">', lambda m: f'<meta name="description" content="{html.escape(desc)}">', head, count=1)
    except (FileNotFoundError, ValueError):
        pass
    with open(out_path, "w") as f:
        f.write(head + body + "\n" + foot)


if __name__ == "__main__":
    legal, public = sys.argv[1], sys.argv[2]
    # The street address is not published yet: drop its placeholder line, and the placeholder before the city.
    rd = lambda n: re.sub(r"^\[street address\]\n", "", open(f"{legal}/{n}").read(), flags=re.M).replace("[street address], ", "")
    page([(rd("askwearables-privacy.md"), {})],
         "Privacy policy for AskWearables, a product of Sports Vision, Inc.",
         f"{public}/privacy.html",
         'Source: <code>docs/legal/askwearables-privacy.md</code>. See also the <a href="/docs/privacy">privacy model</a>, which explains in technical detail how the gate decides what is released.')
    page([(rd("askwearables-terms.md"), {}),
          (rd("askwearables-developer-terms.md"), {"demote": 1, "skip_banner": True, "h1_id": "developer-terms", "prefix": "dev-"})],
         "Terms of service and developer terms for AskWearables, a product of Sports Vision, Inc.",
         f"{public}/terms.html",
         "Source: <code>docs/legal/askwearables-terms.md</code> and <code>docs/legal/askwearables-developer-terms.md</code>.")
