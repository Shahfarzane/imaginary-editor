import { useEffect, useState } from 'react'
import s from './DropZone.module.css'
import { useLibrary } from '../store/library'
import { RAW_EXTENSIONS } from '../engine/rawFormat'

let input: HTMLInputElement | null = null
export function openFilePicker() {
  if (!input) {
    input = document.createElement('input')
    input.type = 'file'
    input.accept = ['image/*', '.heic', '.heif', '.avif', '.tif', '.tiff', ...RAW_EXTENSIONS.map((x) => '.' + x)].join(',')
    input.multiple = true
    input.onchange = () => {
      if (input?.files) void useLibrary.getState().addFiles([...input.files])
      if (input) input.value = ''
    }
  }
  input.click()
}

export function DropZone() {
  const [over, setOver] = useState(false)
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setOver(true)
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) setOver(false)
    }
    const overFn = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setOver(false)
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length) void useLibrary.getState().addFiles(files)
    }
    const paste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (files.length) {
        e.preventDefault()
        void useLibrary.getState().addFiles(files)
      }
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', overFn)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', overFn)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [])
  return over ? (
    <div className={s.overlay}>
      <div className={s.box}>Drop to import</div>
    </div>
  ) : null
}
