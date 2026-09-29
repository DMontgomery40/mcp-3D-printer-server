// Geometry for one layer of a small charm tag, drawn like a slicer preview:
// an outer wall, two inner walls, and diagonal sparse infill. Shared by the
// home hero (HomePreview.vue) and the social card (scripts/social-card.mjs).

export const VIEWBOX = { width: 400, height: 280 }

const roundedRect = (x, y, w, h, r) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}` +
  `A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}` +
  `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`

const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`

const tag = { x: 64, y: 54, w: 272, h: 172, r: 44 }
const hole = { cx: 116, cy: 140, r: 18 }
const wall = 6

const shell = (inset) => roundedRect(tag.x + inset, tag.y + inset, tag.w - 2 * inset, tag.h - 2 * inset, tag.r - inset)
const ring = (inset) => circle(hole.cx, hole.cy, hole.r + inset)

/** Wall loops, outermost first, with draw timing for the hero animation. */
export const walls = [
  { key: 'outer', color: 'var(--tp-outer)', paths: [shell(0), ring(0)], delay: 0.2, duration: 1.1 },
  { key: 'inner-1', color: 'var(--tp-inner)', paths: [shell(wall), ring(wall)], delay: 1.1, duration: 0.8 },
  { key: 'inner-2', color: 'var(--tp-inner)', paths: [shell(wall * 2), ring(wall * 2)], delay: 1.7, duration: 0.8 },
]

const infillInset = wall * 3

/** Region the infill is clipped to: inside the innermost wall, outside the hole. */
export const infillClip = `${shell(infillInset)} ${ring(infillInset)}`

/** Diagonal infill lines, alternating direction like a real toolpath. */
export const infill = (() => {
  const top = tag.y + infillInset
  const bottom = tag.y + tag.h - infillInset
  const span = bottom - top
  const lines = []
  for (let a = tag.x + infillInset - span, i = 0; a < tag.x + tag.w - infillInset; a += 11, i += 1) {
    const start = `${a} ${bottom}`
    const end = `${a + span} ${top}`
    lines.push({ d: i % 2 ? `M${end}L${start}` : `M${start}L${end}`, delay: 2.3 + i * 0.03 })
  }
  return lines
})()
