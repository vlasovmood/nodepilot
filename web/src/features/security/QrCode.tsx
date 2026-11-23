import { useEffect, useState } from 'react'
import { Spinner } from '../../components/States'

/** QR code of `text` as an image. Always dark on white so phones can scan it in both themes. */
export function QrCode({ text, size = 184, label }: { text: string; size?: number; label: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    // The library is loaded only when a QR code is actually shown.
    import('qrcode')
      .then((QR) =>
        QR.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: size * 2, color: { dark: '#000000', light: '#ffffff' } }),
      )
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [text, size])

  return (
    <div className="qr-box" style={{ width: size, height: size }}>
      {src ? <img src={src} width={size} height={size} alt={label} /> : failed ? null : <Spinner />}
    </div>
  )
}
