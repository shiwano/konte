import type React from "react";
import { useState } from "react";
import type { AssetInfo, AssetPromptInfo, AssetRefInfo, VariantInfo } from "../types.js";
import { Modal } from "./modal.js";

const PROMPT_LABEL: Record<AssetPromptInfo["kind"], string> = {
  prompt: "prompt",
  negative: "negative",
  spoken: "spoken",
};

// Past this a value is collapsed to its head, so one long prompt does not push every other input
// off screen.
const CLAMP_CHARS = 400;

// Up to this, a single-line value reads on the same row as its name instead of in a box of its own.
const SCALAR_CHARS = 80;

function CopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="asset-info-copy"
      title="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function Value({ text }: { text: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > CLAMP_CHARS;
  const shown = long && !expanded ? `${text.slice(0, CLAMP_CHARS)}…` : text;
  return (
    <>
      <pre className="asset-info-value">{shown}</pre>
      {long && (
        <button
          type="button"
          className="asset-info-more"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "show less" : `show all (${text.length} chars)`}
        </button>
      )}
    </>
  );
}

// The take whose info panel is open.
export interface InfoTake {
  address: string;
  variantId: string;
}

export function takeInfo(
  variants: readonly VariantInfo[],
  variantId: string | null,
): AssetInfo | undefined {
  return variantId === null ? undefined : variants.find((v) => v.variantId === variantId)?.info;
}

// The addresses an input consumes, each with the still of the take it consumed.
function Refs({
  refs,
  onOpen,
}: {
  refs: AssetRefInfo[];
  onOpen: (ref: AssetRefInfo) => void;
}): React.ReactElement | null {
  if (refs.length === 0) return null;
  return (
    <div className="asset-info-refs">
      {refs.map((ref) => (
        <span key={ref.address} className="asset-info-ref" title={ref.address}>
          {ref.imageUrl && (
            <button
              type="button"
              className="asset-info-ref-open"
              aria-label={`Enlarge ${ref.address}`}
              onClick={() => onOpen(ref)}
            >
              <img className="asset-info-ref-thumb" src={ref.imageUrl} alt="" />
            </button>
          )}
          <code>{ref.address}</code>
        </span>
      ))}
    </div>
  );
}

/**
 * Read-only overlay printing the declaration one take was generated from: its backend and ref, the
 * text it fed a model, and every other input with the addresses it consumed. Takes no review
 * decision.
 */
export function AssetInfoPanel({
  assetName,
  address,
  variantId,
  info,
  onClose,
}: {
  assetName: string;
  address: string;
  variantId: string;
  info: AssetInfo;
  onClose: () => void;
}): React.ReactElement {
  const [enlarged, setEnlarged] = useState<AssetRefInfo | null>(null);
  return (
    <Modal
      className="asset-info"
      escape={enlarged ? "off" : "always"}
      onClose={onClose}
      title={
        <>
          {assetName} <code className="asset-info-address">{address}</code>{" "}
          <code className="asset-info-address">{variantId}</code>
        </>
      }
      after={
        enlarged?.imageUrl && (
          <Modal
            className="asset-info-image"
            closeLabel="Back to asset info"
            onClose={() => setEnlarged(null)}
            title={<code className="asset-info-address">{enlarged.address}</code>}
          >
            <div className="variant-detail-media">
              <img src={enlarged.imageUrl} alt={enlarged.address} />
            </div>
          </Modal>
        )
      }
    >
      <div className="asset-info-body">
        <div className="asset-info-meta">
          <span className={`asset-info-backend asset-info-backend--${info.backend}`}>
            {info.backend}
          </span>
          <code className="asset-info-ref-id">{info.ref}</code>
          {info.deterministic && (
            <span className="asset-info-flag" title="One outcome for one input: no reroll">
              deterministic
            </span>
          )}
        </div>

        {info.prompts.length > 0 && (
          <div className="asset-info-section">
            {info.prompts.map((p) => (
              <div
                key={`${p.input}-${p.kind}`}
                className={`asset-info-field asset-info-field--${p.kind}`}
              >
                <div className="asset-info-field-head">
                  <span className={`asset-info-kind asset-info-kind--${p.kind}`}>
                    {PROMPT_LABEL[p.kind]}
                  </span>
                  <span className="asset-info-name">{p.input}</span>
                  <CopyButton text={p.value} />
                </div>
                <Value text={p.value} />
              </div>
            ))}
          </div>
        )}

        {info.inputs.length > 0 && (
          <div className="asset-info-section">
            <h4 className="asset-info-heading">Inputs</h4>
            {info.inputs.map((input) => {
              // The chip already carries the address and its still, so the text line is dropped.
              const bareRef = input.refs.length === 1 && input.value === input.refs[0]?.address;
              const scalar =
                input.refs.length === 0 &&
                !input.value.includes("\n") &&
                input.value.length <= SCALAR_CHARS;
              if (bareRef || scalar) {
                return (
                  <div key={input.name} className="asset-info-row">
                    <span className="asset-info-name">{input.name}</span>
                    {bareRef ? (
                      <Refs refs={input.refs} onOpen={setEnlarged} />
                    ) : (
                      <code className="asset-info-scalar">{input.value}</code>
                    )}
                  </div>
                );
              }
              return (
                <div key={input.name} className="asset-info-field">
                  <div className="asset-info-field-head">
                    <span className="asset-info-name">{input.name}</span>
                    <CopyButton text={input.value} />
                  </div>
                  <Value text={input.value} />
                  <Refs refs={input.refs} onOpen={setEnlarged} />
                </div>
              );
            })}
          </div>
        )}

        {info.prompts.length === 0 && info.inputs.length === 0 && (
          <p className="asset-info-empty">This asset declares no inputs.</p>
        )}
      </div>
    </Modal>
  );
}
