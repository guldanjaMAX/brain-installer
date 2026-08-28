/** The lemniscate brand mark, stroked in the accent. Same path the Worker
 *  serves as the favicon and the link-preview image, so the invite, the tab
 *  and the page all show one thing. */
export function Mark({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg viewBox="6 24 88 52" className={className} aria-hidden>
      <path
        d="M50 50 C50 30 16 30 16 50 C16 70 50 70 50 50 C50 30 84 30 84 50 C84 70 50 70 50 50 Z"
        fill="none" stroke="currentColor" strokeWidth="13"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}
