# Job Scout

A personal, proactive agent that finds job offers matching its owner every morning and delivers the best ones over Telegram.

## Language

**Job Scout**:
The agent this repo builds; it runs on a daily schedule without being asked.
_Avoid_: bot, assistant

**Digest**:
The daily message listing the top-ranked offers, each with buttons for the owner to respond to.
_Avoid_: report, summary, newsletter

**Scouting Run**:
One day's search, made of one or more batches, ending in a digest.
_Avoid_: job, execution, cycle

**Batch**:
One round within a scouting run: fetch up to 50 new offers from a query, then score them.
_Avoid_: page, chunk, round

**Offer**:
A single job posting from a source, with its title, company, link, salary, location and work mode.
_Avoid_: job, posting, listing, vacancy

**Work Mode**:
Whether an offer is on-site, hybrid or remote.
_Avoid_: modality, presence

**Fit Score**:
How well an offer matches the owner, as judged by the scoring model.
_Avoid_: rank, match, compatibility

**Accept**:
The owner's ✅ on an offer in the digest, meaning "I want to apply to this one".
_Avoid_: approve, like, pick

**Shortlist**:
The accepted offers not yet exported, delivered as one plain-text block the owner hands to their application workflow.
_Avoid_: export, list, favorites

**Dismiss**:
The owner's ❌ on an offer in the digest.
_Avoid_: reject (reserved for an employer turning the owner down)
