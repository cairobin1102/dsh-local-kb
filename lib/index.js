import { createApi } from './api.js'
import { normalizeConfig } from './config.js'
import { createLibraries } from './libraries.js'
import { createSecretStore } from './secrets.js'
import { createSettings } from './settings.js'
import { createToolDefinitions } from './tools.js'

// webServer 必须是硬依赖：宿主重启后服务装配顺序会变，若在 apply 时才去
// ctx.get('webServer')，拿到的可能是 undefined，面板请求就会 404。
// credentials 故意不做硬依赖（缺它时工具仍要能用），但也不能在 apply 时抓一次快照：
// 传 getter，让它每次用到时再取——服务晚装配、或换了凭据实现都能自适应。
export const inject = ['tools', 'webServer']

function promptText(options) {
  const names = (options.libraries ?? []).map((library) => `「${library.name}」\`${library.root}\``)
  const lines = [
    names.length > 1
      ? `本机外挂了 ${names.length} 个本地知识库（工具 kb_search / kb_read / kb_index）：${names.join('、')}。`
      : `本机外挂了一个本地知识库（工具 kb_search / kb_read / kb_index），根目录是 ${names[0] ?? '（尚未配置）'}。`,
    '回答涉及这些目录资料的问题前，先用 kb_search 检索（默认检索所有库）；引用结论时写明库名、文件相对路径与行号，需要原文用 kb_read。',
    '检索没命中时不要编造内容：换关键词再查一次，或直接说明知识库里没有。',
    '索引状态或需要重建时调用 kb_index（可带 library 指定某个库）。',
  ]
  if (options.rerank?.enabled) {
    lines.push('检索会自动经过重排模型（rerank）排序；mode=keyword 可跳过向量与重排。')
  }
  return lines.join('\n')
}

export function apply(ctx, config) {
  const options = normalizeConfig(config)
  const secrets = createSecretStore(() => ctx.get('credentials'))
  const libraries = createLibraries(options, { secrets })
  const settings = createSettings({ ctx })

  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    const api = createApi({ ctx, kb: libraries, secrets, options, settings })
    ctx.effect(() => webServer.register(api.route()))
  }

  for (const definition of createToolDefinitions(libraries, options)) {
    ctx.effect(() => ctx.tools.register(definition))
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (options.promptSection && (options.libraries ?? []).length > 0 && systemPrompt) {
    ctx.effect(() =>
      systemPrompt.section({
        name: 'local-kb',
        order: 260,
        text: promptText(options),
      }),
    )
  }
}
