export function BrandLogo({ height = 40 }: { height?: number }) {
  return <img className="brand-wordmark" src={`${import.meta.env.BASE_URL}logo.png`} alt="NodePilot" height={height} draggable={false} />
}

export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="NodePilot">
      <rect x="13.6" y="13.6" width="36.8" height="36.8" rx="6.6" transform="rotate(45 32 32)" fill="var(--text)" />
      <path d="M23.5 21.5h5.3l7.3 11.6V21.5h4.9v21h-5.2l-7.4-11.7v11.7h-4.9z" fill="var(--bg)" />
    </svg>
  )
}
