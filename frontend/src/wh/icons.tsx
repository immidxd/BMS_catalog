// Іконки Mini App складу — інлайн SVG (без шрифтів/бібліотек), 24×24, stroke.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size: number, p: P) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, ...p,
});

export const IQr = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <path d="M14 14h3v3h-3zM20 14h1M14 20h1M18 20h3M21 17v1" />
    <path d="M6 6h1M17 6h1M6 17h1" strokeWidth="2.4" />
  </svg>
);
export const IScan = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <path d="M3 12h18" />
  </svg>
);
export const ISearch = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const IBox = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16z" /><path d="M3.5 8 12 12.5 20.5 8M12 12.5v8" />
  </svg>
);
export const IBoxes = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}>
    <rect x="3" y="4" width="8" height="7" rx="1.5" /><rect x="13" y="4" width="8" height="7" rx="1.5" />
    <rect x="3" y="13" width="8" height="7" rx="1.5" /><rect x="13" y="13" width="8" height="7" rx="1.5" />
  </svg>
);
export const IPackIn = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="M12 3v11M8 10l4 4 4-4" /><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></svg>
);
export const IPackOut = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="M12 14V3M8 7l4-4 4 4" /><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></svg>
);
export const IMove = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="M4 8h13M14 5l3 3-3 3M20 16H7M10 13l-3 3 3 3" /></svg>
);
export const ICheck = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
);
export const ILock = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);
export const IUnlock = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" /></svg>
);
export const ITrash = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
);
export const IEdit = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z" /><path d="m13.5 6.5 3 3" /></svg>
);
export const IChevron = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="m9 6 6 6-6 6" /></svg>
);
export const IPlus = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IX = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const IMore = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><circle cx="6" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="18" cy="12" r="1.4" fill="currentColor" /></svg>
);
export const IAlert = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="M12 9v4M12 17h.01" /><path d="M10.3 4.3 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" /></svg>
);
export const IClock = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
);
export const IPhoto = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4 3 2.5 3.5-3.5L20 17" /></svg>
);
export const IRefresh = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></svg>
);
export const IPrinter = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="M7 8V4h10v4M7 16H4.5A1.5 1.5 0 0 1 3 14.5v-4A2.5 2.5 0 0 1 5.5 8h13A2.5 2.5 0 0 1 21 10.5v4a1.5 1.5 0 0 1-1.5 1.5H17" /><rect x="7" y="13" width="10" height="7" rx="1" /></svg>
);
export const IHome = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="M3.5 11 12 4l8.5 7" /><path d="M5.5 9.5V20h13V9.5" /><path d="M10 20v-6h4v6" /></svg>
);
export const ILink = ({ size = 24, ...p }: P) => (
  <svg {...base(size, p)}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" /></svg>
);
