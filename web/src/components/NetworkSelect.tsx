type NetOpt = { id: string; name: string }

/**
 * Contextual network picker. A dropdown only earns its place when switching
 * actually changes the result — i.e. when there's more than one eligible
 * network. With a single option (or none) the choice is inert, so we render the
 * network as a static label instead of a dead dropdown. Callers pass an
 * already-filtered list (each feature decides its own eligibility — e.g.
 * EVM-only, or excluding holdings-only chains), and this component decides
 * whether that list deserves a `<select>` at all.
 */
export default function NetworkSelect({
  value,
  onChange,
  networks,
  className = 'input',
  label = 'Network',
}: {
  value: string
  onChange: (id: string) => void
  networks: NetOpt[]
  className?: string
  label?: string
}) {
  if (networks.length <= 1) {
    const only = networks.find((n) => n.id === value) ?? networks[0]
    return (
      <span
        className={`${className} inline-flex cursor-default items-center !text-slate-300`}
        title={`${label}: only one network available`}
        aria-label={label}
      >
        {only?.name ?? '—'}
      </span>
    )
  }
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {networks.map((n) => (
        <option key={n.id} value={n.id}>
          {n.name}
        </option>
      ))}
    </select>
  )
}
