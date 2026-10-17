/**
 * Standard system-design whiteboard icons, drawn as stroke SVG glyphs in a
 * 48×48 box, centered on (0,0) so they can be placed with a <g transform>.
 */
export function IconGlyph({ icon, size = 30 }: { icon: string; size?: number }) {
  const s = size / 48;
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <g transform={`scale(${s}) translate(-24,-24)`}>
      {icon === 'phone' && (
        <g {...common}>
          <rect x="16" y="6" width="16" height="36" rx="3" />
          <line x1="21" y1="36" x2="27" y2="36" />
        </g>
      )}
      {icon === 'globe' && (
        <g {...common}>
          <circle cx="24" cy="24" r="17" />
          <ellipse cx="24" cy="24" rx="8" ry="17" />
          <line x1="7" y1="24" x2="41" y2="24" />
          <path d="M10 14 Q24 20 38 14" />
          <path d="M10 34 Q24 28 38 34" />
        </g>
      )}
      {icon === 'split' && (
        <g {...common}>
          <circle cx="10" cy="24" r="3.4" />
          <path d="M14 24 L26 24" />
          <path d="M26 24 L36 12 M26 24 L38 24 M26 24 L36 36" />
          <path d="M32 11 L37 12 L36 17 M33 23 L38 24 L33 25 M32 37 L36 36 L37 31" />
        </g>
      )}
      {icon === 'funnel' && (
        <g {...common}>
          <path d="M8 10 H40 L27 26 V38 L21 41 V26 Z" />
        </g>
      )}
      {icon === 'rack' && (
        <g {...common}>
          <rect x="12" y="6" width="24" height="36" rx="2" />
          <line x1="12" y1="18" x2="36" y2="18" />
          <line x1="12" y1="30" x2="36" y2="30" />
          <circle cx="17" cy="12" r="1.4" fill="currentColor" />
          <circle cx="17" cy="24" r="1.4" fill="currentColor" />
          <circle cx="17" cy="36" r="1.4" fill="currentColor" />
          <line x1="23" y1="12" x2="32" y2="12" />
          <line x1="23" y1="24" x2="32" y2="24" />
          <line x1="23" y1="36" x2="32" y2="36" />
        </g>
      )}
      {icon === 'list' && (
        <g {...common}>
          <circle cx="12" cy="13" r="1.8" fill="currentColor" />
          <circle cx="12" cy="24" r="1.8" fill="currentColor" />
          <circle cx="12" cy="35" r="1.8" fill="currentColor" />
          <line x1="19" y1="13" x2="40" y2="13" />
          <line x1="19" y1="24" x2="40" y2="24" />
          <line x1="19" y1="35" x2="34" y2="35" />
        </g>
      )}
      {icon === 'search' && (
        <g {...common}>
          <circle cx="21" cy="21" r="12" />
          <line x1="30" y1="30" x2="41" y2="41" />
        </g>
      )}
      {icon === 'lightning' && (
        <g {...common}>
          <path d="M27 4 L12 27 H22 L19 44 L36 19 H25 Z" />
        </g>
      )}
      {icon === 'cylinder' && (
        <g {...common}>
          <ellipse cx="24" cy="11" rx="13" ry="4.5" />
          <path d="M11 11 V37 C11 39.5 17 41.5 24 41.5 C31 41.5 37 39.5 37 37 V11" />
          <path d="M11 24 C11 26.5 17 28.5 24 28.5 C31 28.5 37 26.5 37 24" />
        </g>
      )}
      {icon === 'table' && (
        <g {...common}>
          <rect x="9" y="9" width="30" height="30" rx="2" />
          <line x1="9" y1="19" x2="39" y2="19" />
          <line x1="9" y1="29" x2="39" y2="29" />
          <line x1="19" y1="9" x2="19" y2="39" />
          <line x1="29" y1="9" x2="29" y2="39" />
        </g>
      )}
      {icon === 'bucket' && (
        <g {...common}>
          <ellipse cx="24" cy="11" rx="14" ry="4.5" />
          <path d="M10 11 L13.5 38 C13.8 40.6 18.5 42 24 42 C29.5 42 34.2 40.6 34.5 38 L38 11" />
          <path d="M11.5 24 C16 27 32 27 36.5 24" />
        </g>
      )}
      {icon === 'pipe' && (
        <g {...common}>
          <rect x="5" y="17" width="38" height="14" rx="3" />
          <line x1="15" y1="17" x2="15" y2="31" />
          <line x1="24" y1="17" x2="24" y2="31" />
          <line x1="33" y1="17" x2="33" y2="31" />
          <path d="M38 24 H30 M33 20.5 L30 24 L33 27.5" strokeWidth="2" />
        </g>
      )}
      {icon === 'gear' && (
        <g {...common}>
          <circle cx="24" cy="24" r="6.5" />
          <path d="M24 6 V12 M24 36 V42 M6 24 H12 M36 24 H42 M11.5 11.5 L15.7 15.7 M32.3 32.3 L36.5 36.5 M36.5 11.5 L32.3 15.7 M15.7 32.3 L11.5 36.5" />
          <circle cx="24" cy="24" r="13" strokeDasharray="4.1 6.1" strokeWidth="5" />
        </g>
      )}
    </g>
  );
}
