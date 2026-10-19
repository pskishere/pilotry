export function PilotryMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`pilotry-mark ${small ? "small" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 28 28" fill="none">
        <path
          d="M14 3c1.1 6.2 3.8 8.9 10 10-6.2 1.1-8.9 3.8-10 10-1.1-6.2-3.8-8.9-10-10C10.2 11.9 12.9 9.2 14 3Z"
          fill="currentColor"
        />
        <path
          d="m23 2 1.2 3.8L28 7l-3.8 1.2L23 12l-1.2-3.8L18 7l3.8-1.2L23 2Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}
