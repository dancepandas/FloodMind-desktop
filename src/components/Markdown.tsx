import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import { openUrl } from "../lib/open-file";

/**
 * Standard markdown renderer (react-markdown + remark-gfm + rehype-highlight).
 * No hand-written parsing rules — all formatting comes from these libraries.
 *
 * Links are intercepted: external URLs open in the system browser (via Tauri's
 * opener plugin) instead of navigating the main webview — which would replace
 * the app UI with the target page and leave the user stranded.
 */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ href, children: linkChildren, ...props }) => (
            <a
              {...props}
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:\/\//i.test(href)) {
                  openUrl(href);
                }
              }}
              title={href}
            >
              {linkChildren}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
