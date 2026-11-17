/**
 * API-key storage for the embedding and rerank slots.
 *
 * Resolution order (first non-empty wins):
 *   1. the DSH credential record named by `secretName` (written from the UI),
 *   2. the environment variable named by `apiKeyEnv`,
 *   3. the inline `apiKey` from the plugin config.
 *
 * Nothing here ever writes a plain-text key into the plugin config: the UI stores
 * the key as a credential record and remembers only the record name.
 */

const SLOT_RECORD = {
  embedding: 'local-kb/embedding',
  rerank: 'local-kb/rerank',
  ocr: 'local-kb/ocr',
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function mask(value) {
  const text = String(value ?? '')
  if (text.length <= 6) return '******'
  return `${text.slice(0, 3)}…${text.slice(-4)}`
}

export function createSecretStore(credentials) {
  const available = Boolean(
    credentials &&
      typeof credentials.readRecord === 'function' &&
      typeof credentials.modifyRecord === 'function',
  )

  /** Resolve the effective key for a slot; never throws for a missing key. */
  async function read(slot, settings = {}) {
    const name = trim(settings?.secretName)
    if (name && available) {
      try {
        const record = await credentials.readRecord(name)
        if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key !== '') {
          return record.key
        }
      } catch {
        // A broken store must not break retrieval; fall through to env/inline.
      }
    }
    const envName = trim(settings?.apiKeyEnv)
    if (envName) {
      const fromEnv = process.env[envName]
      if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
    }
    return typeof settings?.apiKey === 'string' ? settings.apiKey : ''
  }

  /** Store (or clear) the key for a slot; returns the record name to put in config. */
  async function save(slot, value) {
    if (!available) {
      throw new Error(
        '当前宿主没有可用的凭据服务，无法保存密钥：请改用环境变量（apiKeyEnv），或在 profile 里配置 credentials 插件。',
      )
    }
    const name = SLOT_RECORD[slot]
    if (!name) throw new Error(`未知的密钥槽位：${slot}`)
    const text = String(value ?? '')
    if (text === '') {
      await credentials.deleteRecord(name)
      return name
    }
    await credentials.modifyRecord(name, async () => ({ kind: 'api-key', key: text }))
    return name
  }

  /** Describe a slot's key for the settings UI without revealing it. */
  async function describe(slot, settings = {}) {
    const name = trim(settings?.secretName) || SLOT_RECORD[slot]
    const envName = trim(settings?.apiKeyEnv)
    const fromEnv = envName ? process.env[envName] : ''
    let configured = typeof settings?.apiKey === 'string' && settings.apiKey !== ''
    let source = configured ? 'config' : ''
    let masked = configured ? mask(settings.apiKey) : ''
    if (fromEnv) {
      configured = true
      source = 'env'
      masked = mask(fromEnv)
    }
    if (available) {
      try {
        const record = await credentials.readRecord(name)
        if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key !== '') {
          configured = true
          source = 'credential'
          masked = mask(record.key)
        }
      } catch {
        // ignore: describe() is advisory only
      }
    }
    return { configured, source, masked, secretName: name, envName, writable: available }
  }

  return { available, read, save, describe, slotRecord: (slot) => SLOT_RECORD[slot] }
}
