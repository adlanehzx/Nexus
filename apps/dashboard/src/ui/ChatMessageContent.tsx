import { useState, type ReactNode } from "react";
import { IconCheck, IconCopy } from "./icons.js";

interface ChatMessageContentProps {
  content: string;
}

export function ChatMessageContent({ content }: ChatMessageContentProps) {
  if (!content) return null;

  const blocks = parseMarkdownBlocks(content);

  return (
    <div className="chat-markdown-body">
      {blocks.map((block, idx) => (
        <BlockView key={idx} block={block} />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Block Types & Parser
// ─────────────────────────────────────────────────────────────────────────────

type MarkdownBlock =
  | { type: "code"; lang: string; code: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; text: string }
  | { type: "hr" };

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();

    // 1. Fenced Code Block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]?.trim().startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      i++; // consume closing ```
      blocks.push({
        type: "code",
        lang: lang || "text",
        code: codeLines.join("\n"),
      });
      continue;
    }

    // 2. Horizontal Rule
    if (/^(?:---|\*\*\*|___)$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // 3. Headings
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headingMatch?.[1] && headingMatch[2]) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", level, text: headingMatch[2] });
      i++;
      continue;
    }

    // 4. Blockquote
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (
        i < lines.length &&
        ((lines[i]?.trim().startsWith(">") ?? false) ||
          ((lines[i]?.trim().length ?? 0) > 0 &&
            quoteLines.length > 0 &&
            !lines[i]?.trim().startsWith("```") &&
            !lines[i]?.trim().startsWith("#")))
      ) {
        const ql = lines[i]?.trim() ?? "";
        if (ql.startsWith(">")) {
          quoteLines.push(ql.replace(/^>\s?/, ""));
        } else {
          break;
        }
        i++;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }

    // 5. Markdown Tables
    if (line.startsWith("|") && line.endsWith("|")) {
      const tableLines: string[] = [];
      while (
        i < lines.length &&
        (lines[i]?.trim().startsWith("|") ?? false) &&
        (lines[i]?.trim().endsWith("|") ?? false)
      ) {
        tableLines.push(lines[i]?.trim() ?? "");
        i++;
      }
      if (tableLines.length >= 2) {
        const headerLine = tableLines[0] ?? "";
        const delimiterLine = tableLines[1] ?? "";
        if (delimiterLine.includes("---") || delimiterLine.includes("-|-")) {
          const parseRow = (rowStr: string): string[] =>
            rowStr
              .slice(1, -1)
              .split("|")
              .map((c) => c.trim());
          const headers = parseRow(headerLine);
          const rows = tableLines.slice(2).map(parseRow);
          blocks.push({ type: "table", headers, rows });
          continue;
        }
      }
      // If not a valid table, treat as paragraphs
      for (const tline of tableLines) {
        blocks.push({ type: "paragraph", text: tline });
      }
      continue;
    }

    // 6. Lists (unordered or ordered)
    const isUl = /^[-*+]\s+(.+)$/.test(line);
    const isOl = /^\d+\.\s+(.+)$/.test(line);
    if (isUl || isOl) {
      const ordered = isOl;
      const items: string[] = [];
      while (i < lines.length) {
        const currentLine = lines[i]?.trim() ?? "";
        const match = ordered
          ? /^\d+\.\s+(.+)$/.exec(currentLine)
          : /^[-*+]\s+(.+)$/.exec(currentLine);
        if (match?.[1]) {
          items.push(match[1]);
          i++;
        } else if (currentLine.length === 0) {
          break;
        } else {
          // If continuation line of list item
          if (items.length > 0 && !currentLine.startsWith("#") && !currentLine.startsWith("```")) {
            items[items.length - 1] += " " + currentLine;
            i++;
          } else {
            break;
          }
        }
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // 7. Empty line
    if (line.length === 0) {
      i++;
      continue;
    }

    // 8. Normal Paragraph
    const paraLines: string[] = [rawLine];
    i++;
    while (
      i < lines.length &&
      (lines[i]?.trim().length ?? 0) > 0 &&
      !lines[i]?.trim().startsWith("```") &&
      !lines[i]?.trim().startsWith("#") &&
      !lines[i]?.trim().startsWith(">") &&
      !lines[i]?.trim().startsWith("|") &&
      !/^[-*+]\s+/.test(lines[i]?.trim() ?? "") &&
      !/^\d+\.\s+/.test(lines[i]?.trim() ?? "")
    ) {
      paraLines.push(lines[i] ?? "");
      i++;
    }
    blocks.push({ type: "paragraph", text: paraLines.join("\n") });
  }

  return blocks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block Components
// ─────────────────────────────────────────────────────────────────────────────

function BlockView({ block }: { block: MarkdownBlock }) {
  switch (block.type) {
    case "code":
      return <CodeBlock lang={block.lang} code={block.code} />;
    case "table":
      return <TableView headers={block.headers} rows={block.rows} />;
    case "heading":
      return <HeadingView level={block.level} text={block.text} />;
    case "quote":
      return (
        <blockquote className="chat-blockquote">
          <InlineContent text={block.text} />
        </blockquote>
      );
    case "list":
      if (block.ordered) {
        return (
          <ol className="chat-ol">
            {block.items.map((item, idx) => (
              <li key={idx}>
                <InlineContent text={item} />
              </li>
            ))}
          </ol>
        );
      }
      return (
        <ul className="chat-ul">
          {block.items.map((item, idx) => (
            <li key={idx}>
              <InlineContent text={item} />
            </li>
          ))}
        </ul>
      );
    case "hr":
      return <hr className="chat-hr" />;
    case "paragraph":
      return (
        <p className="chat-para">
          <InlineContent text={block.text} />
        </p>
      );
  }
}

function HeadingView({ level, text }: { level: 1 | 2 | 3 | 4; text: string }) {
  const content = <InlineContent text={text} />;
  switch (level) {
    case 1:
      return <h1 className="chat-h1">{content}</h1>;
    case 2:
      return <h2 className="chat-h2">{content}</h2>;
    case 3:
      return <h3 className="chat-h3">{content}</h3>;
    case 4:
      return <h4 className="chat-h4">{content}</h4>;
  }
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="chat-code-block">
      <div className="chat-code-header">
        <span className="chat-code-lang">{lang}</span>
        <button
          type="button"
          className="chat-code-copy-btn"
          onClick={handleCopy}
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <IconCheck size={12} />
              <span>Copié</span>
            </>
          ) : (
            <>
              <IconCopy size={12} />
              <span>Copier</span>
            </>
          )}
        </button>
      </div>
      <pre className="chat-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function TableView({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="chat-table-wrapper">
      <table className="chat-table">
        {headers.length > 0 && (
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i}>
                  <InlineContent text={h} />
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {row.map((cell, cellIdx) => (
                <td key={cellIdx}>
                  <InlineContent text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline Formatter (Bold, Italic, Code, Links)
// ─────────────────────────────────────────────────────────────────────────────

export function InlineContent({ text }: { text: string }): ReactNode {
  const parts: ReactNode[] = [];
  let remaining = text;
  let keyIndex = 0;

  while (remaining.length > 0) {
    // 1. Markdown link: [label](url)
    const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(remaining);
    if (linkMatch?.[1] && linkMatch[2]) {
      parts.push(
        <a
          key={`l-${keyIndex++}`}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-link"
        >
          {linkMatch[1]}
        </a>,
      );
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // 2. Bare URL: https://...
    const urlMatch = /^https?:\/\/[^\s<>)"]+/.exec(remaining);
    if (urlMatch) {
      const url = urlMatch[0];
      parts.push(
        <a
          key={`u-${keyIndex++}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-link"
        >
          {url}
        </a>,
      );
      remaining = remaining.slice(url.length);
      continue;
    }

    // 3. Inline code: `code`
    const codeMatch = /^`([^`]+)`/.exec(remaining);
    if (codeMatch?.[1]) {
      parts.push(
        <code key={`c-${keyIndex++}`} className="chat-inline-code">
          {codeMatch[1]}
        </code>,
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // 4. Bold: **text**
    const boldMatch = /^\*\*([^*]+)\*\*/.exec(remaining);
    if (boldMatch?.[1]) {
      parts.push(<strong key={`b-${keyIndex++}`}>{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // 5. Italic: *text*
    const italicMatch = /^\*([^*]+)\*/.exec(remaining);
    if (italicMatch?.[1]) {
      parts.push(<em key={`i-${keyIndex++}`}>{italicMatch[1]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Normal text chunk up to next special char [ ` * h
    const nextSpecial = remaining.search(/(\[|`|\*|https?:\/\/)/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else if (nextSpecial === 0) {
      parts.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      parts.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    }
  }

  return <>{parts}</>;
}
