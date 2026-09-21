import { useState } from "react";
import { ConfigTab } from "./config-tab.js";
import { CredentialsTab } from "./credentials-tab.js";
import { SETTINGS_TABS, type SettingsTab } from "./types.js";

const TAB_LABELS: Record<SettingsTab, string> = {
  config: "Config",
  credentials: "Credentials",
};

const TAB_FILES: Record<SettingsTab, string> = {
  config: "konte.config.json",
  credentials: "konte.credentials.json",
};

function initialTab(): SettingsTab {
  const requested = new URLSearchParams(location.search).get("tab");
  return SETTINGS_TABS.includes(requested as SettingsTab) ? (requested as SettingsTab) : "config";
}

export function App() {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  return (
    <div className="app">
      <header className="app-header">
        <h1>konte settings</h1>
        <nav className="tabs">
          {SETTINGS_TABS.map((name) => (
            <button
              key={name}
              type="button"
              className={name === tab ? "tab tab-active" : "tab"}
              onClick={() => setTab(name)}
            >
              {TAB_LABELS[name]}
            </button>
          ))}
        </nav>
        <code className="app-file">{TAB_FILES[tab]}</code>
      </header>
      {tab === "config" ? <ConfigTab /> : <CredentialsTab />}
    </div>
  );
}
