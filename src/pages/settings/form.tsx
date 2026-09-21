import type { ReactNode } from "react";

export function Section(props: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{props.title}</h2>
      {props.note && <p className="section-note">{props.note}</p>}
      <div className="section-body">{props.children}</div>
    </section>
  );
}

export function Row(props: { children: ReactNode }) {
  return <div className="field-row">{props.children}</div>;
}

export function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number" | "password";
  placeholder?: string;
  note?: ReactNode;
  autoComplete?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete ?? "off"}
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.note && <span className="field-note">{props.note}</span>}
    </label>
  );
}

export function Toggle(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  note?: string;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>
        {props.label}
        {props.note && <span className="field-note">{props.note}</span>}
      </span>
    </label>
  );
}
