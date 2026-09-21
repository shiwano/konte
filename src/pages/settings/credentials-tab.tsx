import { useEffect, useState } from "react";
import { fetchCredentials, saveCredentials } from "./api.js";
import { Field, Section } from "./form.js";
import type { CredentialsPatch } from "../../core/types/credentials.js";
import type { CredentialEntry } from "./types.js";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function CredentialRow(props: {
  entry: CredentialEntry;
  value: string | undefined;
  onChange: (value: string) => void;
  onClear: () => void;
  cleared: boolean;
}) {
  const { entry } = props;
  const state = props.cleared
    ? { className: "badge badge-muted", text: "will be removed" }
    : entry.fromEnvironment
      ? { className: "badge badge-warn", text: "set in environment" }
      : entry.isSet
        ? { className: "badge badge-ok", text: "set" }
        : { className: "badge badge-muted", text: "not set" };

  return (
    <div className="credential">
      <div className="credential-head">
        <code>{entry.key}</code>
        <span className={state.className}>{state.text}</span>
      </div>
      {entry.label && <p className="credential-label">{entry.label}</p>}
      <Field
        label={entry.isSet ? "Replace value" : "Value"}
        type="password"
        value={props.value ?? ""}
        placeholder={entry.isSet ? "•••••••• (leave blank to keep)" : ""}
        autoComplete="new-password"
        onChange={props.onChange}
        note={
          <>
            {entry.help}
            {entry.obtainUrl && (
              <>
                {" "}
                <a href={entry.obtainUrl} target="_blank" rel="noreferrer">
                  {entry.obtainUrl}
                </a>
              </>
            )}
            {entry.fromEnvironment &&
              " An environment variable of this name is set and takes precedence over the stored value."}
          </>
        }
      />
      {entry.isSet && !props.cleared && (
        <button type="button" className="link" onClick={props.onClear}>
          Remove stored value
        </button>
      )}
    </div>
  );
}

export function CredentialsTab() {
  const [entries, setEntries] = useState<CredentialEntry[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<string[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [status, setStatus] = useState<{ kind: "error" | "saved"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    fetchCredentials()
      .then((res) => setEntries(res.entries))
      .catch((err: Error) => setStatus({ kind: "error", text: err.message }));

  useEffect(() => {
    void load();
  }, []);

  if (!entries) {
    return (
      <div className="tab-body">
        {status ? <p className="status status-error">{status.text}</p> : <p className="muted">…</p>}
      </div>
    );
  }

  const reset = (next: CredentialEntry[]) => {
    setEntries(next);
    setValues({});
    setCleared([]);
    setNewKey("");
    setNewValue("");
  };

  const save = async () => {
    const patch: CredentialsPatch = { set: {}, unset: [...cleared] };
    for (const [key, value] of Object.entries(values)) {
      if (value !== "") patch.set![key] = value;
    }
    const key = newKey.trim();
    if (key !== "") {
      if (!KEY_PATTERN.test(key)) {
        setStatus({
          kind: "error",
          text: `"${key}" is not an environment variable name: letters, digits and underscores, not starting with a digit.`,
        });
        return;
      }
      if (newValue !== "") patch.set![key] = newValue;
    }

    setSaving(true);
    try {
      const res = await saveCredentials(patch);
      reset(res.entries);
      setStatus({ kind: "saved", text: "Saved to konte.credentials.json" });
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const known = entries.filter((e) => e.known);
  const custom = entries.filter((e) => !e.known);

  return (
    <div className="tab-body">
      <p className="section-note">
        A stored value is never shown here, only whether it is set. konte loads these into the
        environment on every run, so a variable you export yourself always wins over the file.
      </p>

      <Section title="Backends and model hosts">
        {known.map((entry) => (
          <CredentialRow
            key={entry.key}
            entry={entry}
            value={values[entry.key]}
            cleared={cleared.includes(entry.key)}
            onChange={(v) => {
              setValues({ ...values, [entry.key]: v });
              setStatus(null);
            }}
            onClear={() => setCleared([...cleared, entry.key])}
          />
        ))}
      </Section>

      {custom.length > 0 && (
        <Section
          title="Other keys"
          note="Keys this workspace holds that konte does not ship: an adapter's own ${VAR}."
        >
          {custom.map((entry) => (
            <CredentialRow
              key={entry.key}
              entry={entry}
              value={values[entry.key]}
              cleared={cleared.includes(entry.key)}
              onChange={(v) => {
                setValues({ ...values, [entry.key]: v });
                setStatus(null);
              }}
              onClear={() => setCleared([...cleared, entry.key])}
            />
          ))}
        </Section>
      )}

      <Section
        title="Add a key"
        note="A custom adapter can name any variable in a model URL's ${VAR}."
      >
        <Field label="Name" value={newKey} placeholder="MY_TOKEN" onChange={setNewKey} />
        <Field
          label="Value"
          type="password"
          value={newValue}
          autoComplete="new-password"
          onChange={setNewValue}
        />
      </Section>

      <footer className="tab-footer">
        {status && <span className={`status status-${status.kind}`}>{status.text}</span>}
        <button type="button" className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save credentials"}
        </button>
      </footer>
    </div>
  );
}
