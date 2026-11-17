import { readFile } from "node:fs/promises"
import { extractPdfText } from "../lib/pdf.js"
const buf = await readFile(process.argv[2])
const t0 = Date.now()
const { text, pages, scannedPages } = extractPdfText(buf)
console.log(`用时 ${Date.now()-t0}ms  页数=${pages}  空白页=${scannedPages}  字符数=${text.length}`)
console.log("--- 前 600 字 ---")
console.log(text.slice(0, 600))
console.log("--- 第 5000-5400 字 ---")
console.log(text.slice(5000, 5400))

