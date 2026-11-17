import { createApi } from './api.js'
import { normalizeConfig } from './config.js'
import { createKnowledgeBase } from './kb.js'
import { createSecretStore } from './secrets.js'
import { createSettings } from './settings.js'
import { createToolDefinitions } from './tools.js'

export const inject = ['tools']

function promptText(options) {
  const lines = [
    `本机外挂了一个本地知识库（工具 kb_search / kb_read / kb_index），根目录是 \`${options.root}\`。`,
    '回答涉及该目录资料的问题前，先用 kb_search 检索；引用结论时写明文件相对路径与行号，需要原文用 kb_read。',
    '检索没命中时不要编造内容：换关键词再查一次，或直接说明知识库里没有。',
    '索引状态或需要重建时调用 kb_index。',
  ]
  if (options.rerank?.enabled) {
    lines.push('检索会自动经过重排模型（rerank）排序；mode=keyword 可跳过向量与重排。')
  }
  return lines.join('\n')
}

export function apply(ctx, config) {
  const options = normalizeConfig(config)
  const secrets = createSecretStore(ctx.get('credentials'))
  const kb = createKnowledgeBase(options, { secrets })
  const settings = createSettings({ ctx })

  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    const api = createApi({ ctx, kb, secrets, options, settings })
    ctx.effect(() => webServer.register(api.route()))
  }

  for (const definition of createToolDefinitions(kb)) {
    ctx.effect(() => ctx.tools.register(definition))
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (options.promptSection && options.root && systemPrompt) {
    ctx.effect(() =>
      systemPrompt.section({
        name: 'local-kb',
        order: 260,
        text: promptText(options),
      }),
    )
  }
}
