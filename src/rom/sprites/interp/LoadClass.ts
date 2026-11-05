/**
 * What the game's own level load does with a sprite-list entry (#1011): most ids fill a slot and run as a sprite, but the
 * loader sends a shooter, a generator and a scroll command elsewhere, and none has a sprite of its own to draw
 * (SMWDisX bank_02.asm:5223-5368, called from the sprite main loop at :1410).
 *
 * The class is read by effect, not by shape: the ROM's own routine runs on the 65816 core, once per id with a one-entry
 * list, and the class is the first of three RAM cells it writes (the scroll command, the generator number, the shooter
 * table; rammap.asm). A run that reaches its return with none of them is a normal sprite. The one fixed call site is
 * checked as a single JSR opcode and its target is READ from the operand, so a hack that moves the routine still reads;
 * the target must open with a load of a direct-page cell. A run that leaves ROM, hits BRK, spends the step cap or
 * returns with the stack wrong makes the whole table `status: 'unavailable'`, with the id and the reason. A return
 * through another bank's mirror of bank 2 is a return.
 *
 * Within each class the value written must step with the id (id minus a constant), each class must be one run of ids,
 * and the runs must come shooter, generator, scroll; anything else is unavailable (a hack that writes a cell for every
 * id would otherwise read as a class). Seeded: the sprite list pointer and one entry on the screen boundary, the scroll
 * direction that makes that boundary offset zero, DB = 2. Not seen: everything after the first write to a cell (a scroll
 * command's setup call leaves ROM on ids past the table), whether the game reaches the routine on a given frame, and
 * what a hook does after the cell is written. Evidence: vanilla and the Magic ROM read the same table (ids 0-200 normal,
 * 201-202 shooter, 203-217 generator, 218-230 normal, 231-255 scroll); hacks in docs/rom/map-data-mechanics.md (one
 * machine, 2026-11-05).
 */
import { Refusal, SENTINEL, callSubroutine, type CallResult } from '../../cpu/call'
import type { Cpu65816 } from '../../cpu/Cpu65816'
import type { RomFile } from '../../RomFile'
import { RunCache, smwMachine } from './Machine'

export type LoadClass = 'normal' | 'shooter' | 'generator' | 'scroll'

export type LoadClasses =
  { status: 'ok'; of: (id: number) => LoadClass } | { status: 'unavailable'; reason: string }

/** The call in the sprite main loop (bank_02.asm:1410): one JSR opcode, whose operand is the routine. */
const CALL_SITE = 0x028b1d
const JSR = 0x20
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

/** The first thing wrong with the bands the 256 runs gave, or null: one run of ids per class, in order, each value stepping with its id. */
function bandsProblem(rows: Row[]): string | null {
  let after = -1
  for (const cls of ['shooter', 'generator', 'scroll'] as const) {
    const ids = rows.flatMap((r, id) => (r.cls === cls ? [id] : []))
    if (!ids.length) continue
    const [first, last] = [ids[0]!, ids[ids.length - 1]!]
    if (last - first + 1 !== ids.length) return `the ${cls} ids are not one run`
    if (first <= after) return `the ${cls} ids do not come after the earlier class`
    if (ids.some(id => rows[id]!.value - id !== rows[first]!.value - first))
      return `the ${cls} value does not step with the id`
    after = last
  }
  return null
}

const cache = new RunCache<LoadClasses>()

/** The game's own routing of a sprite-list id, read from this ROM by running its routine (or why it cannot be read). Cached by the ROM bytes the runs read. */
export function loadClasses(rom: RomFile): LoadClasses {
  const entry = entryOf(rom)
  if (typeof entry === 'string') return fail(entry)
  const key = `loadClasses ${entry}`
  return cache.lookup(rom, key) ?? run(rom, entry, key)
}

/** Runs the routine for each id on one machine, WRAM restored between ids, and remembers the verdict. */
function run(rom: RomFile, entry: number, key: string): LoadClasses {
  let machine: ReturnType<typeof smwMachine>
  try {
    machine = smwMachine(rom)
  } catch (e) {
    if (e instanceof Refusal) return fail(e.message)
    throw e
  }
  const { bus, cpu } = machine
  const w = bus.wram
  w[SCROLL_DIR] = BOUNDARY_ZERO
  w.set([LIST_AT & 0xff, LIST_AT >> 8, WRAM_BANK], SPRITE_DATA_PTR)
  w[LIST_AT + 4] = LIST_END // the list is: a header byte, then y, x and id, then the end mark
  const seeded = w.slice()
  const seen: { row: Row | null } = { row: null }
  bus.onWramWrite = (off, value) => {
    const cls = classOfCell(off)
    if (!cls) return
    seen.row = { cls, value }
    throw new Refusal('decided') // the class is known at the first write; what follows is not run
  }
  cache.track(bus, rom)
  const rows: Row[] = []
  let problem: string | null = null
  for (let id = 0; id < 256 && !problem; id++) {
    w.set(seeded)
    w[LIST_AT + 3] = id
    seen.row = null
    const r = callSubroutine(cpu, entry, {
      kind: 'jsr',
      maxSteps: STEP_CAP,
      regs: { db: ENTRY_DB },
    })
    if (seen.row) rows.push(seen.row)
    else if (returned(r, cpu)) rows.push({ cls: 'normal', value: 0 })
    else problem = `id $${id.toString(16).toUpperCase().padStart(2, '0')}: ${whyNot(r)}`
  }
  problem ??= bandsProblem(rows)
  const classes = rows.map(r => r.cls)
  const result: LoadClasses = problem
    ? fail(problem)
    : { status: 'ok', of: id => classes[id] ?? 'normal' }
  return cache.store(rom, key, bus, result)
}
