/**
 * Write the knowledge-base settings back into the plugin config.
 *
 * The only supported path is the host's `configEditor`: it updates the profile's
 * cordis.patch.yml for us and reloads the plugin, so the new root / endpoints /
 * secret names take effect without editing YAML by hand.
 */

export function createSettings({ ctx }) {
  function editor() {
    return ctx.get('configEditor')
  }

  function entry() {
    const fiber = ctx.fiber
    return fiber?.entry ?? fiber ?? null
  }

  function available() {
    const service = editor()
    return Boolean(service && typeof service.edit === 'function' && entry())
  }

  async function save(next) {
    const service = editor()
    if (!service || typeof service.edit !== 'function') {
      throw new Error(
        '当前宿主没有配置编辑服务（configEditor），无法从界面保存设置：请直接编辑 profile 的 cordis.patch.yml。',
      )
    }
    const target = entry()
    if (!target) throw new Error('取不到本插件的配置项，无法保存设置。')

    const payload = {
      name: next.name,
      root: next.root,
      embedding: next.embedding,
      rerank: next.rerank,
      ocr: next.ocr,
    }

    await service.edit(target, (current) => {
      const base = current && typeof current === 'object' ? current : {}
      return { ...base, ...payload }
    })
    return payload
  }

  return { available, save }
}
