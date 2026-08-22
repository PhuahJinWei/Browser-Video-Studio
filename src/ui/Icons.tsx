/**
 * Studio icon vocabulary.
 *
 * Generic interface symbols come from Lucide so their proportions and stroke
 * language stay consistent as the application grows. Editing-specific concepts
 * remain local: a generic package cannot know what this timeline means by ripple,
 * fade, transition, edit point, solo, or fit-to-pane.
 */

import {
  AudioLines,
  Camera,
  Check,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  File,
  Flag,
  Folder,
  FolderPlus,
  FolderUp,
  Gauge,
  Grid2X2,
  Link,
  List,
  Lock,
  LockOpen,
  Maximize,
  Minimize,
  Moon,
  MousePointer2,
  Palette,
  PanelRight,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  Search,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Sun,
  ToggleLeft,
  ToggleRight,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  Unlink,
  Upload,
  Video,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';

export interface IconProps {
  readonly size?: number;
  readonly title?: string;
}

/** Adapt Lucide to the small API every existing call site already uses. */
function lucide(Component: LucideIcon): (props: IconProps) => React.JSX.Element {
  return function LucideStudioIcon({ size = 14, title }: IconProps): React.JSX.Element {
    return (
      <Component
        size={size}
        strokeWidth={2}
        color="currentColor"
        aria-hidden={title ? undefined : true}
        aria-label={title}
        role={title ? 'img' : undefined}
        focusable="false"
      />
    );
  };
}

/** Shared canvas for the domain-specific icons below. */
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

// Generic interface and transport icons — Lucide-backed.
export const IconPlay = lucide(Play);
export const IconPause = lucide(Pause);
export const IconSkipStart = lucide(SkipBack);
export const IconSkipEnd = lucide(SkipForward);
export const IconStepBack = lucide(StepBack);
export const IconStepForward = lucide(StepForward);
export const IconSplit = lucide(Scissors);
export const IconTrash = lucide(Trash2);
export const IconUndo = lucide(Undo2);
export const IconRedo = lucide(Redo2);
export const IconCopy = lucide(Copy);
export const IconUnlink = lucide(Unlink);
export const IconLink = lucide(Link);
export const IconVolume = lucide(Volume2);
export const IconMuted = lucide(VolumeX);
export const IconEye = lucide(Eye);
export const IconEyeOff = lucide(EyeOff);
export const IconLock = lucide(Lock);
export const IconUnlocked = lucide(LockOpen);
export const IconPlus = lucide(Plus);
export const IconClose = lucide(X);
export const IconVideo = lucide(Video);
export const IconAudio = lucide(AudioLines);
export const IconText = lucide(Type);
export const IconGrid = lucide(Grid2X2);
export const IconList = lucide(List);
export const IconInspector = lucide(PanelRight);
export const IconSwatch = lucide(Palette);
export const IconExport = lucide(Upload);
export const IconDownload = lucide(Download);
export const IconFile = lucide(File);
export const IconFullscreen = lucide(Maximize);
export const IconExitFullscreen = lucide(Minimize);
export const IconMarker = lucide(Flag);
export const IconGauge = lucide(Gauge);
export const IconToggleOn = lucide(ToggleRight);
export const IconToggleOff = lucide(ToggleLeft);
export const IconCamera = lucide(Camera);
export const IconCursor = lucide(MousePointer2);
export const IconFolder = lucide(Folder);
export const IconFolderPlus = lucide(FolderPlus);
export const IconFolderUp = lucide(FolderUp);
export const IconZoomIn = lucide(ZoomIn);
export const IconZoomOut = lucide(ZoomOut);
export const IconSun = lucide(Sun);
export const IconMoon = lucide(Moon);
export const IconSearch = lucide(Search);
export const IconAlert = lucide(TriangleAlert);
export const IconMore = lucide(Ellipsis);
export const IconDisclosure = lucide(ChevronRight);
export const IconCheck = lucide(Check);

// Timeline/editor concepts — deliberately custom.

/** Previous edit point, distinct from skipping to the start of media. */
export const IconPrevEdit = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M19 5v14l-9-7 9-7z" fill="currentColor" stroke="none" />
    <path d="M10 5v14L4 12l6-7z" fill="currentColor" stroke="none" />
  </Svg>
);

/** Next edit point, distinct from skipping to the end of media. */
export const IconNextEdit = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5 5v14l9-7-9-7z" fill="currentColor" stroke="none" />
    <path d="M14 5v14l6-7-6-7z" fill="currentColor" stroke="none" />
  </Svg>
);

/** Ripple delete: remove and close the timeline gap. */
export const IconRipple = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
    <path d="M2 12h3M19 12h3" />
  </Svg>
);

/** Solo means monitoring one track, not merely wearing headphones. */
export const IconSolo = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 14v-2a8 8 0 0116 0v2" />
    <rect x="2.5" y="14" width="4.5" height="6" rx="2" />
    <rect x="17" y="14" width="4.5" height="6" rx="2" />
  </Svg>
);

export const IconTransition = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 5v14M20 5v14M4 5l16 14M20 5L4 19" />
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

/** The razor is a timeline tool, not the generic scissors used by Split. */
export const IconRazor = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 4l8 8-3 3-5-5V4z" />
    <path d="M12 12l8 8" />
    <path d="M9 15l-4 4" />
  </Svg>
);

/** A fade wedge; `flip` mirrors it for fade-out. */
export const IconFade = ({ flip, ...p }: IconProps & { flip?: boolean }): React.JSX.Element => (
  <Svg {...p}>
    <path
      d={flip ? 'M3 19h18L3 5v14z' : 'M3 19h18V5L3 19z'}
      fill="currentColor"
      stroke="none"
    />
  </Svg>
);

/** Fit the sequence to its pane: two walls with arrows meeting between them. */
export const IconFit = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 5v14M20 5v14" />
    <path d="M8 12h8M10.5 9.5L8 12l2.5 2.5M13.5 9.5L16 12l-2.5 2.5" />
  </Svg>
);
