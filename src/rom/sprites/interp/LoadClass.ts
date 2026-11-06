/**
 * What the game's own level load does with a sprite-list entry (#1011): most ids fill a slot and run as a sprite, but the
 * loader sends a shooter, a generator and a scroll command elsewhere, and none has a sprite of its own to draw
 * (SMWDisX bank_02.asm:5223-5368, called from the sprite main loop at :1410).
 *
 * The class is read by effect, not by shape: the ROM's own routine runs on the 65816 core, once per id with a one-entry
 * list, and the class is the first of three RAM cells it writes (the scroll command, the generator number, the shooter
 * table; rammap.asm). A run that reaches its return with none of them is a normal sprite. The one fixed call site is
 * checked as a single JSR opcode, as are the 8 calls before it (the straight run back to the last branch target, :1402-1409),
 * and its target is READ from the operand, so a hack that moves the routine still reads; the target must open with a
 * load of a direct-page cell. A run that leaves ROM, hits BRK, spends the step cap or returns with the stack wrong makes
 * the whole table `status: 'unavailable'`, with the id and the reason. A return through another bank's mirror of bank 2
 * is a return.
 *
 * Each run must read the entry's id before it writes or returns, and the table must hold both routed and normal ids, or
 * it proves nothing and is unavailable. Within each class the value written must step with the id (id minus a constant),
 * each class must be one run of at least two ids, and the runs must come shooter, generator, scroll; anything else is
 * unavailable (a hack that writes a cell for every id would otherwise read as a class). The scroll ids are then run again
 * with extra bit 3 of the entry set, because some hacks move the bands with it (measured); `of(id, true)` is `scroll`
 * only for an id that is a scroll command in both sweeps, storing the same value in the same cell (all or nothing: one
 * that differs takes every exemption), and `normal` for every other (the extra-bits gate keeps its box). Every run starts
 * from a restored machine with A, X and Y zero. Seeded: the sprite list pointer and one entry on the screen boundary, the
 * scroll direction that makes that boundary offset zero, DB = 2. Not seen: everything after the first write to a cell (a scroll command's setup call leaves ROM or unbalances the stack
 * on some ids past the table), extra bit 2 and a vertical level (no band moved), whether the game reaches the routine on
 * a given frame, what a hook does after the cell is written, the code before the walk, and a hook inside a called routine
 * that leaves the loop. Evidence: the vanilla and Magic ROMs read the same table, and three hacks; the ids and the other
 * ROMs are in docs/rom/map-data-mechanics.md (one machine, 2026-11-05).
 */
import { Refusal, SENTINEL, callSubroutine, type CallResult } from '../../cpu/call'
import type { Cpu65816 } from '../../cpu/Cpu65816'
import type { RomFile } from '../../RomFile'
import { mapperProblem } from './Guards'
import { RunCache, smwMachine } from './Machine'

export type LoadClass = 'normal' | 'shooter' | 'generator' | 'scroll'

export type LoadClasses =
  | { status: 'ok'; of: (id: number, extraBits?: boolean) => LoadClass }
  | { status: 'unavailable'; reason: string }

/** The call in the sprite main loop (bank_02.asm:1410): one JSR opcode, whose operand is the routine. */
const CALL_SITE = 0x028b1d
const JSR = 0x20
/** The calls in a straight run before the site, back to the last branch target (bank_02.asm:1402-1409), 3 bytes each. */
const CALLS_BEFORE = 8
/** The routine opens with a load of a direct-page cell (bank_02.asm:5224). */
const LDA_DP = 0xa5
const BANK2 = 0x020000
/** The routine reads its tables with absolute-word operands, so DB is its own bank. */
const ENTRY_DB = 2
/** Instructions one id may take; the longest vanilla run is far below it, and a hack that loops is refused. */
const STEP_CAP = 50_000
// RAM cells (rammap.asm): the scroll command (:1566), the generator number (:1873), the 8 shooter slots (:1789).
const SCROLL_CMD = 0x143e
const GENERATOR = 0x18b9
const SHOOTER_TABLE = 0x1783
const SHOOTER_SLOTS = 8
// Seeds: the list pointer (:939), the scroll direction whose boundary offset is zero (:435), where the list sits in WRAM.
const SPRITE_DATA_PTR = 0xce
const SCROLL_DIR = 0x55
const LIST_AT = 0xe000
const WRAM_BANK = 0x7e
const BOUNDARY_ZERO = 1
const LIST_END = 0xff
/** The entry's flags byte holds the extra bits; bit 3 is the one that moves ids on some hacks (measured). */
const EXTRA_BIT_3 = 0x08
const [FLAGS_AT, ID_AT, END_AT] = [1, 3, 4]

/** One id's verdict: its class and the value the decisive write stored (0 for a normal one). */
interface Row {
  cls: LoadClass
  value: number
}

/** The class the cell `off` of WRAM belongs to, or null. */
const classOfCell = (off: number): LoadClass | null =>
  off === SCROLL_CMD
    ? 'scroll'
    : off === GENERATOR
      ? 'generator'
      : off >= SHOOTER_TABLE && off < SHOOTER_TABLE + SHOOTER_SLOTS
        ? 'shooter'
        : null

/** An unreadable loader, with the reason. */
const fail = (reason: string): LoadClasses => ({ status: 'unavailable', reason })

/** The routine's address from the call site, or why this ROM's call cannot be followed. */
function entryOf(rom: RomFile): number | string {
  const site = rom.readAt(CALL_SITE, 3)
  if (!site || site[0] !== JSR)
    return 'the sprite main loop does not call the level loader at the place it does in the game'
  // A hack that diverts just before the site would leave the site intact: only the opcodes of the run are looked at.
  for (let k = 1; k <= CALLS_BEFORE; k++)
    if (rom.readAt(CALL_SITE - 3 * k, 1)?.[0] !== JSR)
      return "the sprite main loop has been changed just before the level loader's call"
  const entry = BANK2 | site[1]! | (site[2]! << 8)
  return rom.readAt(entry, 1)?.[0] === LDA_DP
    ? entry
    : "the level loader's call goes to something that does not open the way the loader does"
}

/** Whether a call ended at its return; a stack-balanced arrival at the return address in another bank's mirror of bank 2 counts. */
const returned = (r: CallResult, cpu: Cpu65816): boolean =>
  r.kind === 'returned' ||
  (r.kind === 'unbalanced' &&
    cpu.pc === SENTINEL &&
    r.s === r.expected &&
    (r.pb & 0x7f) === (r.expectedPb & 0x7f))

/** Why a run that decided nothing did not return. */
const whyNot = (r: CallResult): string =>
  r.kind === 'refused'
    ? r.reason
    : r.kind === 'budget'
      ? `did not return within ${STEP_CAP} steps`
      : 'returned with the stack or the bank wrong'

/** The first thing wrong with the bands the 256 runs gave, or null: some routed and some normal ids, then per class one run of at least two ids, in order, each value stepping with its id. */
function bandsProblem(rows: Row[]): string | null {
  const routed = rows.filter(r => r.cls !== 'normal').length
  if (routed === 0 || routed === rows.length) return 'the runs do not tell routed ids from sprites'
  let after = -1
  for (const cls of ['shooter', 'generator', 'scroll'] as const) {
    const ids = rows.flatMap((r, id) => (r.cls === cls ? [id] : []))
    if (!ids.length) continue
    const [first, last] = [ids[0]!, ids[ids.length - 1]!]
    if (last - first + 1 !== ids.length) return `the ${cls} ids are not one run`
    if (first <= after) return `the ${cls} ids do not come after the earlier class`
    // One id has nothing to step against, so a single flat value could be any cell write.
    if (ids.length < 2) return `the ${cls} ids are a single id, so its value cannot be checked`
    if (ids.some(id => rows[id]!.value - id !== rows[first]!.value - first))
      return `the ${cls} value does not step with the id`
    after = last
  }
  return null
}

const cache = new RunCache<LoadClasses>()

/** The game's own routing of a sprite-list id, read from this ROM by running its routine (or why it cannot be read). Cached by the ROM bytes the runs read. */
export function loadClasses(rom: RomFile): LoadClasses {
  // Neither check is a bus read, so neither can be left to the cache's key.
  const entry = entryOf(rom)
  if (typeof entry === 'string') return fail(entry)
  const mapper = mapperProblem(rom)
  if (mapper) return fail(mapper)
  const key = `loadClasses ${entry}`
  return cache.lookup(rom, key) ?? run(rom, entry, key)
}

/** Runs the routine for each id, then the scroll ids again with extra bit 3 set, on one machine put back between runs, and remembers the verdict. */
function run(rom: RomFile, entry: number, key: string): LoadClasses {
  const { bus, cpu } = smwMachine(rom)
  const w = bus.wram
  w[SCROLL_DIR] = BOUNDARY_ZERO
  w.set([LIST_AT & 0xff, LIST_AT >> 8, WRAM_BANK], SPRITE_DATA_PTR)
  w[LIST_AT + END_AT] = LIST_END // the list is: a header byte, then flags, x and id, then the end mark
  const seeded = bus.snapshot()
  const seen: { row: Row | null; read: boolean } = { row: null, read: false }
  bus.onRead = off => {
    if (off === LIST_AT + ID_AT) seen.read = true
  }
  bus.onWramWrite = (off, value) => {
    const cls = classOfCell(off)
    if (!cls) return
    seen.row = { cls, value }
    throw new Refusal('decided') // the class is known at the first write; what follows is not run
  }
  cache.track(bus, rom)
  /** One row per id of `ids`, run with `flags` in the entry, or why the runs prove nothing. */
  const sweep = (flags: number, ids: number[]): Row[] | string => {
    const rows: Row[] = []
    for (const id of ids) {
      bus.restore(seeded) // WRAM, SRAM and the multiply units: no run sees an earlier run's state
      w[LIST_AT + FLAGS_AT] = flags
      w[LIST_AT + ID_AT] = id
      seen.row = null
      seen.read = false
      const regs = { db: ENTRY_DB, a: 0, x: 0, y: 0 }
      const r = callSubroutine(cpu, entry, { kind: 'jsr', maxSteps: STEP_CAP, regs })
      const at = `id $${id.toString(16).toUpperCase().padStart(2, '0')}`
      // A run that never read the entry decided nothing about it, whatever it wrote or returned.
      if (!seen.read) return `${at}: the routine finished without reading the list entry`
      if (seen.row) rows.push(seen.row)
      else if (returned(r, cpu)) rows.push({ cls: 'normal', value: 0 })
      else return `${at}: ${whyNot(r)}`
    }
    return rows
  }
  const plain = sweep(
    0,
    Array.from({ length: 256 }, (_, id) => id),
  )
  const bad = typeof plain === 'string' ? plain : bandsProblem(plain)
  if (bad || typeof plain === 'string') return cache.store(rom, key, bus, fail(bad!))
  // With bit 3 set, only the plain scroll ids are run again: it stays a scroll command only if every one stores the same value
  // in the same cell. Any other id gets no exemption from the extra-bits gate, so its box stays.
  const scrolls = plain.flatMap((r, id) => (r.cls === 'scroll' ? [id] : []))
  const again = sweep(EXTRA_BIT_3, scrolls)
  // All or nothing: one id that differs means the bit changes what the routine does with scroll ids, so none is trusted.
  const agree =
    typeof again !== 'string' &&
    scrolls.every((id, k) => again[k]!.cls === 'scroll' && again[k]!.value === plain[id]!.value)
  const exempt = new Set(agree ? scrolls : [])
  const result: LoadClasses = {
    status: 'ok',
    of: (id, extraBits) =>
      extraBits ? (exempt.has(id) ? 'scroll' : 'normal') : (plain[id]?.cls ?? 'normal'),
  }
  return cache.store(rom, key, bus, result)
}
