import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Edit } from '../model/edit'
import type { PhotoInfo } from '../model/photoInfo'
import { mergePhoto, photoPatch, type PhotoPatch } from './photoMerge'
import { uuid } from './uuid'

export interface PhotoRecord {
  /** Last operation per editable field, retained for idempotent journal recovery across tabs. */
  versions?: Record<string, string>
  id: string
  name: string
  width: number
  height: number
  added: number
  order: number
  edit: Edit
  favorite?: boolean
  /** Read from the file once. */
  info?: PhotoInfo
}

/** Your presets: saved edits, applied like pasted edits. The store once held the retired Recipes tool's, which show up as presets. */
export interface RecipeRecord {
  id: string
  name: string
  edit: Edit
  created: number
}

/** A blob's bytes, for browsers that refuse to store the Blob itself (see putBlob). */
interface BlobBytes {
  type: string
  bytes: ArrayBuffer
}

interface Schema extends DBSchema {
  photos: { key: string; value: PhotoRecord }
  originals: { key: string; value: Blob | BlobBytes }
  thumbSources: { key: string; value: Blob | BlobBytes }
  thumbs: { key: string; value: Blob | BlobBytes }
  recipes: { key: string; value: RecipeRecord }
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null
export function db() {
  dbp ??= openDB<Schema>('imaginary', 1, {
    upgrade(d) {
      d.createObjectStore('photos', { keyPath: 'id' })
      d.createObjectStore('originals')
      d.createObjectStore('thumbSources')
      d.createObjectStore('thumbs')
      d.createObjectStore('recipes', { keyPath: 'id' })
    },
  })
  return dbp
}

// Edits, favorites and removals reach IndexedDB asynchronously, edits at most every 400 ms per photo. Until a change is
// committed it is also in a journal in localStorage, written synchronously, so a reload or a closed tab right after it
// keeps it: loadAll replays a journal left behind. Writes and removals reach IndexedDB in the order they were made, and
// a write that fails stays pending (and journaled) for the next one.
const JOURNAL = 'imaginary.pending-photos'
// Each page owns its journal. Finishing a write in one tab must not erase another tab's pending work.
const journalKey = `${JOURNAL}:${uuid()}`
interface Journal {
  put: Record<string, PhotoRecord>
  del: string[]
  patches?: Record<string, PhotoPatch>
  at?: number
}
const pending = new Map<string, PhotoRecord>()
const patches = new Map<string, PhotoPatch>()
const observed = new Map<string, PhotoRecord>()
const listeners = new Set<(photos: PhotoRecord[]) => void>()
let clock = 0
const writer = uuid()
const SYNC = 'imaginary.photo-sync'
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SYNC) : null

function observe(p: PhotoRecord) {
  observed.set(p.id, p)
  for (const stamp of Object.values(p.versions ?? {})) clock = Math.max(clock, Number(stamp.split(':')[0]) || 0)
}
function stamp() {
  clock = Math.max(clock + 1, Date.now() * 1000)
  return `${String(clock).padStart(16, '0')}:${writer}`
}
function announce() {
  channel?.postMessage(null)
  try {
    localStorage.setItem(SYNC, uuid())
  } catch {
    /* BroadcastChannel still works. */
  }
}
export function onPhotosChanged(listener: (photos: PhotoRecord[]) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
async function refreshPhotos() {
  const records = (await (await db()).getAll('photos'))
    .filter((p) => !removing.has(p.id))
    .map((p) => mergePhoto(p, patches.get(p.id) ?? {}))
    .sort((a, b) => a.order - b.order)
  observed.clear()
  records.forEach(observe)
  listeners.forEach((notify) => notify(records))
}
if (channel) channel.onmessage = () => void refreshPhotos().catch(console.error)
const removing = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null
let queue: Promise<void> = Promise.resolve()

function journal() {
  try {
    if (!pending.size && !removing.size) localStorage.removeItem(journalKey)
    else
      localStorage.setItem(
        journalKey,
        JSON.stringify({
          put: Object.fromEntries(pending),
          patches: Object.fromEntries(patches),
          del: [...removing],
          at: Date.now(),
        } satisfies Journal),
      )
  } catch {
    // Storage refused (a private window, a full disk): IndexedDB alone, as before.
  }
}

export async function loadAll() {
  const d = await db()
  const journals: { key: string; text: string; value: Journal }[] = []
  try {
    // Include the old shared key so an update also recovers changes made by the previous version.
    for (const key of Object.keys(localStorage).filter((k) => k === JOURNAL || k.startsWith(`${JOURNAL}:`))) {
      const text = localStorage.getItem(key)
      if (!text) continue
      try {
        const value = JSON.parse(text) as Journal | null
        if (value) journals.push({ key, text, value })
      } catch {
        // One damaged journal must not prevent the others from being recovered.
      }
    }
  } catch {
    // Storage refused: read IndexedDB as usual.
  }
  if (journals.length) {
    journals.sort((a, b) => (a.value.at ?? 0) - (b.value.at ?? 0))
    // Changes a reload or a closed tab cut off: removals first, then the newest records of photos still kept.
    const del = new Set(journals.flatMap((j) => j.value.del ?? []))
    const tx = d.transaction(['photos', 'originals', 'thumbSources', 'thumbs'], 'readwrite')
    for (const id of del)
      for (const store of ['photos', 'originals', 'thumbSources', 'thumbs'] as const)
        void tx.objectStore(store).delete(id)
    for (const j of journals)
      for (const r of Object.values(j.value.put ?? {})) {
        const current = await tx.objectStore('photos').get(r.id)
        if (!del.has(r.id) && current) {
          const patch =
            j.value.patches?.[r.id] ??
            photoPatch(undefined, r, `${String((j.value.at ?? 0) * 1000).padStart(16, '0')}:legacy`)
          await tx.objectStore('photos').put(mergePhoto(current, patch))
        }
      }
    await tx.done
    try {
      for (const j of journals) {
        // Another page can update its journal while our transaction runs. Keep that newer snapshot.
        if (localStorage.getItem(j.key) === j.text) localStorage.removeItem(j.key)
      }
    } catch {
      /* nothing to clear */
    }
  }
  const records = (await d.getAll('photos')).sort((a, b) => a.order - b.order)
  records.forEach(observe)
  if (journals.length) announce()
  return records
}

export async function putPhoto(p: PhotoRecord) {
  await (await db()).put('photos', p)
  observe(p)
  announce()
}

export function putPhotoLater(p: PhotoRecord) {
  const delta = photoPatch(observed.get(p.id), p, stamp())
  if (!Object.keys(delta).length) return
  patches.set(p.id, { ...patches.get(p.id), ...delta })
  pending.set(p.id, p)
  observe(p)
  journal()
  timer ??= setTimeout(() => void flushPhotos(), 400)
}

/** Queue a snapshot of both edits and removals. Failed entries remain available for the next attempt. */
function persistPhotos(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const batch = [...pending.values()].map((photo) => ({ photo, patch: patches.get(photo.id)! }))
  const deleted = [...removing]
  if (!batch.length && !deleted.length) return queue
  const run = queue.then(async () => {
    const tx = (await db()).transaction(['photos', 'originals', 'thumbSources', 'thumbs'], 'readwrite')
    // Observe a failed transaction even if one of the requests below rejects first.
    const done = tx.done
    void done.catch(() => {})
    await Promise.all(
      deleted.flatMap((id) =>
        (['photos', 'originals', 'thumbSources', 'thumbs'] as const).map((store) => tx.objectStore(store).delete(id)),
      ),
    )
    for (const b of batch) {
      // A different tab may already have removed this photo and its original. An edit must not recreate it.
      const current = await tx.objectStore('photos').get(b.photo.id)
      if (current) await tx.objectStore('photos').put(mergePhoto(current, b.patch))
    }
    await done
    // Committed: what has not changed since leaves the pending set and this page's journal.
    for (const b of batch) {
      if (pending.get(b.photo.id) === b.photo) {
        pending.delete(b.photo.id)
        patches.delete(b.photo.id)
      } else {
        const latest = { ...patches.get(b.photo.id) }
        for (const [path, change] of Object.entries(b.patch))
          if (latest[path]?.stamp === change.stamp) delete latest[path]
        patches.set(b.photo.id, latest)
      }
    }
    for (const id of deleted) removing.delete(id)
    journal()
    // Other tabs re-read on this announcement. This page does not: its own edits are already in memory, and a newer
    // change merged in from another tab arrives with that tab's announcement. Re-reading the whole library after every
    // save stalled drags (about 100 ms per save at 1,500 photos).
    announce()
  })
  // A rejected write must not block later attempts; the caller still gets its failure.
  queue = run.catch(() => {})
  return run
}

/** Attempts pending writes and removals now. Failed changes remain journaled for a later flush or reload. */
export function flushPhotos(): Promise<void> {
  return persistPhotos().catch((e) => console.error(e))
}

export function deletePhotos(ids: string[]): Promise<void> {
  for (const id of ids) {
    pending.delete(id)
    patches.delete(id)
    observed.delete(id)
    removing.add(id)
  }
  journal()
  return persistPhotos()
}

// A page going away or out of sight writes what is pending now (the journal covers what does not land).
if (typeof window !== 'undefined') {
  addEventListener('pagehide', () => void flushPhotos())
  addEventListener('focus', () => void refreshPhotos().catch(console.error))
  addEventListener('storage', (e) => {
    if (e.key === SYNC && !channel) void refreshPhotos().catch(console.error)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushPhotos()
  })
}

type BlobStore = 'originals' | 'thumbSources' | 'thumbs'

// WebKit refuses Blobs in IndexedDB in private windows ("Error preparing Blob/File data to be stored in
// object store"); the bytes are stored instead and come back out as a Blob. A full disk is not retried.
export async function putBlob(store: BlobStore, id: string, b: Blob) {
  const d = await db()
  try {
    await d.put(store, b, id)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') throw e
    await d.put(store, { type: b.type, bytes: await b.arrayBuffer() }, id)
  }
}

export async function getBlob(store: BlobStore, id: string): Promise<Blob | undefined> {
  const v = await (await db()).get(store, id)
  return !v || v instanceof Blob ? v : new Blob([v.bytes], { type: v.type })
}

export async function loadUserPresets(): Promise<RecipeRecord[]> {
  return (await (await db()).getAll('recipes')).sort((a, b) => a.created - b.created)
}
export const putUserPreset = async (r: RecipeRecord) => (await db()).put('recipes', r)
export const deleteUserPreset = async (id: string) => (await db()).delete('recipes', id)
