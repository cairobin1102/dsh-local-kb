import assert from 'node:assert/strict'
import { extractPdfText, isPdfBuffer, PdfError } from '../lib/pdf.js'
import { readSourceText } from '../lib/scan.js'

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}\n     ${error?.message ?? error}`)
  }
}

/** 拼一个最小 PDF：对象数组，每项是对象体（不含 "N 0 obj"）。 */
function buildPdf(bodies) {
  const parts = ['%PDF-1.4\n']
  bodies.forEach((body, index) => {
    parts.push(`${index + 1} 0 obj\n${body}\nendobj\n`)
  })
  parts.push('trailer\n<< /Root 1 0 R >>\n%%EOF\n')
  return Buffer.from(parts.join(''), 'latin1')
}

const CMAP = `<< /Length 200 >>
stream
/CIDInit /ProcSet findresource begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfchar
<0001> <4E61>
endbfchar
1 beginbfchar
<0002> <6751>
endbfchar
1 beginbfchar
<0003> <632F>
endbfchar
1 beginbfchar
<0004> <5174>
endbfchar
endcmap
endstream`

function textPdf() {
  const page = '<< /Type /Page /MediaBox [0 0 595 842] /Contents 2 0 R /Resources << /Font << /F1 3 0 R >> >> >>'
  const content = `<< /Length 96 >>
stream
BT /F1 12 Tf 72 700 Td <0001>Tj<0002>Tj<0003>Tj<0004>Tj ET
endstream`
  const font = '<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /ToUnicode 4 0 R >>'
  return buildPdf([page, content, font, CMAP])
}

function scannedPdf() {
  const page = '<< /Type /Page /MediaBox [0 0 595 842] /Contents 2 0 R /Resources << /XObject << /Im1 3 0 R >> >> >>'
  const content = `<< /Length 32 >>
stream
q 1 0 0 1 0 0 cm /Im1 Do Q
endstream`
  const image = '<< /Type /XObject /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n\0\0\0\0\nendstream'
  return buildPdf([page, content, image])
}

await test('pdf：按 ToUnicode 把字形码还原成文字', async () => {
  const buffer = textPdf()
  assert.equal(isPdfBuffer(buffer), true)
  const result = extractPdfText(buffer)
  assert.equal(result.pages, 1)
  assert.equal(result.scanned, false)
  assert.match(result.text, /乡村/)
})

await test('pdf：扫描件（没有文本层）给出可读错误，而不是返回空文本', async () => {
  assert.throws(() => extractPdfText(scannedPdf()), (error) => {
    assert.ok(error instanceof PdfError)
    assert.match(error.message, /没有文本层|OCR/)
    return true
  })
})

await test('pdf：不是 PDF 的文件直接报错', async () => {
  assert.throws(() => extractPdfText(Buffer.from('hello world', 'utf8')), /%PDF-/)
})

await test('scan.readSourceText：按文件头识别 PDF，即使扩展名是 .docx', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'local-kb-pdf-'))
  try {
    const file = path.join(dir, 'renamed.docx')
    await writeFile(file, textPdf())
    const text = await readSourceText(file, '.docx', 1024 * 1024)
    assert.match(text, /乡村/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('scan.readSourceText：扫描件有 OCR 兜底时改用识别结果', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'local-kb-ocr-'))
  try {
    const file = path.join(dir, '扫描件.pdf')
    await writeFile(file, scannedPdf())
    let called = 0
    const text = await readSourceText(file, '.pdf', 1024 * 1024, {
      ocrText: async (target) => {
        called += 1
        assert.equal(target, file)
        return '识别出来的正文：扫描件也能索引'
      },
    })
    assert.equal(called, 1)
    assert.match(text, /扫描件也能索引/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

console.log(`\n${passed}/${passed + failures.length} passed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error?.stack ?? failure.error}`)
  process.exit(1)
}
