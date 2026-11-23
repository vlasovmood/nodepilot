import type { BackupEncryption, BackupJob } from '../../api/types'

/** age public key: `age1` + bech32 data. A light check — the server validates the key itself. */
export const isAgeRecipient = (k: string) => /^age1[0-9a-z]{20,}$/.test(k)

/** Encryption mode of a job; jobs saved before `encryption` existed only have `encrypt`. */
export const jobEncryption = (j: Pick<BackupJob, 'encrypt' | 'encryption'>): BackupEncryption =>
  j.encryption === 'none' || j.encryption === 'passphrase' || j.encryption === 'recipients'
    ? j.encryption
    : j.encrypt
      ? 'passphrase'
      : 'none'
