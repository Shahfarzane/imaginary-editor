// Camera RAW files, told apart by their first bytes: the TIFF family (DNG, NEF, ARW, CR2, PEF, ORF, RW2, SRW
// and most others), Canon CR3 (an ISO media file of brand "crx "), and Fujifilm RAF. A plain TIFF also matches
// the TIFF family; its decode is tried as RAW first and falls back to the browser.

export const RAW_EXTENSIONS = ['dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'sr2', 'srf', 'raf', 'orf', 'rw2', 'rwl', 'pef', 'srw', '3fr', 'iiq', 'x3f', 'kdc', 'mrw', 'erf', 'mef', 'mos']

/** A camera RAW file by its name. */
export const isRawName = (name: string) => RAW_EXTENSIONS.includes(name.slice(name.lastIndexOf('.') + 1).toLowerCase())

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))

export function isRawCandidate(head: Uint8Array): boolean {
  if (head.length < 16) return false
  const tiff = ascii(head, 0, 4)
  // II*\0 and MM\0*, plus Olympus (IIRO, IIRS, MMOR) and Panasonic (IIU\0) variants.
  if (tiff === 'II*\0' || tiff === 'MM\0*' || tiff === 'IIRO' || tiff === 'IIRS' || tiff === 'MMOR' || tiff === 'IIU\0') return true
  if (ascii(head, 4, 8) === 'ftypcrx ') return true
  return ascii(head, 0, 15) === 'FUJIFILMCCD-RAW'
}
