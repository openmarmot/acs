import { useEffect, useState } from "react";

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // LAN pages are http and not a secure context. Fall through to a selection copy.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.focus();
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

export function PromptModal(props: {
  kind: "connect" | "create";
  title: string;
  lede: string;
  prompt: string | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
  }, [props.prompt]);

  const copy = async () => {
    if (!props.prompt) return;
    const ok = await copyText(props.prompt);
    setCopied(ok);
    setCopyFailed(!ok);
  };

  return (
    <div className="modal-back" onClick={props.onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        data-modal={props.kind}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="prompt-title">{props.title}</h2>
        <p className="muted">{props.lede}</p>
        {props.loading && <p className="muted">Loading this corporation's token…</p>}
        {props.error && <p className="warn">{props.error}</p>}
        {props.prompt && (
          <textarea readOnly value={props.prompt} aria-label="Agent prompt" spellCheck={false} />
        )}
        <div className="modal-actions">
          {props.error && props.onRetry && (
            <button type="button" className="textbtn" onClick={props.onRetry}>
              Retry
            </button>
          )}
          <button type="button" className="textbtn" onClick={props.onClose}>
            Close
          </button>
          <button type="button" className="textbtn primary" onClick={() => void copy()} disabled={!props.prompt} data-copied={copied ? "true" : "false"}>
            {copied ? "Copied" : copyFailed ? "Copy failed" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
