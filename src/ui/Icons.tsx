/**
 * Inline SVG icons.
 *
 * Bundled as components rather than an icon font or sprite sheet so they inherit
 * `currentColor`, scale with the button, and add nothing to the network.
 * All are drawn on a 24×24 grid with a 2px stroke for a consistent weight.
 */

export interface IconProps {
  readonly size?: number;
  readonly title?: string;
}

function Svg({
  size = 14,
  title,
  children,
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
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
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

// ---------------------------------------------------------------- transport

export const IconPlay = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M6 4l14 8-14 8V4z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPause = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconSkipStart = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M20 5v14L9 12l11-7z" fill="currentColor" stroke="none" />
    <rect x="4" y="4" width="2.5" height="16" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconSkipEnd = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 5v14l11-7L4 5z" fill="currentColor" stroke="none" />
    <rect x="17.5" y="4" width="2.5" height="16" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);

/** Previous edit point. */
export const IconPrevEdit = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M19 5v14l-9-7 9-7z" fill="currentColor" stroke="none" />
    <path d="M10 5v14L4 12l6-7z" fill="currentColor" stroke="none" />
  </Svg>
);

/** Next edit point. */
export const IconNextEdit = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5 5v14l9-7-9-7z" fill="currentColor" stroke="none" />
    <path d="M14 5v14l6-7-6-7z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconStepBack = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M15 5v14L6 12l9-7z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconStepForward = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M9 5v14l9-7-9-7z" fill="currentColor" stroke="none" />
  </Svg>
);

// ------------------------------------------------------------------ editing

export const IconSplit = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.6" />
    <circle cx="6" cy="18" r="2.6" />
    <path d="M8.2 7.6L20 18M8.2 16.4L20 6" />
  </Svg>
);

export const IconTrash = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
  </Svg>
);

/** Ripple delete: remove and close the gap. */
export const IconRipple = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
    <path d="M2 12h3M19 12h3" />
  </Svg>
);

export const IconUndo = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 8h11a5 5 0 010 10H9" />
    <path d="M8 4L4 8l4 4" />
  </Svg>
);

export const IconRedo = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M20 8H9a5 5 0 000 10h6" />
    <path d="M16 4l4 4-4 4" />
  </Svg>
);

export const IconCopy = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 012-2h10" />
  </Svg>
);

/** Detach audio from video. */
export const IconUnlink = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M9 7H7a5 5 0 000 10h2M15 7h2a5 5 0 010 10h-2" />
    <path d="M3 3l18 18" />
  </Svg>
);

export const IconLink = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M9 7H7a5 5 0 000 10h2M15 7h2a5 5 0 010 10h-2M8 12h8" />
  </Svg>
);

// ------------------------------------------------------------- track states

export const IconVolume = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none" />
    <path d="M16.5 8.5a5 5 0 010 7" />
  </Svg>
);

export const IconMuted = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none" />
    <path d="M16 9.5l5 5M21 9.5l-5 5" />
  </Svg>
);

export const IconSolo = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 14v-2a8 8 0 0116 0v2" />
    <rect x="2.5" y="14" width="4.5" height="6" rx="2" />
    <rect x="17" y="14" width="4.5" height="6" rx="2" />
  </Svg>
);

export const IconEye = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.6" />
  </Svg>
);

export const IconEyeOff = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M2 12s3.5-6.5 10-6.5c1.6 0 3 .3 4.2.9M22 12s-3.5 6.5-10 6.5c-1.6 0-3-.3-4.2-.9" />
    <path d="M3 3l18 18" />
  </Svg>
);

export const IconLock = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V7a4 4 0 018 0v3.5" />
  </Svg>
);

export const IconUnlocked = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V7a4 4 0 017.5-2" />
  </Svg>
);

// --------------------------------------------------------------------- misc

export const IconPlus = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconClose = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconVideo = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="2.5" y="6" width="13" height="12" rx="2" />
    <path d="M15.5 11l6-3.5v9l-6-3.5z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconAudio = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
  </Svg>
);

export const IconText = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 6V4h16v2M12 4v16M8.5 20h7" />
  </Svg>
);

export const IconGrid = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </Svg>
);

export const IconList = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Svg>
);

export const IconInspector = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M14 4v16M17 9h1M17 13h1" />
  </Svg>
);

export const IconTransition = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 5v14M20 5v14M4 5l16 14M20 5L4 19" />
  </Svg>
);

export const IconSwatch = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 14l5-5 6 6M14 10l3-3 4 4" />
  </Svg>
);

export const IconExport = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M12 3v12M8 7l4-4 4 4" />
    <path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
  </Svg>
);

export const IconFile = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
    <path d="M14 3v5h5" />
  </Svg>
);

export const IconFullscreen = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);

export const IconExitFullscreen = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  </Svg>
);

export const IconGroup = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
    <path d="M13 7h4a2 2 0 012 2v2M11 17H7a2 2 0 01-2-2v-2" />
  </Svg>
);

export const IconUngroup = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
    <path d="M3 3l18 18" />
  </Svg>
);

export const IconMarker = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M6 3v18M6 4h13l-3 4 3 4H6" />
  </Svg>
);

export const IconGauge = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 17a8 8 0 1116 0" />
    <path d="M12 17l4.5-5" />
  </Svg>
);

export const IconToggleOn = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="2" y="7" width="20" height="10" rx="5" />
    <circle cx="17" cy="12" r="2.6" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconCamera = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3 8a2 2 0 012-2h2.5l1.5-2h6l1.5 2H21a0 0 0 010 0 2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
    <circle cx="12" cy="13" r="3.6" />
  </Svg>
);

/** The selection tool: an arrow pointer. */
export const IconCursor = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5 3l14 8-6 1.5L10 19 5 3z" />
  </Svg>
);

/** The razor: a blade that cuts a clip where you click. */
export const IconRazor = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 4l8 8-3 3-5-5V4z" />
    <path d="M12 12l8 8" />
    <path d="M9 15l-4 4" />
  </Svg>
);

export const IconFolder = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
  </Svg>
);

export const IconFolderPlus = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    <path d="M12 11.5v5M9.5 14h5" />
  </Svg>
);

/** Up one folder. */
export const IconFolderUp = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    <path d="M12 17v-5M9.5 14.5L12 12l2.5 2.5" />
  </Svg>
);

export const IconSearch = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L21 21" />
  </Svg>
);

/** Something is wrong with an asset — missing bytes, or a failed probe. */
export const IconAlert = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M12 4l9 16H3l9-16z" />
    <path d="M12 10v4M12 17h.01" />
  </Svg>
);

export const IconToggleOff = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="2" y="7" width="20" height="10" rx="5" />
    <circle cx="7" cy="12" r="2.6" fill="currentColor" stroke="none" />
  </Svg>
);
