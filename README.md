# Co-Parenting

A [Chickadee Bandit](https://chickadeebandit.com/app-library/co-parenting) app.

Shared custody coordination for split households — per-child standing schedules (alternating weeks, 2-2-3, alternating weekends, 2-2-5-5, 3-4-4-3, or your own cycle) that take effect only when both parents countersign once both have joined (one set up before the other parent joins is in force on one signature and recorded that way), countersigned one-off swaps whose terms are frozen server-side at approval, and handoff notes. Every agreed version is kept; custody days are worked out on the server from what was agreed and flow to the household Calendar, so kids always know where they are.

## Features

- Per-child standing schedules, countersigned by both parents before they apply once both have joined; one set up earlier is recorded as signed by one parent.
- Countersigned one-off swaps.
- Every agreed version is kept.
- Handoff notes.
- Messages between the parents are the space's own Messages. The app links to the conversation and includes it in the full record. In a co-parenting space those messages cannot be edited or deleted.
- A countersigned holiday schedule: rules such as "Thanksgiving, even years with one parent, odd years with the other" agreed once and applied every year, above the rotation and beneath any countersigned swap.
- Check-ins at the exchange: each parent taps "I'm here" and the hub's own time goes on the record, beside the agreed time. Children who change homes together are one exchange, recorded together or not at all.
- A custody journal: each parent records whether an exchange happened as planned, late or not at all, and where a child actually was. Entries are never edited; the other parent acknowledges or disputes with an entry of their own.
- Records: every report opens as a stamped document, separately or as one full record.
- Custody days flow to the shared calendar and Today view.

## Install

In your hub, go to **Apps → Install from URL** and paste:

```
https://github.com/firebirdsystems/chickadeebandit-co-parenting/releases/latest/download/bundle.json
```

## Development

See the [app-template](https://github.com/firebirdsystems/chickadeebandit-app-template) for build instructions and the full manifest field reference.
