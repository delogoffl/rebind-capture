/**
 * The Markdown report.
 *
 * Front matter first, because in an evidence document the front matter *is*
 * evidence: what was captured, when, on what machine, at what resolution, and
 * how much of it was edited. A reviewer who cannot answer those from the file
 * has to take the pictures on trust.
 *
 * `redactions` and `annotations` are counted rather than omitted. A reviewer
 * needs to know that something was drawn over an image even when they cannot
 * see what — a report that quietly looks identical whether or not a region was
 * blacked out is worse than one that says so.
 */

const pad = (n) => String(n).padStart(3, '0')

/** JSON quoting is also valid YAML quoting, and it escapes what needs it. */
const yaml = (value) => JSON.stringify(value ?? '')

const fmtDuration = (ms) => {
  const total = Math.round((ms || 0) / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function frontMatter(session, steps, { machine = {} } = {}) {
  const redactions = steps.reduce(
    (n, s) => n + (s.annotations || []).filter((a) => a.type === 'redact').length, 0)
  const annotations = steps.reduce((n, s) => n + (s.annotations || []).length, 0)

  const lines = ['---']
  lines.push(`session: ${yaml(session?.name || 'session')}`)
  if (session?.label) lines.push(`label: ${yaml(session.label)}`)
  lines.push(`captured_at: ${yaml(new Date(session?.startedAt || Date.now()).toISOString())}`)
  lines.push(`generated_at: ${yaml(new Date().toISOString())}`)
  lines.push(`tool: ${yaml('Rebind Capture')}`)
  if (machine.platform) lines.push(`platform: ${yaml(machine.platform)}`)
  if (machine.release) lines.push(`os_release: ${yaml(machine.release)}`)
  if (machine.display) lines.push(`display: ${yaml(machine.display)}`)
  if (machine.scale) lines.push(`scale_factor: ${machine.scale}`)
  lines.push(`steps: ${steps.length}`)
  lines.push(`annotations: ${annotations}`)
  lines.push(`redactions: ${redactions}`)
  lines.push('---')
  return lines
}

export function markdown(session, steps, options = {}) {
  const { includeMeta = true, machine = {}, media = [] } = options
  const lines = []

  if (includeMeta) {
    lines.push(...frontMatter(session, steps, { machine }))
    lines.push('')
  }

  lines.push(`# ${session?.label || session?.name || 'Rebind Capture session'}`)
  lines.push('')

  if (session?.notes) {
    lines.push(session.notes.trim())
    lines.push('')
  }

  if (media.length) {
    lines.push('## Recordings')
    lines.push('')
    for (const item of media) {
      const facts = [
        fmtDuration(item.durationMs),
        (item.container || 'webm').toUpperCase(),
        item.width ? `${item.width}×${item.height}` : null
      ].filter(Boolean).join(' · ')
      lines.push(`- \`${item.file}\` — ${facts}`)
    }
    lines.push('')
  }

  if (steps.length) {
    lines.push('## Steps')
    lines.push('')
  }

  for (const step of steps) {
    lines.push(`### ${step.index}. ${step.title || 'Step'}`)
    lines.push('')
    lines.push(`![Step ${step.index}](steps/step-${pad(step.index)}.png)`)
    lines.push('')

    if (includeMeta) {
      const facts = [
        step.source?.name ? `${step.source.name}` : null,
        step.capturedAt ? new Date(step.capturedAt).toISOString() : null,
        step.width ? `${step.width}×${step.height}` : null,
        step.mode ? `${step.mode} capture` : null
      ].filter(Boolean)
      // A count, not a list: the reader needs to know the image was drawn on,
      // and what was drawn is in the image.
      const redacted = (step.annotations || []).filter((a) => a.type === 'redact').length
      if (redacted) facts.push(`${redacted} redaction${redacted === 1 ? '' : 's'}`)
      if (facts.length) {
        lines.push(`<sub>${facts.join(' · ')}</sub>`)
        lines.push('')
      }
    }
  }

  return `${lines.join('\n')}\n`
}
