import { useEffect, useState } from "react";
import { ConfigTab } from "./config-tab.js";
import { CredentialsTab } from "./credentials-tab.js";
import { SESSION_LOST_EVENT, type SessionState } from "./session.js";
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

export function App({ initialSession }: { initialSession: SessionState }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [ended, setEnded] = useState(false);
  const [session, setSession] = useState(initialSession);

  useEffect(() => {
    const onEnded = () => setEnded(true);
    const onLost = () => setSession("expired");
    window.addEventListener("konte:session-ended", onEnded);
    window.addEventListener(SESSION_LOST_EVENT, onLost);
    return () => {
      window.removeEventListener("konte:session-ended", onEnded);
      window.removeEventListener(SESSION_LOST_EVENT, onLost);
    };
  }, []);

  if (ended) {
    return (
      <div className="app">
        <h1>Settings closed</h1>
        <p>You can close this tab.</p>
      </div>
    );
  }

  if (session === "unreachable") {
    return (
      <div className="app">
        <h1>Settings did not answer</h1>
        <p>Reload this page to try again.</p>
      </div>
    );
  }

  if (session === "expired") {
    return (
      <div className="app">
        <h1>Settings link expired</h1>
        <p>
          This link has already been used, or belongs to another run. Run{" "}
          <code>konte settings</code> again to open a new one.
        </p>
      </div>
    );
  }

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
