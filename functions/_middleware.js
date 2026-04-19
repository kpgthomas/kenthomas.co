// Markdown for Agents middleware
// Serves a markdown version of HTML pages when the client sends Accept: text/markdown
// HTML remains the default response for browsers.

const MARKDOWN_MIME = "text/markdown";
const HTML_MIME = "text/html";

function wantsMarkdown(request) {
  const accept = request.headers.get("Accept") || "";
  // Simple negotiation: markdown wins only if explicitly preferred over html,
  // or when it is the only listed media type.
  if (!accept) return false;
  const mdIdx = accept.indexOf(MARKDOWN_MIME);
  const htmlIdx = accept.indexOf(HTML_MIME);
  if (mdIdx === -1) return false;
  if (htmlIdx === -1) return true;
  return mdIdx < htmlIdx;
}

function isHtmlResponse(response) {
  const contentType = response.headers.get("Content-Type") || "";
  return contentType.toLowerCase().includes("text/html");
}

// Minimal HTML to markdown converter focused on the <main> element.
// Handles headings, paragraphs, links, lists, strong, em, br, hr.
class MarkdownExtractor {
  constructor() {
    this.lines = [];
    this.current = "";
    this.listDepth = 0;
    this.inOrderedList = [];
    this.orderedIndex = [];
    this.inPre = false;
  }

  pushLine(line = "") {
    if (this.current) {
      this.lines.push(this.current);
      this.current = "";
    }
    if (line !== undefined) this.lines.push(line);
  }

  flush() {
    if (this.current) {
      this.lines.push(this.current);
      this.current = "";
    }
  }

  toString() {
    this.flush();
    // Collapse multiple blank lines to one
    const out = [];
    let lastBlank = false;
    for (const line of this.lines) {
      const blank = line.trim() === "";
      if (blank && lastBlank) continue;
      out.push(line);
      lastBlank = blank;
    }
    return out.join("\n").trim() + "\n";
  }
}

function buildMarkdownRewriter(extractor) {
  const rewriter = new HTMLRewriter();

  let currentBlock = null; // 'h1'..'h6','p','li','blockquote',null
  let buffer = "";
  let linkHref = null;
  let linkText = "";
  let inLink = false;
  let listType = []; // stack of 'ul' or 'ol'
  let orderedIndex = [];

  function emitBlock() {
    const text = buffer.replace(/\s+/g, " ").trim();
    buffer = "";
    if (!text) { currentBlock = null; return; }
    if (currentBlock && currentBlock.startsWith("h")) {
      const level = parseInt(currentBlock.slice(1), 10);
      extractor.pushLine("");
      extractor.pushLine("#".repeat(level) + " " + text);
      extractor.pushLine("");
    } else if (currentBlock === "p") {
      extractor.pushLine("");
      extractor.pushLine(text);
      extractor.pushLine("");
    } else if (currentBlock === "li") {
      const depth = Math.max(0, listType.length - 1);
      const indent = "  ".repeat(depth);
      const top = listType[listType.length - 1];
      if (top === "ol") {
        const idx = orderedIndex[orderedIndex.length - 1] || 1;
        extractor.pushLine(`${indent}${idx}. ${text}`);
        orderedIndex[orderedIndex.length - 1] = idx + 1;
      } else {
        extractor.pushLine(`${indent}- ${text}`);
      }
    } else if (currentBlock === "blockquote") {
      extractor.pushLine("");
      extractor.pushLine("> " + text);
      extractor.pushLine("");
    }
    currentBlock = null;
  }

  const textHandler = {
    text(t) {
      if (inLink) {
        linkText += t.text;
      } else if (currentBlock) {
        buffer += t.text;
      }
    },
  };

  rewriter.on("main h1, main h2, main h3, main h4, main h5, main h6", {
    element(el) {
      currentBlock = el.tagName.toLowerCase();
      buffer = "";
      el.onEndTag(() => emitBlock());
    },
    ...textHandler,
  });

  rewriter.on("main p", {
    element(el) {
      currentBlock = "p";
      buffer = "";
      el.onEndTag(() => emitBlock());
    },
    ...textHandler,
  });

  rewriter.on("main ul", {
    element(el) {
      listType.push("ul");
      el.onEndTag(() => { listType.pop(); extractor.pushLine(""); });
    },
  });

  rewriter.on("main ol", {
    element(el) {
      listType.push("ol");
      orderedIndex.push(1);
      el.onEndTag(() => { listType.pop(); orderedIndex.pop(); extractor.pushLine(""); });
    },
  });

  rewriter.on("main li", {
    element(el) {
      currentBlock = "li";
      buffer = "";
      el.onEndTag(() => emitBlock());
    },
    ...textHandler,
  });

  rewriter.on("main blockquote", {
    element(el) {
      currentBlock = "blockquote";
      buffer = "";
      el.onEndTag(() => emitBlock());
    },
    ...textHandler,
  });

  rewriter.on("main a", {
    element(el) {
      const href = el.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      inLink = true;
      linkHref = href;
      linkText = "";
      el.onEndTag(() => {
        if (currentBlock) {
          buffer += `[${linkText.trim()}](${linkHref})`;
        }
        inLink = false;
        linkHref = null;
        linkText = "";
      });
    },
    text(t) {
      if (inLink) linkText += t.text;
    },
  });

  rewriter.on("main strong, main b", {
    element(el) {
      if (!currentBlock) return;
      buffer += "**";
      el.onEndTag(() => { if (currentBlock) buffer += "**"; });
    },
  });

  rewriter.on("main em, main i", {
    element(el) {
      if (!currentBlock) return;
      buffer += "*";
      el.onEndTag(() => { if (currentBlock) buffer += "*"; });
    },
  });

  rewriter.on("main br", {
    element() {
      if (currentBlock) buffer += "  \n";
    },
  });

  rewriter.on("main hr", {
    element() {
      extractor.pushLine("");
      extractor.pushLine("---");
      extractor.pushLine("");
    },
  });

  return rewriter;
}

async function htmlToMarkdown(response, request) {
  const extractor = new MarkdownExtractor();
  const rewriter = buildMarkdownRewriter(extractor);
  // We need to consume the rewritten stream to drive the handlers.
  const transformed = rewriter.transform(response.clone());
  await transformed.text(); // drain stream so handlers run
  const body = extractor.toString();

  const title = (response.headers.get("X-Page-Title") || new URL(request.url).pathname)
    .replace(/^\//, "")
    .replace(/\.html$/, "")
    .replace(/-/g, " ")
    .trim() || "Home";

  const prefix = `# ${title}\n\nSource: ${request.url}\n\n`;

  return new Response(prefix + body, {
    status: response.status,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Vary": "Accept",
      "Cache-Control": "public, max-age=300",
      "X-Content-Negotiation": "markdown",
    },
  });
}

export async function onRequest(context) {
  const { request, next } = context;

  // Only handle GET and HEAD
  if (request.method !== "GET" && request.method !== "HEAD") {
    return next();
  }

  // Pass through non-markdown requests
  if (!wantsMarkdown(request)) {
    const response = await next();
    // Advertise content negotiation on HTML responses
    if (isHtmlResponse(response)) {
      const newHeaders = new Headers(response.headers);
      const existingVary = newHeaders.get("Vary") || "";
      if (!existingVary.toLowerCase().includes("accept")) {
        newHeaders.set("Vary", existingVary ? `${existingVary}, Accept` : "Accept");
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }
    return response;
  }

  // Get the HTML response first
  const response = await next();
  if (!isHtmlResponse(response)) {
    return response;
  }

  try {
    return await htmlToMarkdown(response, request);
  } catch (err) {
    // On failure, fall back to the original HTML response
    return response;
  }
}
