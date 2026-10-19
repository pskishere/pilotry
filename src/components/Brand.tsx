export function PilotryMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`pilotry-mark ${small ? "small" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none">
        <g
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="6" y="8" width="28" height="25" rx="3" />
          <path d="M6 15h28M11 11h1m4 0h1" />
          <path d="m14 27 12.5-7.5-5.8 13.1-2.3-4.3-4.4-1.3Z" />
          <path d="M18.4 28.3 26.5 19.5" />
        </g>
      </svg>
    </span>
  );
}
