import { readFileSync, existsSync } from 'node:fs'

const base = 'C:/Users/R/.dsh/profiles/desktop/node_modules/dsh-local-kb'
for (const file of ['locale/zh.json', 'locale/en.json']) {
  const json = JSON.parse(readFileSync(`${base}/${file}`, 'utf8'))
  console.log(
    file,
    '| title:', json.meta.title,
    '| detail:', json.meta.detail,
    '| detail exists:', existsSync(`${base}/${json.meta.detail}`),
    '| description chars:', String(json.meta.description).length,
  )
}
const svg = readFileSync(`${base}/icon.svg`, 'utf8')
console.log('icon | bytes:', Buffer.byteLength(svg), '| viewBox 64x64:', svg.includes('viewBox="0 0 64 64"'), '| has gradient:', svg.includes('linearGradient'))
const pkg = JSON.parse(readFileSync(`${base}/package.json`, 'utf8'))
console.log('manifest |', pkg.name, pkg.version, '| exports:', Object.keys(pkg.exports).join(' , '))
console.log('manifest | files:', (pkg.files ?? []).join(' , '))
const filesPresent = ['lib/index.js', 'lib/kb.js', 'lib/tools.js', 'lib/chunk.js', 'lib/scan.js', 'lib/store.js', 'lib/embed.js', 'lib/config.js', 'cordis.patch.yml', 'README.md', 'icon.svg', 'docs/DETAIL.md']
console.log('runtime files present:', filesPresent.every((file) => existsSync(`${base}/${file}`)))
