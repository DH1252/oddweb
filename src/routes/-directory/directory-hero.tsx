import { FieldLabel, fieldClass } from '../../components/oddweb'

export function DirectoryHero({
  query,
  maxLength,
  onQueryChange,
}: {
  query: string
  maxLength: number
  onQueryChange: (query: string) => void
}) {
  return (
    <section
      className="odd-shell mt-3 border border-ink bg-paper p-3"
      data-od-id="hero-section"
    >
      <div className="grid items-stretch gap-3 md:grid-cols-[1.35fr_.65fr]">
        <div className="border border-ink bg-rust px-4 py-3 text-white">
          <p className="mb-1 font-mono text-xs font-bold tracking-[0.08em] uppercase">
            Public & Crowdsourced • No Algorithms
          </p>
          <h1 className="mb-1 font-mono text-[clamp(29px,5vw,44px)] leading-none font-bold tracking-[-0.04em]">
            Oddweb Directory
          </h1>
          <p className="m-0 max-w-2xl leading-relaxed">
            A public, community-curated directory of one-of-a-kind websites made
            to surprise, delight, teach, distract, or simply do something
            different.
          </p>
        </div>
        <div
          className="border border-dotted border-brown bg-canvas p-2.5"
          data-od-id="search-control"
        >
          <FieldLabel htmlFor="search">Find a site</FieldLabel>
          <input
            id="search"
            type="search"
            value={query}
            maxLength={maxLength}
            onChange={(event) => onQueryChange(event.target.value)}
            className={fieldClass}
            autoComplete="off"
            placeholder="What do you feel like finding?"
            data-od-id="search-input"
          />
        </div>
      </div>
    </section>
  )
}
