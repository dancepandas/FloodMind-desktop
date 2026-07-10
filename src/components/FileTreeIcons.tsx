/** Outline-style file tree icons: gray stroke + white fill. */
export function FolderClosedIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="white"
      stroke="#9ca3af"
      strokeWidth="1.2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 3.5a.5.5 0 0 1 .5-.5h4.5l1.5 1.5h6a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-12a.5.5 0 0 1-.5-.5z" />
    </svg>
  );
}

export function FolderOpenIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="white"
      stroke="#9ca3af"
      strokeWidth="1.2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 3.5a.5.5 0 0 1 .5-.5h4.5l1.5 1.5h6a.5.5 0 0 1 .5.5v1.5l-1.2 5.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5z" />
    </svg>
  );
}

export function FileOutlineIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="white"
      stroke="#9ca3af"
      strokeWidth="1.2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 1.5a.5.5 0 0 1 .5-.5h5l4 4v9.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5z" />
      <path d="M8.5 1v4h4" fill="none" />
    </svg>
  );
}
