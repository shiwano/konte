import type React from "react";

function Svg({
  size = 16,
  children,
  ...rest
}: React.SVGProps<SVGSVGElement> & { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function PlayIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size} fill="currentColor" stroke="none">
      <path d="M7 4.5v15a.7.7 0 0 0 1.06.6l12.2-7.5a.7.7 0 0 0 0-1.2L8.06 3.9A.7.7 0 0 0 7 4.5Z" />
    </Svg>
  );
}

export function PauseIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size} fill="currentColor" stroke="none">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </Svg>
  );
}

export function LoopIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </Svg>
  );
}

export function SkipToStartIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size} fill="currentColor" stroke="none">
      <rect x="4" y="5" width="2.5" height="14" rx="0.6" />
      <path d="M13.8 5.6v12.8a.6.6 0 0 1-.92.5l-4.55-6.4a.6.6 0 0 1 0-1l4.55-6.4a.6.6 0 0 1 .92.5Z" />
      <path d="M20.4 5.6v12.8a.6.6 0 0 1-.92.5l-4.55-6.4a.6.6 0 0 1 0-1l4.55-6.4a.6.6 0 0 1 .92.5Z" />
    </Svg>
  );
}

export function StepBackIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size} fill="currentColor" stroke="none">
      <rect x="5" y="5" width="2.5" height="14" rx="0.6" />
      <path d="M19 5.6v12.8a.6.6 0 0 1-.92.5l-9.1-6.4a.6.6 0 0 1 0-1l9.1-6.4a.6.6 0 0 1 .92.5Z" />
    </Svg>
  );
}

export function StepForwardIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size} fill="currentColor" stroke="none">
      <path d="M5 5.6v12.8a.6.6 0 0 0 .92.5l9.1-6.4a.6.6 0 0 0 0-1L5.92 5.1a.6.6 0 0 0-.92.5Z" />
      <rect x="16.5" y="5" width="2.5" height="14" rx="0.6" />
    </Svg>
  );
}

export function CommentIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </Svg>
  );
}

export function CheckIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={2.5}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function XIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={2.5}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  );
}

export function PlusIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  );
}

export function PencilIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </Svg>
  );
}

export function GridIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <rect width="7" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
    </Svg>
  );
}

export function FilmIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M7 3v18M17 3v18M3 7.5h4M3 12h4M3 16.5h4M17 7.5h4M17 12h4M17 16.5h4" />
    </Svg>
  );
}

export function ImageIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <circle cx="9" cy="9" r="1.6" />
      <path d="m20 15-3.6-3.6a1.6 1.6 0 0 0-2.3 0L5 20.3" />
    </Svg>
  );
}

export function VolumeIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5a9 9 0 0 1 0 14" />
    </Svg>
  );
}

// Discard the session's edits — a counter-clockwise arrow back to where the review started.
export function ResetIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </Svg>
  );
}

// Staleness — a clock, for "this variant is behind what it was made from".
export function StaleIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Svg>
  );
}

export function FitIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
    </Svg>
  );
}

export function ExpandIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" />
    </Svg>
  );
}

export function CollapseIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <path d="M3 9h6V3M21 9h-6V3M3 15h6v6M21 15h-6v6" />
    </Svg>
  );
}

export function HelpIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9.3a2.8 2.8 0 0 1 5.4 1c0 1.9-2.8 2.5-2.8 2.5" />
      <path d="M12 17h.01" />
    </Svg>
  );
}

export function SparkleIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <path d="M9.9 2.7 11.4 7a1 1 0 0 0 .6.6l4.3 1.5a1 1 0 0 1 0 1.8L12 12.4a1 1 0 0 0-.6.6l-1.5 4.3a1 1 0 0 1-1.8 0L6.6 13a1 1 0 0 0-.6-.6L1.7 10.9a1 1 0 0 1 0-1.8L6 7.6a1 1 0 0 0 .6-.6l1.5-4.3a1 1 0 0 1 1.8 0Z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </Svg>
  );
}

export function InfoIcon({ size }: { size?: number }): React.ReactElement {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4.5" />
      <path d="M12 8h.01" />
    </Svg>
  );
}
