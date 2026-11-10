/** Hand-drawn brand mark (no third-party logo). Decorative: the link around it carries the name. */
export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg className="brand-mark" aria-hidden="true" width={size} height={size} viewBox="0 0 40 40">
      <rect x="1" y="1" width="38" height="38" rx="11" fill="#fff" />
      <path d="M13 10h6v20h-6z" fill="#c8102e" />
      <path d="M22 10h5.5c4 0 6.5 2.2 6.5 5.3 0 2-1 3.5-2.8 4.3 2.3.7 3.8 2.5 3.8 5 0 3.4-2.8 5.4-7 5.4H22zm5 8c1.5 0 2.4-.8 2.4-2s-.9-1.9-2.4-1.9h-.6V18zm.6 8.2c1.7 0 2.7-.8 2.7-2.1s-1-2.1-2.7-2.1h-1.2v4.2z" fill="#16161a" />
    </svg>
  );
}
