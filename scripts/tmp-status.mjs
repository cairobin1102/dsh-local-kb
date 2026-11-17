import { normalizeConfig } from './lib/config.js'
import { createLibraries } from './lib/libraries.js'
const options = normalizeConfig({ root: 'F:\\领导讲话知识库', embedding: { provider: 'none' } })
console.log('libraries:', JSON.stringify(options.libraries))
const libs = createLibraries(options, {})
const s = await libs.status({ library: undefined })
console.log('files', s.files, 'chunks', s.chunks, 'libs', s.libraries?.length)
