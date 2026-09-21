import type React from "react";

const STATUS_LABELS: Record<string, string> = {
  none: "Pending",
  accepted: "Accepted",
  stale: "Stale",
  changed: "Changed",
};

export function StatusBadge({
  status,
  label,
  title,
}: {
  status: string;
  label?: string;
  title?: string;
}): React.ReactElement {
  return (
    <span className={`status-badge status-badge--${status}`} title={title}>
      {label ?? STATUS_LABELS[status] ?? status}
    </span>
  );
}
