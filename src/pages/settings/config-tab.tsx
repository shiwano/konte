import { useEffect, useState } from "react";
import {
  allowedHostIssue,
  comfyHeaderIssue,
  isSecretHeader,
  type KonteConfig,
} from "../../core/types/config.js";
import { fetchConfig, saveConfig } from "./api.js";
import { Field, Row, Section, Toggle } from "./form.js";

// Rows, not a record: a header being renamed passes through states with a duplicate or empty
// name, which a record would silently collapse mid-keystroke.
type HeaderRow = { name: string; value: string };

interface Draft {
  comfyUrl: string;
  comfyHeaders: HeaderRow[];
  autoInstallModels: boolean;
  autoInstallNodes: boolean;
  autoRebootAfterNodeInstall: boolean;
  unreachableTimeoutMinutes: string;
  ffmpegPath: string;
  ffprobePath: string;
  previewHost: string;
  previewAllowedHosts: string;
}

function num(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function toDraft(config: KonteConfig): Draft {
  return {
    comfyUrl: config.comfyui?.url ?? "",
    comfyHeaders: Object.entries(config.comfyui?.headers ?? {}).map(([name, value]) => ({
      name,
      value,
    })),
    autoInstallModels: config.comfyui?.autoInstallModels ?? true,
    autoInstallNodes: config.comfyui?.autoInstallNodes ?? true,
    autoRebootAfterNodeInstall: config.comfyui?.autoRebootAfterNodeInstall ?? true,
    unreachableTimeoutMinutes: num(config.comfyui?.unreachableTimeoutMinutes),
    ffmpegPath: config.local?.ffmpegPath ?? "",
    ffprobePath: config.local?.ffprobePath ?? "",
    previewHost: config.preview?.host ?? "",
    previewAllowedHosts: (config.preview?.allowedHosts ?? []).join(", "),
  };
}

class DraftError extends Error {}

function integer(label: string, raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) throw new DraftError(`${label} must be a whole number`);
  return parsed;
}

function text(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Mirrors the schema's own rule (comfyHeaderIssue), so a bad header is caught before the save.
function headers(rows: HeaderRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (name === "" && value === "") continue;
    if (name === "") throw new DraftError("A header needs a name");
    // Case-insensitive: two spellings of one field name would be joined into one value.
    if (Object.keys(out).some((k) => k.toLowerCase() === name.toLowerCase())) {
      throw new DraftError(`"${name}" is set twice (header names are case-insensitive)`);
    }
    const issue = comfyHeaderIssue(name, value);
    if (issue) throw new DraftError(issue);
    out[name] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

// Mirrors the schema's own rule (allowedHostIssue), so a bad pattern is caught before the save.
function allowedHosts(raw: string): string[] | undefined {
  const patterns = raw
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  for (const pattern of patterns) {
    const issue = allowedHostIssue(pattern);
    if (issue) throw new DraftError(issue);
  }
  return patterns.length === 0 ? undefined : patterns;
}

function fromDraft(draft: Draft): KonteConfig {
  return {
    comfyui: {
      url: text(draft.comfyUrl),
      headers: headers(draft.comfyHeaders),
      autoInstallModels: draft.autoInstallModels,
      autoInstallNodes: draft.autoInstallNodes,
      autoRebootAfterNodeInstall: draft.autoRebootAfterNodeInstall,
      unreachableTimeoutMinutes: integer("Unreachable timeout", draft.unreachableTimeoutMinutes),
    },
    local: {
      ffmpegPath: text(draft.ffmpegPath),
      ffprobePath: text(draft.ffprobePath),
    },
    preview: {
      host: text(draft.previewHost),
      allowedHosts: allowedHosts(draft.previewAllowedHosts),
    },
  };
}

function HeaderRows(props: { rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void }) {
  const update = (index: number, patch: Partial<HeaderRow>) =>
    props.onChange(props.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="field">
      <span className="field-label">Request headers</span>
      <span className="field-note">
        Sent on every request to this server, for a ComfyUI behind an auth front. Write the value as{" "}
        <code>{"${VAR}"}</code> and set the variable under Credentials; konte.config.json is not
        gitignored.
      </span>
      {props.rows.map((row, index) => (
        // Positional key: one derived from the name would remount the input on every keystroke.
        <Row key={index}>
          <Field
            label="Name"
            value={row.name}
            placeholder="Authorization"
            onChange={(v) => update(index, { name: v })}
          />
          <Field
            label="Value"
            value={row.value}
            placeholder={isSecretHeader(row.name) ? "${COMFYUI_TOKEN}" : "value or ${VAR}"}
            onChange={(v) => update(index, { value: v })}
          />
          <button
            type="button"
            className="link"
            onClick={() => props.onChange(props.rows.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </Row>
      ))}
      <div>
        <button
          type="button"
          className="link"
          onClick={() => props.onChange([...props.rows, { name: "", value: "" }])}
        >
          Add header
        </button>
      </div>
    </div>
  );
}

export function ConfigTab() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<{ kind: "error" | "saved"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchConfig()
      .then((config) => setDraft(toDraft(config)))
      .catch((err: Error) => setStatus({ kind: "error", text: err.message }));
  }, []);

  if (!draft) {
    return (
      <div className="tab-body">
        {status ? <p className="status status-error">{status.text}</p> : <p className="muted">…</p>}
      </div>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft({ ...draft, [key]: value });
    setStatus(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveConfig(fromDraft(draft));
      setDraft(toDraft(saved));
      setStatus({ kind: "saved", text: "Saved to konte.config.json" });
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tab-body">
      <Section
        title="ComfyUI"
        note="A server URL is what turns the ComfyUI backend on: leave it blank and generate refuses every comfy asset."
      >
        <Field
          label="Server URL"
          value={draft.comfyUrl}
          placeholder="http://127.0.0.1:8188"
          onChange={(v) => set("comfyUrl", v)}
        />
        <HeaderRows rows={draft.comfyHeaders} onChange={(rows) => set("comfyHeaders", rows)} />
        <Toggle
          label="Install missing models automatically"
          checked={draft.autoInstallModels}
          onChange={(v) => set("autoInstallModels", v)}
        />
        <Toggle
          label="Install missing custom node packs automatically"
          checked={draft.autoInstallNodes}
          onChange={(v) => set("autoInstallNodes", v)}
        />
        <Toggle
          label="Reboot ComfyUI after installing a node pack"
          note="A newly installed pack only loads on restart."
          checked={draft.autoRebootAfterNodeInstall}
          onChange={(v) => set("autoRebootAfterNodeInstall", v)}
        />
        <Field
          label="Unreachable timeout (minutes)"
          type="number"
          value={draft.unreachableTimeoutMinutes}
          placeholder="15"
          note="How long a job keeps polling a ComfyUI it cannot reach. 0 waits forever: right for a remote server, wrong for a local one."
          onChange={(v) => set("unreachableTimeoutMinutes", v)}
        />
      </Section>

      <Section
        title="Local tools"
        note="Leave blank to use the ffmpeg/ffprobe konte manages under .konte/tools/."
      >
        <Field
          label="ffmpeg path"
          value={draft.ffmpegPath}
          onChange={(v) => set("ffmpegPath", v)}
        />
        <Field
          label="ffprobe path"
          value={draft.ffprobePath}
          onChange={(v) => set("ffprobePath", v)}
        />
      </Section>

      <Section
        title="Preview access"
        note="Every route that is not loopback asks for a 4-digit PIN, printed when the preview starts. konte.config.json is not gitignored, so these travel with the repo."
      >
        <Field
          label="Bind address"
          value={draft.previewHost}
          placeholder="127.0.0.1"
          note="0.0.0.0 also listens on your local network, which is how a phone reaches the preview. The private addresses it listens on are admitted with it."
          onChange={(v) => set("previewHost", v)}
        />
        <Field
          label="Allowed hosts"
          value={draft.previewAllowedHosts}
          placeholder="review.example.com"
          note="Host names admitted on top of those, comma-separated, for a proxy you front the server with yourself. Such a proxy must pass the original Host through. A tunnel needs nothing here: it names its own host. * stands for one label, and a bare * admits any name."
          onChange={(v) => set("previewAllowedHosts", v)}
        />
      </Section>

      <footer className="tab-footer">
        {status && <span className={`status status-${status.kind}`}>{status.text}</span>}
        <button type="button" className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save config"}
        </button>
      </footer>
    </div>
  );
}
