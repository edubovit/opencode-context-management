import { hash, select, type Block } from "./context.ts"

export type Range = { start: number; end: number }
export type Selection = { ranges: Range[]; anchor?: number }

export function liveRange(anchor: number, cursor: number): Range {
  return { start: Math.min(anchor, cursor), end: Math.max(anchor, cursor) }
}

export function visibleRanges(selection: Selection, cursor: number) {
  return [...selection.ranges, ...(selection.anchor === undefined ? [] : [liveRange(selection.anchor, cursor)])]
}

export function rangeTag(selection: Selection, cursor: number, index: number) {
  const closed = selection.ranges.findIndex((range) => index >= range.start && index <= range.end)
  if (closed >= 0) return `R${closed + 1}`
  if (selection.anchor !== undefined) {
    const open = liveRange(selection.anchor, cursor)
    if (index >= open.start && index <= open.end) return `R${selection.ranges.length + 1}*`
  }
  return undefined
}

export function selectedBlocks(blocks: Block[], ranges: Range[]) {
  return blocks.filter((_block, index) => ranges.some((range) => index >= range.start && index <= range.end))
}

export function pressSpace(selection: Selection, cursor: number, blocks: Block[]): Selection {
  if (selection.anchor !== undefined) {
    const range = liveRange(selection.anchor, cursor)
    select(blocks, range.start, range.end)
    if (selection.ranges.some((other) => range.start <= other.end && other.start <= range.end))
      throw new Error("Ranges cannot overlap. Move the endpoint or press Esc to cancel this open range.")
    return { ranges: [...selection.ranges, range].sort((a, b) => a.start - b.start) }
  }
  const existing = selection.ranges.findIndex((range) => cursor >= range.start && cursor <= range.end)
  if (existing >= 0) return { ranges: selection.ranges.filter((_range, index) => index !== existing) }
  select(blocks, cursor, cursor)
  return { ...selection, anchor: cursor }
}

export function rangeIDs(blocks: Block[], selection: Selection) {
  if (selection.anchor !== undefined) throw new Error("Press Space to close the open range before running an action")
  if (!selection.ranges.length) throw new Error("Use Space to start and finish at least one range")
  return selection.ranges.map((range) => select(blocks, range.start, range.end).flatMap((block) => block.sourceIDs))
}

export function resolveRanges(blocks: Block[], ranges: string[][]) {
  if (!ranges.length) throw new Error("Select at least one range")
  const occupied = new Set<string>()
  return ranges.map((ids) => {
    const start = blocks.findIndex((block) => block.sourceIDs[0] === ids[0])
    const end = blocks.findIndex((block) => block.sourceIDs.at(-1) === ids.at(-1))
    const chosen = select(blocks, start, end)
    if (hash(chosen.flatMap((block) => block.sourceIDs)) !== hash(ids)) throw new Error("Selection changed; refresh and select again")
    for (const id of ids) {
      if (occupied.has(id)) throw new Error("Selected ranges overlap")
      occupied.add(id)
    }
    return { start, chosen }
  }).sort((a, b) => a.start - b.start).map((range) => range.chosen)
}

export function anchorRanges(blocks: Block[], ranges: string[][]): Selection {
  return { ranges: ranges.flatMap((ids) => {
    const start = blocks.findIndex((block) => block.sourceIDs[0] === ids[0])
    const end = blocks.findIndex((block) => block.sourceIDs.at(-1) === ids.at(-1))
    return start >= 0 && end >= start ? [{ start, end }] : []
  }) }
}
